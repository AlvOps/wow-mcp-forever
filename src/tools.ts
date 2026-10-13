import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HttpError, type WowheadClient } from './wowhead/client.js';
import { type PageInfo, summarizeRow } from './wowhead/parse.js';
import { ENTITY_TYPE_NAMES, type EntityType, typeByName } from './wowhead/types.js';
import { logger } from './util/logger.js';

const typeSchema = z
  .enum(ENTITY_TYPE_NAMES)
  .describe('What kind of thing: item, quest, npc, spell, object, zone, faction, itemset, achievement, ...');

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const };
}

function describeError(err: unknown): string {
  if (err instanceof HttpError && err.status === 404) return `Not found on Wowhead (${err.url})`;
  if (err instanceof HttpError && err.status === 403)
    return `Wowhead refused the request (${err.url}). It may be rate-limiting or blocking this server's IP.`;
  return err instanceof Error ? err.message : String(err);
}

function resolveType(name: string): EntityType {
  const t = typeByName(name);
  if (!t) throw new Error(`Unknown type "${name}". Use one of: ${ENTITY_TYPE_NAMES.join(', ')}`);
  return t;
}

const ROW_NOTE = 'Rows keep the raw numeric `location` ids and add `locations` with the area names taken from Wowhead.';

/**
 * Shape a parsed page for the model: compact rows, capped per table.
 *
 * Row `location` values are numeric area ids, and a model handed bare ids will
 * supply the zone names from its own knowledge — which reads as authoritative
 * but does not come from the data source. So every id used on the page is
 * resolved against Wowhead's own area-name table and added as `locations`.
 */
async function shapePage(
  info: PageInfo,
  url: string,
  opts: { sections?: string[]; maxRows: number },
  client: WowheadClient,
) {
  const wanted = opts.sections?.map((s) => s.toLowerCase());
  const prepared = info.listviews
    .filter((lv) => !wanted || wanted.some((w) => lv.id.toLowerCase().includes(w)))
    .map((lv) => ({
      lv,
      rows: lv.rows.slice(0, opts.maxRows).map((r) => summarizeRow(r, lv.template)),
    }));

  const ids = new Set<number>();
  for (const { rows } of prepared) {
    for (const row of rows) {
      const loc = row['location'];
      if (Array.isArray(loc)) for (const id of loc) if (typeof id === 'number') ids.add(id);
    }
  }

  if (ids.size > 0) {
    const names = await client.areaNames();
    if (names.size > 0) {
      for (const { rows } of prepared) {
        for (const row of rows) {
          const loc = row['location'];
          if (!Array.isArray(loc)) continue;
          const resolved = loc.map((id) => (typeof id === 'number' ? names.get(id) : undefined)).filter(Boolean);
          if (resolved.length > 0) row['locations'] = resolved;
        }
      }
    }
  }

  return {
    url,
    title: info.title,
    description: info.description,
    quickFacts: info.quickFacts,
    text: info.text,
    note: ROW_NOTE,
    tables: prepared.map(({ lv, rows }) => ({ table: lv.id, total: lv.rows.length, rows })),
    availableTables: info.listviews.map((lv) => `${lv.id} (${lv.rows.length})`),
  };
}

