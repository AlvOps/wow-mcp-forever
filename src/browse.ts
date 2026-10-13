/**
 * forever_browse: enumerate one Wowhead /forever/ category in a single call,
 * e.g. "best level-20 one-handed sword" =
 *   path items/weapons/one-handed-swords, filters [min-req-level:0, max-req-level:20], sort dps desc.
 *
 * Rows are read from the listing page (see wowhead/listing.ts), then — with no
 * further requests — optionally narrowed by a local `where`, sorted by a
 * numeric field, and capped. Everything that changes what the reader sees is
 * reported: Wowhead's own truncation note, which path filters Wowhead actually
 * applied (from the page, not from what we sent), how many rows `where`
 * removed, and an explicit flag when a filter emptied the list.
 */
import { presentListingRow, type PresentContext } from './present.js';
import { type ListingPage, type ListingSpec, primaryListview } from './wowhead/listing.js';
import { QUALITY_NAMES } from './wowhead/types.js';

/** Hard cap on rows returned in one response. */
export const BROWSE_MAX_ROWS = 200;
export const BROWSE_DEFAULT_ROWS = 25;
/** Wowhead's listing pages never display more than this many rows. */
export const WOWHEAD_LISTING_CAP = 1000;

export type WhereOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
export type WhereCond = number | string | Partial<Record<WhereOp, number | string>>;
export type Where = Record<string, WhereCond>;
export type SortSpec = string | { field: string; order?: 'asc' | 'desc' };

/** One candidate row: its raw data, its gatherer record, and comparable fields. */
export interface BrowseRecord {
  row: Record<string, unknown>;
  record?: Record<string, unknown>;
  /** Lowercased field -> number|string, merged from row and (for items) jsonequip. */
  fields: Record<string, number | string>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Friendly names -> raw field keys. Anything not listed is looked up as given. */
const FIELD_ALIASES: Record<string, string> = {
  requiredlevel: 'reqlevel', reqlvl: 'reqlevel', req: 'reqlevel', minreqlevel: 'reqlevel',
  itemlevel: 'level', ilvl: 'level', ilevel: 'level',
  mledps: 'dps', mlespeed: 'speed', weaponspeed: 'speed',
  damagemin: 'dmgmin1', mindamage: 'dmgmin1', dmgmin: 'dmgmin1',
  damagemax: 'dmgmax1', maxdamage: 'dmgmax1', dmgmax: 'dmgmax1',
  strength: 'str', agility: 'agi', stamina: 'sta', intellect: 'int', spirit: 'spi',
  attackpower: 'atkpwr', rangedattackpower: 'rgdatkpwr', spellpower: 'splpwr', spelldamage: 'spldmg',
  healing: 'splheal', critrating: 'critstrkrtng', hitrating: 'hitrtng', defenserating: 'defrtng',
  mp5: 'manargn', hp5: 'healthrgn', sellprice: 'sellprice', bonusarmor: 'armorbonus',
  durability: 'dura', minlevel: 'minlevel', maxlevel: 'maxlevel', points: 'points',
};

export function fieldKey(name: string): string {
  const n = norm(name);
  return FIELD_ALIASES[n] ?? n;
}

function flatFields(...sources: Array<Record<string, unknown> | undefined>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[norm(k)] = v;
      else if (typeof v === 'string' && v.length < 200) out[norm(k)] ??= v;
    }
  }
  return out;
}

/**
 * Candidate rows for a listing page, in Wowhead's order (popularity).
 * Prefers the primary listview; falls back to the spec's gatherer records
 * (shape A) when the page delivers no listview rows.
 */
