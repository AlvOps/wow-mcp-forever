import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HttpError, type WowheadClient } from './wowhead/client.js';
import { type PageInfo, type SearchResult, summarizeRow } from './wowhead/parse.js';
import {
  DESCRIPTION_GUIDANCE,
  finish,
  presentMatch,
  presentRow,
  resolveFacts,
  resolveText,
  rowRefs,
  tableTitle,
  textRefs,
} from './present.js';
import { ENTITY_TYPE_NAMES, type EntityType, typeByName } from './wowhead/types.js';
import { BROWSE_DEFAULT_ROWS, BROWSE_MAX_ROWS, shapeBrowse } from './browse.js';
import { DEAD_PATHS, LISTING_SPECS, normalizeBrowsePath, specForPath } from './wowhead/listing.js';
import { logger } from './util/logger.js';

const typeSchema = z
  .enum(ENTITY_TYPE_NAMES)
  .describe('What kind of thing: item, quest, npc, spell, object, zone, faction, itemset, achievement, ...');

function ok(data: unknown) {
  // Compact JSON: indentation roughly doubled the payload the model must read.
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
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
 * media stubs, and lists that rarely answer a player's question (shared
 * cooldowns, achievement criteria, see-also). They stay visible in
 * `availableTables` and are returned when explicitly asked for through `sections`.
 */
const NOISE_TABLES =
  /^(outfits|transmog|comments|screenshots|videos|guides|see-also|same-model-as|related|external|shared-cooldown|criteria-of)/;

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
 * Shape a parsed page for the model: user-facing rows, capped per table.
 *
 * - every id a row or text references (reagents, quest rewards, created
 *   items, `[npc=…]` markup) is resolved to a Wowhead-sourced name — first
 *   from the page's own embedded name data, then from the tooltip service;
 * - numeric `location` ids become one `zone` string of Wowhead area names;
 * - internal fields (react, classification, type, skill, colors, …) are dropped;
 * - drop tables are ordered by drop chance (well-sampled rows first) BEFORE the
 *   row cap, so the best sources survive truncation;
 * - noise tables are omitted unless requested.
 */
export async function shapePage(
  info: PageInfo,
  url: string,
  opts: { sections?: string[]; maxRows: number; minChance?: number; minSamples?: number },
  client: WowheadClient,
) {
  const wanted = opts.sections?.map((s) => s.toLowerCase());
  // Server-side filters over rows we already hold — no extra fetch. They trim what
  // the answering model has to read, which is what makes an answer fast and tight.
  const floorSamples = opts.minSamples ?? 0;
  const floorChance = opts.minChance ?? 0;

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
      const isDrop = DROP_TABLES.test(lv.id.toLowerCase()) && rows.some((r) => r['dropChance'] !== undefined);
      if (isDrop) rows = orderByDropChance(rows, client.dropMinSamples);

      const before = rows.length;
      // Filters apply only to drop tables, where chance/samples mean something.
      if (isDrop && (floorChance > 0 || floorSamples > 0)) {
        rows = rows.filter((r) => {
          const chance = parseChance(r['dropChance']);
          const samples = typeof r['samples'] === 'number' ? r['samples'] : 0;
          if (floorChance > 0 && (chance === undefined || chance < floorChance)) return false;
          if (floorSamples > 0 && samples < floorSamples) return false;
          return true;
        });
      }
      // A floor that empties a table must be visible: an empty table looks like
      // "no drop sources" rather than "your filter removed them all".
      const emptied = before > 0 && rows.length === 0 && (floorChance > 0 || floorSamples > 0);
      // Cap before naming, so only rows that are actually returned cost a lookup.
      return {
        lv,
        rows: rows.slice(0, opts.maxRows),
        isDrop,
        filteredOut: before - rows.length,
        emptied,
      };
    });

  // Name every id-bearing reference: the page's own name data first, then tooltips.
  client.rememberNames(info.names);
  const names = new Map<string, string>(Object.entries(info.names ?? {}));
  const refs = [
    ...prepared.flatMap(({ rows }) => rows.flatMap(rowRefs)),
    ...textRefs(info.quickFacts),
    ...textRefs(info.text),
  ].filter(([t, id]) => !names.has(`${t}:${id}`));
  if (refs.length > 0) for (const [k, v] of await client.entityNames(refs)) names.set(k, v);

  const globals = await client.globalNames();
  const ctx = { globals, names, pageUrl: (path: string, id: number) => client.pageUrl(path, id) };

  const tables = prepared.map(({ lv, rows, isDrop, filteredOut, emptied }) => ({
    table: lv.id,
    title: tableTitle(lv.id),
    rowsOnPage: lv.rows.length,
    ...(isDrop ? { sortedBy: `dropChance desc, rows below ${client.dropMinSamples} samples last` } : {}),
    ...(filteredOut > 0 ? { rowsFilteredOut: filteredOut } : {}),
    ...(emptied
      ? {
          emptyBecauseOfFilter: true,
          filterNote: `All ${lv.rows.length} rows of "${lv.id}" fell below your minChance/minSamples floor — this table DOES have rows, they were filtered out. Re-run without the floor (or lower it) to see them.`,
        }
      : {}),
    rows: rows.map((r) => presentRow(r, lv.template, ctx)),
  }));

  const quickFacts = resolveFacts(info.quickFacts, names);
  const text = resolveText(info.text, names);
  return finish(
    {
      url,
      title: info.title,
      ...(info.description ? { description: info.description } : {}),
      ...(quickFacts ? { quickFacts } : {}),
      ...(text ? { text } : {}),
      note:
        '`dropChance` comes with `samples` (how many kills/loots it is based on); drop tables list well-sampled rows first. ' +
        'Pass a table id from `availableTables` in `sections` to get more of it.',
      tables,
      availableTables: info.listviews.map((lv) => `${lv.id} (${lv.rows.length})`),
    },
    sourceOf(url),
  );
}