export function registerTools(server: McpServer, client: WowheadClient): void {
  // ── Search ──────────────────────────────────────────
  server.registerTool(
    'forever_search',
    {
      title: 'Search WoW: Forever',
      description:
        'Search the Wowhead World of Warcraft: Forever database by name. Returns matching items, quests, NPCs, spells, zones, etc. with their ids. Use the ids with forever_lookup or forever_details.',
      inputSchema: {
        query: z.string().min(2).describe('Name or partial name, e.g. "Defender of Dalaran" or "Hogger"'),
        type: typeSchema.optional().describe('Only return this kind of result'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
      },
    },
    async ({ query, type, limit }) => {
      try {
        const results = await client.search(query, { type: type ? resolveType(type) : undefined, limit });
        if (results.length === 0) return ok({ query, results: [], note: 'No matches on Wowhead Forever.' });
        return ok({ query, results });
      } catch (err) {
        logger.error({ err }, 'forever_search failed');
        return fail(describeError(err));
      }
    },
  );

  // ── Lookup (tooltip + item stats) ───────────────────
  server.registerTool(
    'forever_lookup',
    {
      title: 'WoW: Forever quick lookup',
      description:
        'Get the tooltip summary for one WoW: Forever entity by type and id: name, quality, stats, level, requirements, effects. For items it also returns slot, item level and crafting reagents.',
      inputSchema: {
        type: typeSchema,
        id: z.number().int().positive().describe('Wowhead id from forever_search'),
      },
    },
    async ({ type, id }) => {
      try {
        const t = resolveType(type);
        const [tooltip, item] = await Promise.all([
          client.tooltip(t, id),
          t.name === 'item' ? client.itemXml(id) : Promise.resolve(undefined),
        ]);
        if (!tooltip && !item) {
          // Fall back to the full page so the model still gets something useful.
          const page = await client.page(t, id);
          return ok(await shapePage(page, client.pageUrl(t.path, id), { maxRows: 10 }, client));
        }
        return ok({ type: t.name, id, url: client.pageUrl(t.path, id), ...tooltip, ...(item ? { item } : {}) });
      } catch (err) {
        logger.error({ err }, 'forever_lookup failed');
        return fail(describeError(err));
      }
    },
  );

  // ── Details (full page tables) ──────────────────────
  server.registerTool(
    'forever_details',
    {
      title: 'WoW: Forever full details',
      description:
        'Read the full Wowhead Forever page for an entity: quick facts, description/objectives, and data tables such as dropped-by (with drop chance), drops, sold-by, starts/ends quest, objective-of, reward-from, created-by, reagent-for, teaches, quests in a zone. Use `sections` to only return certain tables. Rows carry numeric `location` ids plus `locations` area names.',
      inputSchema: {
        type: typeSchema,
        id: z.number().int().positive().describe('Wowhead id from forever_search'),
        sections: z
          .array(z.string())
          .optional()
          .describe('Only include tables whose id contains one of these, e.g. ["dropped-by","sold-by"]'),
        maxRows: z.number().int().min(1).max(200).optional().describe('Max rows per table (default 25)'),
      },
    },
    async ({ type, id, sections, maxRows }) => {
      try {
        const t = resolveType(type);
        const page = await client.page(t, id);
        return ok(await shapePage(page, client.pageUrl(t.path, id), { sections, maxRows: maxRows ?? 25 }, client));
      } catch (err) {
        logger.error({ err }, 'forever_details failed');
        return fail(describeError(err));
      }
    },
  );

  // ── Find (search + details in one call) ─────────────
  server.registerTool(
    'forever_find',
    {
      title: 'Find in WoW: Forever',
      description:
        'One-step answer for questions like "where does X drop", "who sells X", "how do I start quest X": searches WoW: Forever by name, then returns full details of the best match plus the other candidates. Rows carry numeric `location` ids plus `locations` area names.',
      inputSchema: {
        name: z.string().min(2).describe('Name of the item, quest, NPC, zone, ...'),
        type: typeSchema.optional().describe('Restrict to this kind of thing (recommended)'),
        maxRows: z.number().int().min(1).max(200).optional().describe('Max rows per table (default 15)'),
      },
    },
    async ({ name, type, maxRows }) => {
      try {
        const results = await client.search(name, { type: type ? resolveType(type) : undefined, limit: 8 });
        if (results.length === 0) return ok({ query: name, note: 'No matches on Wowhead Forever.' });
        const exact = results.find((r) => r.name.toLowerCase() === name.toLowerCase());
        const best = exact ?? results[0]!;
        const t = resolveType(best.type);
        const page = await client.page(t, best.id);
        return ok({
          match: { type: best.type, id: best.id, name: best.name },
          ...(await shapePage(page, best.url, { maxRows: maxRows ?? 15 }, client)),
          otherMatches: results.filter((r) => r !== best),
        });
      } catch (err) {
        logger.error({ err }, 'forever_find failed');
        return fail(describeError(err));
      }
    },
  );
}
