/**
 * User-facing presentation of Wowhead data.
 *
 * Everything the tools return is read by a model and then relayed to a
 * player. Whatever reaches the model gets echoed: numeric ids ("item=287977"),
 * internal field names, `[id, count]` pairs it cannot name (so it invents
 * "[recipe reagent set]"), arrays it has to merge itself. So rows are reshaped
 * here into names, human level ranges, one zone string and a Wowhead URL —
 * and every id-bearing reference is resolved to a name from Wowhead data
 * before it leaves the server.
 */
import { REF_MARK, cleanFacts, formatMoney } from './wowhead/parse.js';
import { typeByName } from './wowhead/types.js';
import type { GlobalNames } from './wowhead/zones.js';

/** Presentation contract sent with every tool response (sibling of `source`). */
export const ANSWER_GUIDANCE =
  'Answer in plain language using names, levels, zones and drop chances, and link names with their `url`. ' +
  'Never show numeric ids, field names, table ids or raw JSON to the user, and do not comment on row counts or caps. ' +
  'End the answer with the source link.';

/** The same contract, phrased for tool descriptions. */
export const DESCRIPTION_GUIDANCE =
  ' Present results to the user as names with their Wowhead links (`url`); never show numeric ids, field names or raw JSON, and end with the `source` link.';

const ITEM = 3;
const CURRENCY = 17;

/** Listview template -> entity type name (for building row URLs). */
const TEMPLATE_TYPES: Record<string, string> = {
  npc: 'npc',
  item: 'item',
  spell: 'spell',
  quest: 'quest',
  object: 'object',
  zone: 'zone',
  achievement: 'achievement',
  faction: 'faction',
  itemset: 'itemset',
  title: 'title',
  currency: 'currency',
  event: 'event',
};

const TABLE_TITLES: Record<string, string> = {
  'dropped-by': 'Dropped by',
  'sold-by': 'Sold by',
  'created-by-spell': 'Created by',
  'created-by-item': 'Created by item',
  'reward-from-q': 'Quest reward from',
  'contained-in-item': 'Contained in item',
  'contained-in-object': 'Contained in object',
  'fished-in': 'Fished in',
  'pick-pocketed-from': 'Pick-pocketed from',
  'reagent-for': 'Reagent for',
  'criteria-of': 'Achievement criteria of',
  'shared-cooldown': 'Shares cooldown with',
};

