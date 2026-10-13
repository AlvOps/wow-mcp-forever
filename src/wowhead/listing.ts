/**
 * Wowhead /forever/ LISTING pages (category browse), e.g.
 *   /forever/items/weapons/one-handed-swords/min-req-level:0/max-req-level:20
 *
 * Every listing page carries its rows in ONE primary `Listview`, delivered in
 * one of three encodings (all verified live):
 *   1. inline:     new Listview({..., "data":[{...},...]})           npcs, quests, hunter-pets
 *   2. by variable: new Listview({..., data: listviewitems}) + `var listviewitems = [...]`
 *                                                                  items, spells, talents, item-sets
 *   3. JSON script: <script type="application/json" id="data.page.listPage.listviews">[...]
 *                                                                  zones, achievements
 * and, separately, `WH.Gatherer.addData(<typeId>, <env>, {id: record})` blocks
 * that ENRICH the rows: item records carry the full stat block at `jsonequip`
 * (dps, speed, dmgmin1/dmgmax1, reqlevel, ...); spell records a description;
 * other types names for ids a row references (set pieces, pet abilities,
 * quest rewards). A page without any addData (npcs) is NOT an empty page.
 *
 * Truncation is self-reported in the Listview options:
 *   "_truncated":1,"note":"15,205 NPCs found (1,000 displayed) - Try filtering your results"
 * and Wowhead reports the path-segment filters it actually applied in
 * `Filter.init({... "activeFacets": {...}})` and the canonical link. A filter
 * segment a page does not understand is silently dropped (talents ignore
 * min-req-level and canonicalise back to /spells/talents), so "applied" is
 * only ever claimed from activeFacets — never from what we sent.
 */
import { extractBalanced, lenientJson } from './parse.js';
import { parseListviews } from './parse.js';

/** How rows for one listing path are read. Data, not a chain of ifs. */
export interface ListingSpec {
  /** First path segment(s), e.g. "items", "item-sets", "npcs". */
  prefix: string;
  /** Entity URL path for row links: `/forever/<entity>=<id>`. */
  entity: string;
  /** Listview template the rows are shaped with. */
  template: string;
  /** Preferred primary Listview id on the page. */
  listview: string;
  /**
   * WH.Gatherer type id whose records belong to (or enrich) the rows:
   * 3 items (jsonequip stats), 6 spells/abilities/talents/pet abilities, 10 achievements.
   * Undefined: the page has no addData for its rows (listview-only).
   */
  gathererType?: number;
  /** Gatherer type id that names ids the rows reference (set pieces, pet abilities, rewards). */
  refType?: number;
  /** One-line label used in notes. */
  label: string;
}

export const LISTING_SPECS: readonly ListingSpec[] = [
  { prefix: 'items', entity: 'item', template: 'item', listview: 'items', gathererType: 3, label: 'items' },
  { prefix: 'item-sets', entity: 'item-set', template: 'item-set', listview: 'item-sets', refType: 3, label: 'item sets' },
  { prefix: 'achievements', entity: 'achievement', template: 'achievement', listview: 'achievements', gathererType: 10, refType: 3, label: 'achievements' },
  { prefix: 'hunter-pets', entity: 'pet', template: 'pet', listview: 'pets', refType: 6, label: 'hunter pets' },
  { prefix: 'talents', entity: 'spell', template: 'spell', listview: 'spells', gathererType: 6, refType: 3, label: 'talents' },
  { prefix: 'abilities', entity: 'spell', template: 'spell', listview: 'spells', gathererType: 6, refType: 3, label: 'abilities' },
  { prefix: 'profession-spells', entity: 'spell', template: 'spell', listview: 'spells', gathererType: 6, refType: 3, label: 'profession spells' },
  { prefix: 'spells', entity: 'spell', template: 'spell', listview: 'spells', gathererType: 6, refType: 3, label: 'spells' },
  { prefix: 'npcs', entity: 'npc', template: 'npc', listview: 'npcs', label: 'NPCs' },
  { prefix: 'objects', entity: 'object', template: 'object', listview: 'objects', label: 'objects' },
  { prefix: 'zones', entity: 'zone', template: 'zone', listview: 'zones', label: 'zones' },
  { prefix: 'factions', entity: 'faction', template: 'faction', listview: 'factions', label: 'factions' },
  { prefix: 'quests', entity: 'quest', template: 'quest', listview: 'quests', refType: 3, label: 'quests' },
  { prefix: 'guides', entity: 'guide', template: 'guide', listview: 'guides', label: 'guides' },
];

