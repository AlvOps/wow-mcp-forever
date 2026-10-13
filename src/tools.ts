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
  if (err instanceof HttpError) {
    if (err.status === 404) return `Not found on Wowhead (${err.url})`;
    if (err.status === 403) {
      return `${err.reason ?? 'Wowhead refused the request'} (${err.url}). Either the WAF token was rejected or the request did not look like a browser — the server already re-minted the token once.`;
    }
    if (err.status === 202) {
      return `${err.reason ?? 'Wowhead served the AWS WAF challenge'} (${err.url}). The token was re-minted once without clearing it; Chromium may be missing — check that the browser is installed.`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function resolveType(name: string): EntityType {
  const t = typeByName(name);
  if (!t) throw new Error(`Unknown type "${name}". Use one of: ${ENTITY_TYPE_NAMES.join(', ')}`);
  return t;
}

/**
 * Tables that only ever dilute an answer: transmog/outfit noise, comment and
 * media stubs. They stay visible in `availableTables` and are returned when
 * explicitly asked for through `sections`.
 */
const NOISE_TABLES = /^(outfits|transmog|comments|screenshots|videos|guides|see-also|same-model-as|related|external)/;

/** Tables whose rows carry a `dropChance` and should be ordered by it. */
const DROP_TABLES = /^(dropped-by|pick-pocketed-from|skinned-from|mined-from-|contained-in-|salvaged-from|prospected-from|disenchanted-from|reward-from|drops)/;

/**
 * Order a drop table so a well-sampled rate outranks a fluke.
 * Without this, "100% of 6 kills" arrives looking exactly as solid as a real
 * drop rate, and the server's core question ("where does X drop") goes wrong.
 */
function orderByDropChance(rows: Record<string, unknown>[], minSamples: number): Record<string, unknown>[] {
  const chance = (r: Record<string, unknown>) => parseFloat(String(r['dropChance'] ?? '')) || 0;
  const solid = (r: Record<string, unknown>) => typeof r['samples'] === 'number' && r['samples'] >= minSamples;
  return [...rows].sort((a, b) => {
    const sa = solid(a) ? 0 : 1;
    const sb = solid(b) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return chance(b) - chance(a);
  });
}

/**
 * Shape a parsed page for the model: compact rows, capped per table.
 *
 * Three deliberate transformations, all disclosed in `note`:
 * - `location` ids are joined by Wowhead-sourced `locations` names, because a
 *   model handed bare ids invents the zone names;
 * - drop tables are ordered by drop chance (well-sampled rows first) BEFORE the
 *   row cap, so the best sources survive truncation;
 * - noise tables are omitted unless requested.
 */
export async function shapePage(
  info: PageInfo,
  url: string,
  opts: { sections?: string[]; maxRows: number },
  client: WowheadClient,
) {
  const wanted = opts.sections?.map((s) => s.toLowerCase());
  const minSamples = client.dropMinSamples;

  const prepared = info.listviews
    .filter((lv) => {
      const id = lv.id.toLowerCase();
      // An explicit `sections` request is honoured verbatim.
      if (wanted) return wanted.some((w) => id.includes(w));
      if (lv.rows.length === 0) return false;
      return !NOISE_TABLES.test(id);
    })
    .map((lv) => {
      let rows = lv.rows.map((r) => summarizeRow(r, lv.template));
      const sorted = DROP_TABLES.test(lv.id.toLowerCase()) && rows.some((r) => r['dropChance'] !== undefined);
      if (sorted) rows = orderByDropChance(rows, minSamples);
      return { lv, rows, sorted };
    });

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

  const tables = prepared.map(({ lv, rows, sorted }) => ({
    table: lv.id,
    rowsOnPage: lv.rows.length,
    ...(sorted ? { sortedBy: `dropChance desc, rows below ${minSamples} samples last` } : {}),
    rows: rows.slice(0, opts.maxRows),
  }));

  return {
    url,
    title: info.title,
    description: info.description,
    quickFacts: info.quickFacts,
    text: info.text,
    note:
      '`locations` are area names taken from Wowhead, alongside the raw numeric `location` ids. ' +
      `Drop tables report \`dropChance\` with the \`samples\` it is based on, and are ordered by drop chance with rows below ${minSamples} samples last. ` +
      'Transmog/comment/media tables are omitted; see `availableTables` and pass `sections` to get one.',
    tables,
    availableTables: info.listviews.map((lv) => `${lv.id} (${lv.rows.length})`),
    source: sourceOf(url),
  };
}

/** Where the answer came from — always the last field, so it is easy to cite. */
function sourceOf(url: string, label = 'Wowhead: WoW Forever') {
  return { label, url };
}

/** Types preferred when a bare name matches several entities. */
const PREFERRED_TYPES = ['item', 'npc', 'quest', 'object', 'zone', 'spell'];

export function registerTools(server: McpServer, client: WowheadClient): void {
  // ── Search ──────────────────────────────────────────
  server.registerTool(
    'forever_search',
    {
      title: 'Search WoW: Forever',
      description:
        'Search the Wowhead World of Warcraft: Forever database by name. Returns matching items, quests, NPCs, spells, zones, etc. with their ids and Wowhead links. Use the ids with forever_lookup or forever_details.',
      inputSchema: {
        query: z.string().min(2).describe('Name or partial name, e.g. "Defender of Dalaran" or "Hogger"'),
        type: typeSchema.optional().describe('Only return this kind of result'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
      },
    },
    async ({ query, type, limit }) => {
      try {
        const results = await client.search(query, { type: type ? resolveType(type) : undefined, limit });
        if (results.length === 0) {
          return ok({
            query,
            results: [],
            note: 'No matches on Wowhead Forever.',
            source: sourceOf(client.searchUrl(query), 'Wowhead: WoW Forever search'),
          });
        }
        return ok({ query, results, source: sourceOf(client.searchUrl(query), 'Wowhead: WoW Forever search') });
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
        return ok({
          type: t.name,
          id,
          url: client.pageUrl(t.path, id),
          ...tooltip,
          ...(item ? { item } : {}),
          source: sourceOf(client.pageUrl(t.path, id)),
        });
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
        'Read the full Wowhead Forever page for an entity: quick facts, description/objectives, and data tables such as dropped-by (with drop chance and sample size), sold-by, starts/ends quest, objective-of, reward-from, created-by, reagent-for, teaches, quests in a zone. Rows carry numeric `location` ids plus `locations` area names, and drop tables are ordered by drop chance. Use `sections` to restrict — or to reach a table that is hidden by default (transmog, comments, media).',
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
        'One-step answer for questions like "where does X drop", "who sells X", "how do I start quest X": searches WoW: Forever by name, then returns full details of the best match plus the other candidates. Rows carry numeric `location` ids plus `locations` area names; drop tables are ordered by drop chance and report sample sizes, so low-sample flukes are not presented as solid rates.',
      inputSchema: {
        name: z.string().min(2).describe('Name of the item, quest, NPC, zone, ...'),
        type: typeSchema.optional().describe('Restrict to this kind of thing (recommended)'),
        maxRows: z.number().int().min(1).max(200).optional().describe('Max rows per table (default 15)'),
      },
    },
    async ({ name, type, maxRows }) => {
      try {
        const results = await client.search(name, { type: type ? resolveType(type) : undefined, limit: 8 });
        if (results.length === 0) {
          return ok({
            query: name,
            note: 'No matches on Wowhead Forever.',
            source: sourceOf(client.searchUrl(name), 'Wowhead: WoW Forever search'),
          });
        }
        // A bare name can match several entity types (an item and a spell called
        // the same thing). Prefer the kinds a player is usually asking about, and
        // say plainly when the name was ambiguous.
        const exactMatches = results.filter((r) => r.name.toLowerCase() === name.toLowerCase());
        const best =
          exactMatches.find((r) => PREFERRED_TYPES.includes(r.type)) ?? exactMatches[0] ?? results[0]!;
        const collisions = exactMatches.filter((r) => r !== best);
        const t = resolveType(best.type);
        const page = await client.page(t, best.id);
        return ok({
          match: { type: best.type, id: best.id, name: best.name },
          ...(collisions.length > 0 ? { nameCollisions: collisions } : {}),
          otherMatches: results.filter((r) => r !== best),
          // shapePage ends with `source`, so it stays the final field — the link
          // to where the answer came from is always the last thing in the reply.
          ...(await shapePage(page, best.url, { maxRows: maxRows ?? 15 }, client)),
        });
      } catch (err) {
        logger.error({ err }, 'forever_find failed');
        return fail(describeError(err));
      }
    },
  );
}