export function tableTitle(id: string): string {
  if (TABLE_TITLES[id]) return TABLE_TITLES[id]!;
  const s = id.replace(/-/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Row = Record<string, unknown>;
type Pair = [number, number];

export interface PresentContext {
  globals: GlobalNames;
  /** `${typeId}:${id}` -> name. */
  names: Map<string, string>;
  pageUrl: (typePath: string, id: number) => string;
}

function pairs(v: unknown): Pair[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Pair[] = [];
  for (const p of v) {
    if (Array.isArray(p) && typeof p[0] === 'number') out.push([p[0], typeof p[1] === 'number' ? p[1] : 1]);
  }
  return out.length ? out : undefined;
}

/** Every `[typeId, id]` a summarized row references by id only. */
export function rowRefs(row: Row): Array<[number, number]> {
  const refs: Array<[number, number]> = [];
  for (const key of ['reagents', 'itemrewards', 'itemchoices', 'costItems']) {
    for (const [id] of pairs(row[key]) ?? []) refs.push([ITEM, id]);
  }
  const creates = row['creates'];
  if (Array.isArray(creates) && typeof creates[0] === 'number' && creates[0] > 0) refs.push([ITEM, creates[0]]);
  for (const [id] of pairs(row['costCurrencies']) ?? []) refs.push([CURRENCY, id]);
  return refs;
}

/** Every `[typeId, id]` marker left in parsed text. */
export function textRefs(text: string | undefined): Array<[number, number]> {
  if (!text) return [];
  return [...text.matchAll(REF_MARK)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
}

/** Replace reference markers with names; a reference Wowhead could not name is removed, never shown as an id. */
export function resolveText(text: string | undefined, names: Map<string, string>): string | undefined {
  if (!text) return text;
  return text.replace(REF_MARK, (_m, t: string, id: string) => names.get(`${t}:${id}`) ?? '');
}

export function resolveFacts(text: string | undefined, names: Map<string, string>): string | undefined {
  const resolved = resolveText(text, names);
  return resolved ? cleanFacts(resolved) : undefined;
}

/** "1x Leaded Vial, 3x Hot Spices" — or undefined if any name is unknown (never a half-known list). */
export function itemList(list: Pair[] | undefined, names: Map<string, string>, typeId = ITEM): string | undefined {
  if (!list) return undefined;
  const parts: string[] = [];
  for (const [id, count] of list) {
    const name = names.get(`${typeId}:${id}`);
    if (!name) return undefined;
    parts.push(`${count}x ${name}`);
  }
  return parts.join(', ');
}

const UNNAMED = 'Not available from Wowhead; see the linked page.';

/** "Tanaris", "Tanaris or Silithus", "A, B or C". */
export function joinZones(names: string[]): string {
  const uniq = [...new Set(names)];
  if (uniq.length <= 1) return uniq[0] ?? '';
  return `${uniq.slice(0, -1).join(', ')} or ${uniq.at(-1)}`;
}

function levelText(row: Row): string | undefined {
  const min = Number(row['minlevel']);
  const max = Number(row['maxlevel']);
  if (min > 0 && max > 0) return min === max ? String(min) : `${min}-${max}`;
  if (min > 0) return String(min);
  if (max > 0) return String(max);
  const lvl = Number(row['level']);
  return lvl > 0 ? String(lvl) : undefined;
}

function friendlyTo(react: unknown): string | undefined {
  if (!Array.isArray(react)) return undefined;
  const a = react[0] === 1;
  const h = react[1] === 1;
  if (a && h) return 'Alliance and Horde';
  if (a) return 'Alliance';
  if (h) return 'Horde';
  return undefined;
}

/**
 * Turn one summarized listview row into a user-facing row: no ids, no
 * internal fields. Keys: name, quality, url, level/itemLevel, rank, zone,
 * friendlyTo, subtitle, dropChance, samples, cost, stock, profession,
 * reagents, creates, rewards, choiceRewards, xp, money, side.
 */
export function presentRow(row: Row, template: string | undefined, ctx: PresentContext): Row {
  const out: Row = {};
  const tpl = template ?? '';
  const isItem = tpl === 'item';
  if (typeof row['name'] === 'string') out['name'] = row['name'];
  if (isItem && typeof row['quality'] === 'string') out['quality'] = row['quality'];

  const typeName = TEMPLATE_TYPES[tpl];
  const type = typeName ? typeByName(typeName) : undefined;
  if (type && typeof row['id'] === 'number' && row['id'] > 0) out['url'] = ctx.pageUrl(type.path, row['id']);

  const level = levelText(row);
  if (level) out[isItem ? 'itemLevel' : 'level'] = level;

  if (tpl === 'npc') {
    const cls = typeof row['classification'] === 'number' ? row['classification'] : 0;
    const rank = cls > 0 ? ctx.globals.classifications.get(cls) : undefined;
    if (rank) out['rank'] = rank;
    else if (row['boss']) out['rank'] = 'Boss';
  }

  const loc = row['location'];
  if (Array.isArray(loc)) {
    // Continent-level entries (id <= 0, e.g. "Azeroth") add nothing next to a real zone.
    const ids = loc.filter((id): id is number => typeof id === 'number');
    const specific = ids.some((id) => id > 0) ? ids.filter((id) => id > 0) : ids;
    const zones = specific
      .map((id) => (typeof id === 'number' ? ctx.globals.areas.get(id) : undefined))
      .filter((z): z is string => !!z);
    if (zones.length) out['zone'] = joinZones(zones);
  }

  const friendly = friendlyTo(row['react']);
  if (friendly) out['friendlyTo'] = friendly;
  if (tpl === 'npc' && typeof row['tag'] === 'string' && row['tag'].trim()) out['subtitle'] = row['tag'].trim();

  if (row['dropChance'] !== undefined) out['dropChance'] = row['dropChance'];
  if (typeof row['samples'] === 'number') out['samples'] = row['samples'];

  // Vendor price: money plus any currency/item costs, all by name.
  const costParts: string[] = [];
  if (typeof row['cost'] === 'string') costParts.push(row['cost']);
  const currencies = pairs(row['costCurrencies']);
  if (currencies) {
    const named = currencies.map(([id, n]) => {
      const name = ctx.globals.currencies.get(id) ?? ctx.names.get(`${CURRENCY}:${id}`);
      return name ? `${n}x ${name}` : undefined;
    });
    costParts.push(named.every(Boolean) ? named.join(', ') : UNNAMED);
  }
  if (row['costItems'] !== undefined) costParts.push(itemList(pairs(row['costItems']), ctx.names) ?? UNNAMED);
  if (costParts.length) out['cost'] = costParts.join(' + ');
  if (typeof row['stock'] === 'number' && row['stock'] > 0) out['stock'] = row['stock'];

  if (tpl === 'spell' && typeof row['learnedat'] === 'number') {
    const skillId = Array.isArray(row['skill']) ? row['skill'][0] : row['skill'];
    const skill = typeof skillId === 'number' ? ctx.globals.skills.get(skillId) : undefined;
    if (skill) out['profession'] = row['learnedat'] > 0 ? `${skill} (${row['learnedat']})` : skill;
  }

  if (row['reagents'] !== undefined) out['reagents'] = itemList(pairs(row['reagents']), ctx.names) ?? UNNAMED;
  const creates = row['creates'];
  if (Array.isArray(creates) && typeof creates[0] === 'number' && creates[0] > 0) {
    const name = ctx.names.get(`${ITEM}:${creates[0]}`);
    const lo = Number(creates[1]) || 1;
    const hi = Number(creates[2]) || lo;
    out['creates'] = name ? `${lo === hi ? lo : `${lo}-${hi}`}x ${name}` : UNNAMED;
  }
  if (row['itemrewards'] !== undefined) out['rewards'] = itemList(pairs(row['itemrewards']), ctx.names) ?? UNNAMED;
  if (row['itemchoices'] !== undefined) {
    const list = itemList(pairs(row['itemchoices']), ctx.names);
    out['choiceRewards'] = list ? `choose one: ${list}` : UNNAMED;
  }
  if (typeof row['xp'] === 'number' && row['xp'] > 0) out['xp'] = row['xp'];
  if (typeof row['money'] === 'number' && row['money'] > 0) out['money'] = formatMoney(row['money']);
  if (typeof row['side'] === 'string') out['side'] = row['side'];
  return out;
}

/** Search hit / match entry: keeps `id` (needed to chain tools) but always paired with `url`. */
export function presentMatch(r: { type: string; id: number; name: string; quality?: string; url: string }) {
  return {
    name: r.name,
    type: r.type,
    ...(r.quality ? { quality: r.quality } : {}),
    id: r.id,
    url: r.url,
  };
}

/** Append the presentation contract and the source; `source` is always the last field. */
export function finish<T extends object>(payload: T, source: { label: string; url: string }) {
  const { answerGuidance: _a, source: _s, ...rest } = payload as T & { answerGuidance?: unknown; source?: unknown };
  return { ...rest, answerGuidance: ANSWER_GUIDANCE, source };
}