/**
 * "27.78%" / "0.5" → percent, for row filtering. Returns undefined when the row
 * has no usable chance, so an unparsable row is never silently kept by a floor.
 */
function parseChance(value: unknown): number | undefined {
  if (typeof value === 'number') return value <= 1 ? value * 100 : value;
  if (typeof value !== 'string') return undefined;
  const m = /([\d.]+)\s*%/.exec(value);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

/** Where the answer came from — always the last field, so it is easy to cite. */
function sourceOf(url: string, label = 'Wowhead: WoW Forever') {
  return { label, url };
}

/** Item fields from the item XML, reshaped for a player (names, no raw stat keys). */
async function presentItem(item: Record<string, unknown>, client: WowheadClient) {
  const out: Record<string, unknown> = {};
  for (const k of ['itemLevel', 'quality', 'class', 'subclass', 'slot', 'tooltip']) {
    if (item[k] !== undefined && item[k] !== '') out[k] = item[k];
  }
  const spell = item['createdBySpell'] as { id?: number; name?: string } | undefined;
  if (spell?.name) {
    out['createdBy'] = {
      name: spell.name,
      ...(spell.id ? { url: client.pageUrl('spell', spell.id) } : {}),
    };
  }
  const reagents = item['reagents'] as { id: number; name?: string; count: number }[] | undefined;
  if (reagents?.length) {
    const missing = reagents.filter((r) => !r.name).map((r) => [3, r.id] as [number, number]);
    const named = missing.length ? await client.entityNames(missing) : new Map<string, string>();
    const parts = reagents.map((r) => {
      const name = r.name || named.get(`3:${r.id}`);
      return name ? `${r.count || 1}x ${name}` : undefined;
    });
    out['reagents'] = parts.every(Boolean) ? parts.join(', ') : 'Not available from Wowhead; see the linked page.';
  }
  return out;
}

/** Types preferred when a bare name matches several entities. */
const PREFERRED_TYPES = ['item', 'npc', 'quest', 'object', 'zone', 'spell'];

/** forever_find rows per table: enough to answer, small enough not to drown the answer. */
const FIND_DEFAULT_ROWS = 5;

const numOrText = z.union([z.number(), z.string()]);
const whereSchema = z
  .record(
    z.string(),
    z.union([
      numOrText,
      z
        .object({ eq: numOrText, ne: numOrText, lt: numOrText, lte: numOrText, gt: numOrText, gte: numOrText })
        .partial(),
    ]),
  )
  .optional()
  .describe(
    'Local filter over the rows Wowhead returned, e.g. {"reqlevel":{"lte":20}}, {"dps":">=15"}, {"quality":"Rare"}. Fields: reqlevel, level (item level), dps, speed, damagemin, damagemax, armor, quality, stamina/strength/agility/intellect/spirit, minlevel/maxlevel, points.',
  );

const BROWSE_DESCRIPTION =
  'Enumerate a WHOLE WoW: Forever category in one call — for "best/all/which X" questions such as "best in slot level 20 sword", "all potions", "every item set", "NPCs level 10-12". ' +
  'Not for finding one thing by name (use forever_find / forever_search). ' +
  '`path` is the Wowhead listing path after /forever/: ' +
  'items, items/<class>, items/<class>/<subclass>[/<slot>] — classes: weapons (one-handed-swords, two-handed-swords, one-handed-axes, two-handed-axes, one-handed-maces, two-handed-maces, daggers, fist-weapons, polearms, staves, bows, guns, crossbows, wands, thrown), ' +
  'armor (cloth, leather, mail, plate, shields, cloaks, rings, amulets, trinkets; e.g. armor/cloth/chest), consumables (potions, elixirs, flasks, food-and-drinks, bandages, scrolls), trade-goods (herbs, cloth, leather, metal-and-stone, ...), recipes (alchemy, blacksmithing, ...), containers; ' +
  `also ${LISTING_SPECS.filter((s) => s.prefix !== 'items').map((s) => s.prefix).join(', ')}. ` +
  '`filters` are Wowhead path segments "name:value" applied BY WOWHEAD before the 1000-row cap, e.g. ["min-req-level:0","max-req-level:20"]; ' +
  'item pages accept min-req-level, max-req-level, min-level, max-level (item level), quality, slot, side, class; npcs accept min-level, max-level; other pages may ignore them, and the reply says so in `filtersNotApplied` — trust `filtersApplied`, never assume. ' +
  '`where` filters the returned rows locally (reported as `rowsFilteredOut`), `sort` orders by a numeric field ("dps desc", "reqlevel asc"), `limit` caps rows (default ' +
  `${BROWSE_DEFAULT_ROWS}, max ${BROWSE_MAX_ROWS}). ` +
  'Wowhead shows at most 1000 rows per page: when `truncated`/`possiblyTruncated` is set, rankings cover only those rows, so narrow with `filters`. Item rows carry dps, speed, damageMin/damageMax, armor, stats, requiredLevel, itemLevel, slot and where it comes from; items with no known source (NPC-only/placeholder gear) are hidden unless includeNoSource is true.' +
  DESCRIPTION_GUIDANCE;

export function registerTools(server: McpServer, client: WowheadClient): void {
  // ── Browse (category listing) ───────────────────────
  server.registerTool(
    'forever_browse',
    {
      title: 'Browse a WoW: Forever category',
      description: BROWSE_DESCRIPTION,
      inputSchema: {
        path: z
          .string()
          .min(2)
          .describe('Listing path after /forever/, e.g. "items/weapons/one-handed-swords", "item-sets", "npcs", "consumables" under items: "items/consumables/potions"'),
        filters: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe('Wowhead path filters, e.g. ["min-req-level:0","max-req-level:20"] or "min-req-level:0/max-req-level:20"'),
        sort: z
          .union([z.string(), z.object({ field: z.string(), order: z.enum(['asc', 'desc']).optional() })])
          .optional()
          .describe('Numeric field to order by, e.g. "dps desc", "reqlevel asc", "-armor" (default order desc)'),
        limit: z.number().int().min(1).max(BROWSE_MAX_ROWS).optional().describe(`Rows to return (default ${BROWSE_DEFAULT_ROWS}, max ${BROWSE_MAX_ROWS})`),
        where: whereSchema,
        includeNoSource: z
          .boolean()
          .optional()
          .describe('Items only: also list items Wowhead knows no source for (NPC-only/placeholder gear). Default false.'),
      },
    },
    async ({ path, filters, sort, limit, where, includeNoSource }) => {
      try {
        const bp = normalizeBrowsePath(path, filters);
        const dead = DEAD_PATHS[bp.path.split('/')[0]!];
        if (dead) return fail(dead);
        const spec = specForPath(bp.path);
        const page = await client.listing(bp.path, bp.filters);
        const url = client.listingUrl(bp.path, bp.filters);
        const globals = await client.globalNames();
        const names = new Map<string, string>();
        for (const [typeId, records] of page.gatherer) {
          for (const [id, rec] of records) {
            const n = rec['name_enus'];
            if (typeof n === 'string' && n) names.set(`${typeId}:${id}`, n);
          }
        }
        const ctx = { globals, names, pageUrl: (p: string, id: number) => client.pageUrl(p, id) };
        const body = shapeBrowse(page, spec, bp.path, url, { where, sort, limit, requestedFilters: bp.filters, includeNoSource }, ctx);
        const truncated = body['truncated'] === true || body['possiblyTruncated'] === true;
        return ok(
          finish(
            body,
            sourceOf(url),
            truncated
              ? 'This list is capped by Wowhead (see truncationNote): say the ranking covers only the rows Wowhead displayed, and suggest a narrower path or filter.'
              : undefined,
          ),
        );
      } catch (err) {
        logger.error({ err }, 'forever_browse failed');
        return fail(describeError(err));
      }
    },
  );

  // ── Search ──────────────────────────────────────────
  server.registerTool(
    'forever_search',
    {
      title: 'Search WoW: Forever',
      description:
        'Search the Wowhead World of Warcraft: Forever database by name. Returns matching items, quests, NPCs, spells, zones, etc. with their Wowhead links; the `id` is only for calling forever_lookup or forever_details.' +
        DESCRIPTION_GUIDANCE,
      inputSchema: {
        query: z.string().min(2).describe('Name or partial name, e.g. "Defender of Dalaran" or "Hogger"'),
        type: typeSchema.optional().describe('Only return this kind of result'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
      },
    },
    async ({ query, type, limit }) => {
      try {
        const results = await client.search(query, { type: type ? resolveType(type) : undefined, limit });
        const source = sourceOf(client.searchUrl(query), 'Wowhead: WoW Forever search');
        if (results.length === 0) {
          return ok(finish({ query, results: [], note: 'No matches on Wowhead Forever.' }, source));
        }
        return ok(finish({ query, results: results.map(presentMatch) }, source));
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
        'Get the tooltip summary for one WoW: Forever entity by type and id: name, quality, stats, level, requirements, effects. For items it also returns slot, item level and crafting reagents (by name).' +
        DESCRIPTION_GUIDANCE,
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
        const url = client.pageUrl(t.path, id);
        if (!tooltip && !item) {
          // Fall back to the full page so the model still gets something useful.
          const page = await client.page(t, id);
          return ok(await shapePage(page, url, { maxRows: 10 }, client));
        }
        const name = tooltip?.name ?? (typeof item?.['name'] === 'string' ? item['name'] : undefined);
        const shownItem = item ? await presentItem(item, client) : undefined;
        // The item card repeats the tooltip text; send it once.
        if (shownItem && tooltip?.text && shownItem['tooltip'] === tooltip.text) delete shownItem['tooltip'];
        return ok(
          finish(
            {
              ...(name ? { name } : {}),
              type: t.name,
              ...(tooltip?.quality ? { quality: tooltip.quality } : {}),
              url,
              ...(tooltip?.text ? { tooltip: tooltip.text } : {}),
              ...(shownItem ? { item: shownItem } : {}),
            },
            sourceOf(url),
          ),
        );
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
        'Read the full Wowhead Forever page for an entity: quick facts, description/objectives, and data tables such as dropped-by (with drop chance and sample size), sold-by, starts/ends quest, objective-of, reward-from, created-by (reagents by name), reagent-for, teaches, quests in a zone. Rows carry a `zone` name, a level range and a Wowhead `url`; drop tables are ordered by drop chance. Use `sections` to restrict — or to reach a table that is hidden by default (transmog, comments, media, shared cooldowns).' +
        DESCRIPTION_GUIDANCE,
      inputSchema: {
        type: typeSchema,
        id: z.number().int().positive().describe('Wowhead id from forever_search'),
        sections: z
          .array(z.string())
          .optional()
          .describe('Only include tables whose id contains one of these, e.g. ["dropped-by","sold-by"]'),
        maxRows: z.number().int().min(1).max(200).optional().describe('Max rows per table (default 25)'),
        minChance: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Drop tables only: keep rows at or above this drop chance %, e.g. 5'),
        minSamples: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Drop tables only: keep rows based on at least this many kills/loots, e.g. 100'),
      },
    },
    async ({ type, id, sections, maxRows, minChance, minSamples }) => {
      try {
        const t = resolveType(type);
        const page = await client.page(t, id);
        return ok(
          await shapePage(
            page,
            client.pageUrl(t.path, id),
            { sections, maxRows: maxRows ?? 25, minChance, minSamples },
            client,
          ),
        );
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
        'One-step answer for questions like "where does X drop", "who sells X", "how do I start quest X": searches WoW: Forever by name, then returns details of the best match plus the other candidates. Rows carry a `zone` name, a level range and a Wowhead `url`; drop tables are ordered by drop chance and report sample sizes, so low-sample flukes are not presented as solid rates. Returns the top rows per table; use forever_details with `sections` for more of one table.' +
        DESCRIPTION_GUIDANCE,
      inputSchema: {
        name: z.string().min(2).describe('Name of the item, quest, NPC, zone, ...'),
        type: typeSchema.optional().describe('Restrict to this kind of thing (recommended)'),
        sections: z
          .array(z.string())
          .optional()
          .describe('Only include tables whose id contains one of these, e.g. ["dropped-by","sold-by"]'),
        maxRows: z.number().int().min(1).max(200).optional().describe(`Max rows per table (default ${FIND_DEFAULT_ROWS})`),
        minChance: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Drop tables only: keep rows at or above this drop chance %, e.g. 5 — use it to get the real farm, not 200 rows'),
        minSamples: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Drop tables only: keep rows based on at least this many kills/loots, e.g. 100'),
      },
    },
    async ({ name, type, sections, maxRows, minChance, minSamples }) => {
      try {
        const results = await client.search(name, { type: type ? resolveType(type) : undefined, limit: 8 });
        if (results.length === 0) {
          return ok(
            finish(
              { query: name, note: 'No matches on Wowhead Forever.' },
              sourceOf(client.searchUrl(name), 'Wowhead: WoW Forever search'),
            ),
          );
        }
        // A bare name can match several entity types (an item and a spell called
        // the same thing). Prefer the kinds a player is usually asking about, and
        // say plainly when the name was ambiguous.
        const exactMatches = results.filter((r) => r.name.toLowerCase() === name.toLowerCase());
        const best: SearchResult =
          exactMatches.find((r) => PREFERRED_TYPES.includes(r.type)) ?? exactMatches[0] ?? results[0]!;
        const collisions = exactMatches.filter((r) => r !== best);
        const others = results.filter((r) => r !== best && !collisions.includes(r));
        const t = resolveType(best.type);
        const page = await client.page(t, best.id);
        // shapePage ends with `answerGuidance` then `source`, so the link to
        // where the answer came from is always the last thing in the reply.
        return ok({
          match: presentMatch(best),
          ...(collisions.length > 0
            ? {
                nameCollisions: collisions.map(presentMatch),
                nameCollisionNote: 'Other entries with the same name; tell them apart by quality and link, not by id.',
              }
            : {}),
          ...(others.length > 0 ? { otherMatches: others.map(presentMatch) } : {}),
          ...(await shapePage(
            page,
            best.url,
            { sections, maxRows: maxRows ?? FIND_DEFAULT_ROWS, minChance, minSamples },
            client,
          )),
        });
      } catch (err) {
        logger.error({ err }, 'forever_find failed');
        return fail(describeError(err));
      }
    },
  );
}