export function buildRecords(
  page: ListingPage,
  spec: ListingSpec | undefined,
): { records: BrowseRecord[]; template: string; variantsFolded: number; note?: string; truncated?: boolean; totalFound?: number; rawRows: number } {
  const lv = primaryListview(page, spec);
  const own = spec?.gathererType !== undefined ? page.gatherer.get(spec.gathererType) : undefined;
  if (lv) {
    const template = spec?.template ?? lv.template ?? '';
    const seen = new Set<string>();
    const records: BrowseRecord[] = [];
    let variantsFolded = 0;
    for (const row of lv.rows) {
      // Random-suffix variants ("... of the Monkey") repeat their base item with
      // `parentListviewRowItem`; Wowhead's own UI hides them, so do we.
      const key = String(row['id']);
      if (row['parentListviewRowItem'] !== undefined || seen.has(key)) {
        variantsFolded++;
        continue;
      }
      seen.add(key);
      const record = own?.get(key);
      const equip = record?.['jsonequip'] as Record<string, unknown> | undefined;
      records.push({ row, ...(record ? { record } : {}), fields: flatFields(equip, row) });
    }
    return {
      records,
      template,
      variantsFolded,
      rawRows: lv.rows.length,
      ...(lv.note ? { note: lv.note } : {}),
      ...(lv.truncated ? { truncated: true } : {}),
      ...(lv.totalFound !== undefined ? { totalFound: lv.totalFound } : {}),
    };
  }
  // Shape A only: the records ARE the rows.
  const records: BrowseRecord[] = [];
  for (const [id, record] of own ?? []) {
    const equip = record['jsonequip'] as Record<string, unknown> | undefined;
    const row = { id: Number(id), name: record['name_enus'], quality: record['quality'], ...(equip ?? {}) };
    records.push({ row, record, fields: flatFields(equip, row) });
  }
  return { records, template: spec?.template ?? '', variantsFolded: 0, rawRows: records.length };
}

/** Field value for comparison; items with no `reqlevel` have no requirement (0). */
function valueOf(r: BrowseRecord, key: string, template: string): number | string | undefined {
  const v = r.fields[key];
  if (v !== undefined) return v;
  if (key === 'reqlevel' && template === 'item') return 0;
  if (key === 'level') return r.fields['maxlevel'] ?? r.fields['minlevel'];
  return undefined;
}

function qualityIndex(v: number | string): number | string {
  if (typeof v === 'number') return v;
  const i = QUALITY_NAMES.findIndex((q) => q.toLowerCase() === v.trim().toLowerCase());
  return i >= 0 ? i : v;
}

function coerce(key: string, v: number | string): number | string {
  if (key === 'quality') return qualityIndex(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return v;
}

/** "<=20", ">= 5", "!=3", "=Rare" -> {op: value}; anything else is equality. */
function parseCond(cond: WhereCond): Partial<Record<WhereOp, number | string>> {
  if (typeof cond === 'number') return { eq: cond };
  if (typeof cond === 'string') {
    const m = /^\s*(<=|>=|!=|<|>|=)\s*(.+)$/.exec(cond);
    if (!m) return { eq: cond };
    const op = ({ '<=': 'lte', '>=': 'gte', '!=': 'ne', '<': 'lt', '>': 'gt', '=': 'eq' } as const)[m[1] as '<=']!;
    return { [op]: m[2]!.trim() };
  }
  return cond;
}

function test(op: WhereOp, actual: number | string, expected: number | string): boolean {
  if (typeof actual === 'string' || typeof expected === 'string') {
    const a = String(actual).toLowerCase();
    const e = String(expected).toLowerCase();
    if (op === 'eq') return a === e;
    if (op === 'ne') return a !== e;
    return false; // ordering on text is never meaningful here
  }
  switch (op) {
    case 'eq': return actual === expected;
    case 'ne': return actual !== expected;
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    case 'gt': return actual > expected;
    case 'gte': return actual >= expected;
  }
}

/**
 * Local filter over rows already in hand (no fetch). A row without the field
 * fails the condition — and is counted separately, so "no dps value" is never
 * confused with "dps too low".
 */
export function applyWhere(
  records: BrowseRecord[],
  where: Where | undefined,
  template: string,
): { kept: BrowseRecord[]; removed: number; missingField: Record<string, number> } {
  if (!where || Object.keys(where).length === 0) return { kept: records, removed: 0, missingField: {} };
  const conds = Object.entries(where).map(([name, cond]) => {
    const key = fieldKey(name);
    const ops = Object.entries(parseCond(cond)).filter(([op]) =>
      ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op),
    ) as Array<[WhereOp, number | string]>;
    return { name, key, ops: ops.map(([op, v]) => [op, coerce(key, v)] as [WhereOp, number | string]) };
  });
  const missingField: Record<string, number> = {};
  const kept = records.filter((r) =>
    conds.every(({ name, key, ops }) => {
      const raw = valueOf(r, key, template);
      if (raw === undefined) {
        missingField[name] = (missingField[name] ?? 0) + 1;
        return false;
      }
      const actual = coerce(key, raw);
      return ops.every(([op, v]) => test(op, actual, v));
    }),
  );
  return { kept, removed: records.length - kept.length, missingField };
}