/**
 * Short names for the zone listing, already narrowed. Wowhead has no
 * /forever/dungeons page (verified 404) and the zones listing ignores every
 * path filter — it answers with all 143 zones whatever you append — so the
 * narrowing is done locally on the columns the page carries (parse.ts maps
 * `instance`/`territory` to the words the site prints). "which Forever
 * dungeons exist" is a real question the tool had no answer for before this.
 */
export const BROWSE_ALIASES: Readonly<
  Record<string, { segment: string; where?: Record<string, string> }>
> = {
  dungeons: { segment: 'zones', where: { instanceType: 'Dungeon' } },
  instances: { segment: 'zones', where: { instanceType: 'Dungeon' } },
  raids: { segment: 'zones', where: { instanceType: 'Raid' } },
  battlegrounds: { segment: 'zones', where: { instanceType: 'Battleground' } },
  bgs: { segment: 'zones', where: { instanceType: 'Battleground' } },
};

/** First path segment of a browse path, lowercased, filters stripped. */
export function firstSegment(rawPath: string): string {
  const p = rawPath.trim().toLowerCase().replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
  return p.replace(/^\/+/, '').replace(/^forever\//, '').split('/')[0] ?? '';
}

/** The local `where` an alias implies, if the path's first segment is one. */
export function browseAliasWhere(rawPath: string): Record<string, string> | undefined {
  return BROWSE_ALIASES[firstSegment(rawPath)]?.where;
}

/** Listing paths Wowhead answers with 404 or with an empty landing page (verified). */
export const DEAD_PATHS: Readonly<Record<string, string>> = {
  'pet-species': 'Wowhead returns 404 for /forever/pet-species; use "hunter-pets".',
  'skill-spells': 'Wowhead returns 404 for /forever/skill-spells; use "profession-spells" or "talents".',
  professions: 'The /forever/professions landing page carries no data; use "profession-spells" (optionally /<profession>).',
  skills: 'The /forever/skills landing page carries no data; use "talents" or "profession-spells".',
};

export function specForPath(path: string): ListingSpec | undefined {
  const first = path.split('/')[0] ?? '';
  return LISTING_SPECS.find((s) => s.prefix === first);
}

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const FILTER_SEGMENT = /^[a-z][a-z0-9-]*:[a-z0-9.,-]+$/;

export interface BrowsePath {
  /** Category path without filters, e.g. "items/weapons/one-handed-swords". */
  path: string;
  /** Filter segments "name:value", in the order given. */
  filters: string[];
}

/**
 * Forgiving path + filter normaliser. Accepts "items/weapons/one-handed-swords",
 * a full Wowhead URL, a leading "forever/", filter segments mixed into the path,
 * and filters as an array or a raw "a:1/b:2" suffix.
 */
export function normalizeBrowsePath(rawPath: string, rawFilters?: string[] | string): BrowsePath {
  let p = rawPath.trim().toLowerCase();
  p = p.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
  p = p.replace(/^\/+/, '').replace(/^forever\//, '').replace(/\/+$/, '');
  const segments = p.split('/').filter(Boolean);
  const path: string[] = [];
  const filters: string[] = [];
  for (const s of segments) {
    if (FILTER_SEGMENT.test(s)) filters.push(s);
    else if (SEGMENT.test(s)) path.push(s);
    else throw new Error(`Invalid path segment "${s}". Use lowercase slugs like "items/weapons/one-handed-swords".`);
  }
  const extra = typeof rawFilters === 'string' ? rawFilters.split('/') : (rawFilters ?? []);
  for (const raw of extra) {
    const f = raw.trim().toLowerCase().replace(/^\/+|\/+$/g, '').replace(/=/, ':');
    if (!f) continue;
    if (!FILTER_SEGMENT.test(f)) throw new Error(`Invalid filter "${raw}". Use "name:value", e.g. "max-req-level:20".`);
    filters.push(f);
  }
  if (path.length === 0) throw new Error('`path` is empty. Example: "items/weapons/one-handed-swords".');
  // Aliases resolve to the listing page that exists; the narrowing they imply
  // is applied as a local `where` by the caller (browseAliasWhere).
  const alias = BROWSE_ALIASES[path[0]!];
  if (alias) path[0] = alias.segment;
  // One value per filter name: the last one given wins.
  const byName = new Map<string, string>();
  for (const f of filters) byName.set(f.split(':')[0]!, f);
  return { path: path.join('/'), filters: [...byName.values()] };
}

// ── Parsing ────────────────────────────────────────────

export interface ListingListview {
  id: string;
  template?: string;
  rows: Record<string, unknown>[];
  /** Wowhead's own note, e.g. "15,205 NPCs found (1,000 displayed) - Try filtering your results". */
  note?: string;
  truncated?: boolean;
  /** Total Wowhead says exist, parsed from the note ("15,205 NPCs found"). */
  totalFound?: number;
}

export interface ListingPage {
  title?: string;
  canonical?: string;
  listviews: ListingListview[];
  /** typeId -> id -> record, merged over every addData call of that type. */
  gatherer: Map<number, Map<string, Record<string, unknown>>>;
  /** Filter segments Wowhead reports as applied ("min-req-level:0"); undefined if the page has no filter UI. */
  activeFilters?: string[];
  /** Filter names the page's filter UI accepts (e.g. min-req-level, quality, slot). */
  supportedFilters?: string[];
}

/** Every `WH.Gatherer.addData(typeId, env, {...})` as full records (balanced-brace scan). */
export function parseGathererRecords(html: string): Map<number, Map<string, Record<string, unknown>>> {
  const out = new Map<number, Map<string, Record<string, unknown>>>();
  const re = /Gatherer\.addData\(\s*(\d+)\s*,\s*\d+\s*,\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const typeId = Number(m[1]);
    if (typeId === 29) continue; // icons, not entities
    const objText = extractBalanced(html, m.index + m[0].length);
    if (!objText) continue;
    re.lastIndex = m.index + m[0].length + objText.length;
    const parsed = lenientJson(objText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const bucket = out.get(typeId) ?? new Map<string, Record<string, unknown>>();
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === 'object') bucket.set(id, { ...(bucket.get(id) ?? {}), ...(v as Record<string, unknown>) });
    }
    out.set(typeId, bucket);
  }
  return out;
}

const NOTE_RE = /["']?note["']?\s*:\s*(["'])((?:\\.|(?!\1).)*)\1/;
const TRUNC_RE = /["']?_truncated["']?\s*:\s*(?:1|true)\b/;

function totalFromNote(note: string | undefined): number | undefined {
  const m = note ? /([\d,]+)\s+[^\d]*?found/i.exec(note) : null;
  return m ? Number(m[1]!.replace(/,/g, '')) : undefined;
}

function rowsOf(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

/** `var name = [...]` / `name = [...]` anywhere in the page. */
function resolveDataVar(html: string, name: string): Record<string, unknown>[] {
  const re = new RegExp(`(?:^|[\\s;,(])(?:var|let|const)?\\s*${name.replace(/\$/g, '\\$')}\\s*=\\s*\\[`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const arr = extractBalanced(html, m.index + m[0].length - 1);
    const rows = rowsOf(arr ? lenientJson(arr) : undefined);
    if (rows.length) return rows;
  }
  return [];
}

/**
 * Listview tables of a listing page: inline data (reusing parseListviews),
 * data held in a page variable, and the JSON-script encoding. Truncation notes
 * are read from the Listview options with the data array removed, so a row
 * that happens to carry a `note` field cannot be mistaken for the table note.
 */
export function parseListingListviews(html: string): ListingListview[] {
  // Inline tables the entity-page parser already understands, by id.
  const inline = new Map<string, Record<string, unknown>[]>();
  for (const lv of parseListviews(html)) if (!inline.has(lv.id)) inline.set(lv.id, lv.rows);
  const out: ListingListview[] = [];
  const re = /new\s+(?:WH\.)?Listview\s*\(\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const objText = extractBalanced(html, m.index + m[0].length);
    if (!objText) continue;
    const id = /["']?\bid["']?\s*:\s*['"]([^'"]+)['"]/.exec(objText)?.[1];
    if (!id) continue;
    const template = /["']?\btemplate["']?\s*:\s*['"]([^'"]+)['"]/.exec(objText)?.[1];
    // Options without the data array.
    let opts = objText;
    let rows = inline.get(id) ?? [];
    const inlineAt = /["']?\bdata["']?\s*:\s*\[/.exec(objText);
    if (inlineAt) {
      const arr = extractBalanced(objText, inlineAt.index + inlineAt[0].length - 1);
      if (arr) opts = objText.slice(0, inlineAt.index) + objText.slice(inlineAt.index + inlineAt[0].length - 1 + arr.length);
      if (!rows.length && arr) rows = rowsOf(lenientJson(arr));
    } else {
      // data: listviewitems  — but not data: WH.cOr([], listviewitems) (a gallery copy).
      const ref = /["']?\bdata["']?\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(objText)?.[1];
      if (ref) rows = resolveDataVar(html, ref);
    }
    const note = NOTE_RE.exec(opts)?.[2];
    const truncated = TRUNC_RE.test(opts);
    out.push({
      id,
      ...(template ? { template } : {}),
      rows,
      ...(note ? { note } : {}),
      ...(truncated ? { truncated } : {}),
      ...(totalFromNote(note) !== undefined ? { totalFound: totalFromNote(note) } : {}),
    });
  }

  // JSON-script encoding: zones, achievements.
  const js = /<script[^>]+id=["']data\.page\.listPage\.listviews["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (js) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(js[1]!);
    } catch {
      parsed = undefined;
    }
    for (const v of Array.isArray(parsed) ? parsed : []) {
      if (!v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      if (typeof o['id'] !== 'string') continue;
      const note = typeof o['note'] === 'string' ? o['note'] : undefined;
      out.push({
        id: o['id'],
        ...(typeof o['template'] === 'string' ? { template: o['template'] } : {}),
        rows: rowsOf(o['data']),
        ...(note ? { note } : {}),
        ...(o['_truncated'] ? { truncated: true } : {}),
        ...(totalFromNote(note) !== undefined ? { totalFound: totalFromNote(note) } : {}),
      });
    }
  }
  return out;
}

/** `Filter.init({...})`: which path filters Wowhead applied, and which it accepts. */
export function parseFilterState(html: string): { active?: string[]; supported?: string[] } {
  const at = html.indexOf('Filter.init(');
  if (at < 0) return {};
  const objText = extractBalanced(html, html.indexOf('{', at));
  const parsed = objText ? (lenientJson(objText) as Record<string, unknown> | undefined) : undefined;
  if (!parsed || typeof parsed !== 'object') return {};
  const facets = Array.isArray(parsed['facets']) ? (parsed['facets'] as Record<string, unknown>[]) : [];
  const supported = facets
    .filter((f) => typeof f['id'] === 'string' && (f['type'] === 'text' || f['type'] === 'select' || f['type'] === 'checkbox'))
    .map((f) => f['id'] as string)
    .filter((id) => id !== 'name');
  const activeRaw = parsed['activeFacets'];
  const active: string[] = [];
  if (activeRaw && typeof activeRaw === 'object' && !Array.isArray(activeRaw)) {
    for (const [k, v] of Object.entries(activeRaw as Record<string, unknown>)) {
      const value = v && typeof v === 'object' ? (v as Record<string, unknown>)['value'] : v;
      if (value !== undefined && value !== null && value !== '') active.push(`${k}:${String(value).toLowerCase()}`);
    }
  }
  return { active, supported };
}

export function parseListingPage(html: string): ListingPage {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
  const filter = parseFilterState(html);
  return {
    ...(title ? { title } : {}),
    ...(canonical ? { canonical } : {}),
    listviews: parseListingListviews(html),
    gatherer: parseGathererRecords(html),
    ...(filter.active ? { activeFilters: filter.active } : {}),
    ...(filter.supported ? { supportedFilters: filter.supported } : {}),
  };
}

/**
 * The listview that holds the category's rows: the spec's id if present,
 * else the largest table whose template matches, else the largest table.
 * Undefined when the page has no listview rows at all.
 */
export function primaryListview(page: ListingPage, spec: ListingSpec | undefined): ListingListview | undefined {
  const withRows = page.listviews.filter((lv) => lv.rows.length > 0);
  if (spec) {
    const exact = withRows.find((lv) => lv.id === spec.listview);
    if (exact) return exact;
    const byTpl = withRows.filter((lv) => lv.template === spec.template).sort((a, b) => b.rows.length - a.rows.length)[0];
    if (byTpl) return byTpl;
  }
  return [...withRows].sort((a, b) => b.rows.length - a.rows.length)[0];
}