/** "dps", "dps desc", "-dps", "dps:asc", {field,order}. Numeric stats default to descending. */
export function parseSort(sort: SortSpec | undefined): { key: string; label: string; order: 'asc' | 'desc' } | undefined {
  if (sort === undefined || sort === '') return undefined;
  let field: string;
  let order: 'asc' | 'desc' | undefined;
  if (typeof sort === 'string') {
    const s = sort.trim();
    const m = /^([+-]?)([\w\s.-]+?)(?:[\s:]+(asc|desc|ascending|descending))?$/i.exec(s);
    if (!m) throw new Error(`Cannot read sort "${sort}". Use e.g. "dps desc" or {"field":"reqlevel","order":"asc"}.`);
    field = m[2]!.trim();
    if (m[1] === '-') order = 'desc';
    else if (m[1] === '+') order = 'asc';
    if (m[3]) order = m[3].toLowerCase().startsWith('asc') ? 'asc' : 'desc';
  } else {
    field = sort.field;
    order = sort.order;
  }
  return { key: fieldKey(field), label: field, order: order ?? 'desc' };
}

/** Stable sort by one field; rows without a value go last whatever the order. */
export function sortRecords(
  records: BrowseRecord[],
  sort: { key: string; order: 'asc' | 'desc' } | undefined,
  template: string,
): BrowseRecord[] {
  if (!sort) return records;
  const dir = sort.order === 'asc' ? 1 : -1;
  return records
    .map((r, i) => ({ r, i, v: valueOf(r, sort.key, template) }))
    .sort((a, b) => {
      const av = a.v === undefined ? undefined : coerce(sort.key, a.v);
      const bv = b.v === undefined ? undefined : coerce(sort.key, b.v);
      if (av === undefined && bv === undefined) return a.i - b.i;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number' && av !== bv) return (av - bv) * dir;
      if (typeof av === 'string' || typeof bv === 'string') {
        const c = String(av).localeCompare(String(bv));
        if (c !== 0) return c * dir;
      }
      return a.i - b.i;
    })
    .map((x) => x.r);
}

export interface BrowseOptions {
  where?: Where;
  sort?: SortSpec;
  limit?: number;
  /** Path filters requested by the caller ("max-req-level:20"). */
  requestedFilters: string[];
  /** Items: keep rows Wowhead knows no source for (NPC-only "Monster -" gear, [TMP] placeholders). */
  includeNoSource?: boolean;
}

/** An item Wowhead lists with no source at all: NPC-only, placeholder or unreleased. */
export function hasNoSource(r: BrowseRecord): boolean {
  const src = r.row['source'];
  const more = r.row['sourcemore'];
  return !(Array.isArray(src) && src.length > 0) && !(Array.isArray(more) && more.length > 0);
}

/**
 * Build the forever_browse payload body (without answerGuidance/source, which
 * `finish` appends so `source` stays last).
 */
export function shapeBrowse(
  page: ListingPage,
  spec: ListingSpec | undefined,
  path: string,
  url: string,
  opts: BrowseOptions,
  ctx: PresentContext,
): Record<string, unknown> {
  const built = buildRecords(page, spec);
  const { records, template } = built;
  const entity = spec?.entity ?? template;
  const refType = spec?.refType;

  // Path filters: only claim what Wowhead says it applied.
  const active = new Set(page.activeFilters ?? []);
  const applied = opts.requestedFilters.filter((f) => active.has(f));
  const notApplied = opts.requestedFilters.filter((f) => !active.has(f));

  // Items with no known source dominate any stat ranking ("Monster - Sword 1H", "[TMP] ...")
  // and cannot be obtained by a player; hide them by default and say how many.
  const hideNoSource = template === 'item' && !opts.includeNoSource;
  const candidates = hideNoSource ? records.filter((r) => !hasNoSource(r)) : records;
  const noSourceHidden = records.length - candidates.length;

  const { kept, removed, missingField } = applyWhere(candidates, opts.where, template);
  const sort = parseSort(opts.sort);
  const sorted = sortRecords(kept, sort, template);
  const limit = Math.min(Math.max(1, opts.limit ?? BROWSE_DEFAULT_ROWS), BROWSE_MAX_ROWS);
  const shown = sorted.slice(0, limit);
  const rows = shown.map((r) =>
    presentListingRow({ row: r.row, ...(r.record ? { record: r.record } : {}), template, entity, ...(refType !== undefined ? { refType } : {}) }, ctx),
  );

  const label = spec?.label ?? 'rows';
  const truncated = built.truncated === true;
  const atCap = !truncated && built.rawRows >= WOWHEAD_LISTING_CAP;
  const emptied = candidates.length > 0 && kept.length === 0 && removed > 0;
  const whereUsed = opts.where && Object.keys(opts.where).length > 0;
  const title = page.title?.replace(/^Forever\s+/i, '').trim();

  return {
    ...(title ? { category: title } : {}),
    path,
    url,
    ...(applied.length ? { filtersApplied: applied } : {}),
    ...(notApplied.length
      ? {
          filtersNotApplied: notApplied,
          pathFilterNote:
            `Wowhead ignored ${notApplied.join(', ')} on this page — the list below is NOT narrowed by ${notApplied.length > 1 ? 'them' : 'it'}.` +
            (page.supportedFilters?.length ? ` This page accepts: ${page.supportedFilters.join(', ')}.` : ' This page has no path filters; use `where` instead.'),
        }
      : {}),
    rowsOnPage: records.length,
    ...(built.totalFound !== undefined ? { totalOnWowhead: built.totalFound } : {}),
    ...(truncated
      ? {
          truncated: true,
          truncationNote: `Wowhead: "${built.note ?? 'more results exist than are displayed'}". Sorting and \`where\` only see the ${records.length} ${label} on this page; add path filters or a narrower path for the rest.`,
        }
      : atCap
        ? {
            possiblyTruncated: true,
            truncationNote: `This page hit Wowhead's ${WOWHEAD_LISTING_CAP}-row listing cap, so more ${label} probably exist. Sorting and \`where\` only see these rows; use a narrower path or path filters.`,
          }
        : {}),
    ...(built.variantsFolded > 0
      ? { variantNote: `${built.variantsFolded} random-suffix variant rows ("... of the Monkey" etc.) were folded into their base item, as on Wowhead.` }
      : {}),
    ...(noSourceHidden > 0
      ? {
          noSourceHidden,
          noSourceNote: `${noSourceHidden} items with no known source on Wowhead (NPC-only "Monster -" weapons, "[TMP]" placeholders, unreleased items) are hidden so they cannot top a ranking; pass includeNoSource:true to list them.`,
        }
      : {}),
    ...(whereUsed ? { rowsMatched: kept.length, rowsFilteredOut: removed } : {}),
    ...(Object.keys(missingField).length
      ? { whereNote: `Rows with no value for a \`where\` field were excluded: ${Object.entries(missingField).map(([f, n]) => `${n} lacked ${f}`).join(', ')}.` }
      : {}),
    ...(emptied
      ? {
          emptyBecauseOfFilter: true,
          filterNote: `All ${candidates.length} ${label} on this page were removed by your \`where\` filter — the category DOES have entries, they were filtered out. Loosen or drop \`where\` to see them.`,
        }
      : {}),
    ...(sort ? { sortedBy: `${sort.label} ${sort.order}${template === 'item' && sort.key === 'reqlevel' ? ' (no requiredLevel = no requirement)' : ''}` } : {}),
    rowsReturned: rows.length,
    ...(sorted.length > rows.length ? { moreRows: sorted.length - rows.length } : {}),
    ...(template === 'item' ? { note: 'An item with no `requiredLevel` has no level requirement.' } : {}),
    rows,
  };
}
