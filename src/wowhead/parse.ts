/**
 * Parsers for Wowhead responses. Wowhead has no official API, so everything
 * here is defensive: each parser returns what it can find and never throws
 * on unexpected markup.
 */
import { QUALITY_NAMES, typeById, typeByName } from './types.js';

// ── Text helpers ───────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    const lower = code.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower]!;
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return m;
  });
}

function tidy(s: string): string {
  return s
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Convert a fragment of tooltip/page HTML into readable plain text. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Raw newlines in HTML source are just whitespace; only tags break lines.
    .replace(/\s+/g, ' ')
    // Money is rendered with coin icons; keep the unit as text.
    .replace(/<span[^>]+class=["'][^"']*\bmoney(gold|silver|copper)\b[^"']*["'][^>]*>\s*([\d,]+)\s*<\/span>/gi,
      (_m, unit: string, n: string) => `${n}${unit[0]!.toLowerCase()}`)
    .replace(/<(h[1-6]|p|div|tr|table|ul|ol)(\s[^>]*)?>/gi, '\n$&')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\u00a0/g, ' ').replace(/ +([,.;)])/g, '$1');
  return tidy(s);
}

/** Wowhead markup entity tag names -> Wowhead type ids (see types.ts). */
const MARKUP_TYPE_IDS: Record<string, number> = {
  npc: 1, object: 2, item: 3, 'item-set': 4, itemset: 4, quest: 5, spell: 6, zone: 7,
  faction: 8, achievement: 10, title: 11, event: 12, skill: 15, currency: 17,
};

/** Resolves a `[npc=123]`-style reference to a display name, if known. */
export type RefResolver = (typeId: number, id: number) => string | undefined;

/**
 * Marker left in text for a reference whose name was not on the page; the
 * tool layer resolves it (or removes it) before anything reaches the model.
 */
export const REF_MARK = /\u27e6(\d+):(-?\d+)\u27e7/g;

/** Convert Wowhead's BBCode-like markup ([ul][li]...[/li][/ul]) into plain text. */
export function markupToText(markup: string, resolve?: RefResolver): string {
  let s = markup
    // Hidden tooltip bodies: the visible text is the [span tooltip=...] that follows.
    .replace(/\[tooltip\s+name=[^\]]*\][\s\S]*?\[\/tooltip\]/gi, '')
    .replace(/\[icondb=[^\]]*\]/gi, '')
    // NPC reaction is shown as coloured A/H letters (q2 friendly, q neutral, q10 hostile).
    .replace(/((?:\[color=q\d*\][AH]\[\/color\]\s*)+)/gi, (run: string) =>
      [...run.matchAll(/\[color=(q\d*)\]([AH])\[\/color\]/gi)]
        .map(([, q, side]) => {
          const attitude = q === 'q2' ? 'friendly' : q === 'q10' ? 'hostile' : 'neutral';
          return `${side!.toUpperCase() === 'A' ? 'Alliance' : 'Horde'} ${attitude}`;
        })
        .join(', '))
    .replace(/\[li(\s[^\]]*)?\]/gi, '\n- ')
    .replace(/\[\/li\]/gi, '\n')
    .replace(/\[\/?(ul|ol)\]/gi, '\n')
    .replace(/\[br\]/gi, '\n')
    .replace(/\[(npc|item|quest|spell|zone|object|achievement|faction|currency|item-set|itemset|title|skill|event)=(-?\d+)[^\]]*\]/gi,
      (_m, t: string, id: string) => {
        if (!resolve) return `${t} #${id}`;
        const typeId = MARKUP_TYPE_IDS[t.toLowerCase()]!;
        return resolve(typeId, Number(id)) ?? `\u27e6${typeId}:${id}\u27e7`;
      })
    .replace(/\[money=(\d+)(?:-(\d+))?\]/gi, (_m, a: string, b?: string) =>
      b && b !== a ? `${formatMoney(Number(a))} to ${formatMoney(Number(b))}` : formatMoney(Number(a)))
    .replace(/\[\/?[a-z-]+(=[^\]]*)?(\s[^\]]*)?\]/gi, '');
  s = decodeEntities(s);
  return tidy(s);
}

export function formatMoney(copper: number): string {
  if (!Number.isFinite(copper) || copper <= 0) return '0c';
  const g = Math.floor(copper / 10000);
  const s = Math.floor((copper % 10000) / 100);
  const c = copper % 100;
  return [g ? `${g}g` : '', s ? `${s}s` : '', c ? `${c}c` : ''].filter(Boolean).join(' ');
}

/**
 * "<title>" text for a page is really "Hogger - NPC - Forever"; the page name
 * is the interesting part, so drop the type and site suffix.
 */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*-\s*(Wowhead|World of Warcraft).*$/i, '')
    .replace(/\s*-\s*[^-]+?\s*-\s*Forever\s*$/i, '')
    .trim();
}

/**
 * Quick Facts as clean "- Label: value" lines: no glued items, no label
 * without a value ("Icon:"), no empty parenthetical ("Cost: (each)").
 */
export function cleanFacts(text: string): string | undefined {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/^\s*-\s*/, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
    line = line.replace(/^Added in patch\s+(?!:)/i, 'Added in patch: ').replace(/^React:/i, 'Reaction:');
    if (!line) continue;
    const m = /^([^:]{1,40}):\s*(.*)$/.exec(line);
    if (m) {
      const value = m[2]!.trim();
      // A value that is empty, or only a qualifier such as "(each)", has lost its content.
      if (!value || /^\([^)]*\)$/.test(value)) continue;
      line = `${m[1]!.trim()}: ${m[2]!.trim()}`;
    }
    if (!lines.includes(`- ${line}`)) lines.push(`- ${line}`);
  }
  return lines.length ? lines.join('\n') : undefined;
}

/** Page chrome that is never content: buttons, infobox headings, media stubs. */
const CHROME_LINES = /^(View in 3D|Find upgrades\.*|Links|Quick Facts|Screenshots|Videos|Comments|Related|Contribute|Share|Report|Show|Hide|Copy|Edit)$/i;

/** Strip page chrome lines from body text; drop a leading repeat of the title. */
export function cleanBodyText(text: string, title?: string): string | undefined {
  const bare = title?.replace(/\s*-\s*[^-]+$/, '').trim().toLowerCase();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (CHROME_LINES.test(line) || /^-\s*$/.test(line)) continue;
    if (bare && out.every((l) => !l) && (line.toLowerCase() === bare || line.toLowerCase() === title?.toLowerCase())) continue;
    out.push(line);
  }
  const s = tidy(out.join('\n'));
  return s || undefined;
}

// ── Balanced extraction for embedded JS literals ───────

/**
 * Starting at `start` (which must point at `{` or `[`), return the substring
 * up to and including the matching close bracket. Skips over string literals.
 */
export function extractBalanced(src: string, start: number): string | undefined {
  const open = src[start];
  if (open !== '{' && open !== '[') return undefined;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Read a JS string literal at `start` and return its decoded content. */
function readJsString(text: string, start: number): { decoded: string; next: number } {
  const quote = text[start]!;
  let decoded = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      const esc = text[i + 1] ?? '';
      decoded += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc;
      i += 2;
      continue;
    }
    if (ch === quote) return { decoded, next: i + 1 };
    decoded += ch;
    i++;
  }
  return { decoded, next: i };
}

/** A bare (unquoted) object key followed by ':' at this position, if any. */
function bareKeyAt(text: string, i: number): { key: string; next: number } | undefined {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(i));
  if (!m) return undefined;
  return { key: m[1]!, next: i + m[0].length };
}

/**
 * Repair a JS object/array literal so JSON.parse accepts it: quote bare keys,
 * drop trailing commas, turn a bare `undefined` value into null.
 *
 * This must skip string literals. A regex such as /([{,]\s*)(key)\s*:/ also
 * rewrites text that merely looks like a key *inside* a value, and a broken
 * literal degrades to rows=[] silently rather than raising — a whole table
 * disappears with no error anywhere.
 */
export function repairJsObjectLiteral(text: string): string {
  let out = '';
  let depth = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    // String literals are re-encoded as strict JSON and never scanned for keys.
    // Single quotes and backticks are legal JS but not JSON — another way a
    // table could come back silently empty.
    if (ch === '"' || ch === "'" || ch === '`') {
      const { decoded, next } = readJsString(text, i);
      out += JSON.stringify(decoded);
      i = next;
      continue;
    }

    if (ch === '{' || ch === '[') {
      depth++;
      out += ch;
      i++;
      if (ch === '{') {
        const bare = bareKeyAt(text, i);
        if (bare) {
          out += `"${bare.key}":`;
          i = bare.next;
        }
      }
      continue;
    }

    if (ch === '}' || ch === ']') {
      depth--;
      out += ch;
      i++;
      continue;
    }

    if (ch === ',') {
      // Trailing comma: drop it.
      if (depth > 0 && /^\s*[}\]]/.test(text.slice(i + 1))) {
        i++;
        continue;
      }
      out += ch;
      i++;
      const bare = bareKeyAt(text, i);
      if (bare && depth > 0) {
        out += `"${bare.key}":`;
        i = bare.next;
      }
      continue;
    }

    // `undefined` is legal JS but not JSON — only rewrite it in value position.
    if (text.startsWith('undefined', i) && /:\s*$/.test(out)) {
      out += 'null';
      i += 'undefined'.length;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** JSON.parse that also tolerates a few common JS-literal quirks. */
export function lenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(repairJsObjectLiteral(text));
    } catch {
      return undefined;
    }
  }
}

// ── Search ─────────────────────────────────────────────

export interface SearchResult {
  type: string;
  typeId: number;
  id: number;
  name: string;
  quality?: string;
  url: string;
}

/** Parse /search/suggestions-template JSON. */
export function parseSuggestions(
  data: unknown,
  pageUrl: (type: string, id: number) => string,
): SearchResult[] {
  const results = (data as { results?: unknown[] } | undefined)?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const typeId = Number(rec['type']);
    const id = Number(rec['id']);
    const name = typeof rec['name'] === 'string' ? decodeEntities(rec['name']) : undefined;
    if (!Number.isFinite(id) || !name) continue;
    const t = typeById(typeId) ?? (typeof rec['typeName'] === 'string' ? typeByName(rec['typeName']) : undefined);
    const typeName = t?.name ?? (typeof rec['typeName'] === 'string' ? rec['typeName'].toLowerCase() : `type${typeId}`);
    const q = Number(rec['quality']);
    out.push({
      type: typeName,
      typeId,
      id,
      name,
      ...(Number.isInteger(q) && QUALITY_NAMES[q] ? { quality: QUALITY_NAMES[q] } : {}),
      url: pageUrl(t?.path ?? typeName, id),
    });
  }
  return out;
}

// ── Listviews (tables on entity pages and search pages) ─

export interface Listview {
  id: string;
  template?: string;
  rows: Record<string, unknown>[];
}

/** Find every `new Listview({...})` on a Wowhead page. */
export function parseListviews(html: string): Listview[] {
  const out: Listview[] = [];
  const re = /new\s+(?:WH\.)?Listview\s*\(\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const objText = extractBalanced(html, m.index + m[0].length);
    if (!objText) continue;
    const id = /\bid\s*:\s*['"]([^'"]+)['"]/.exec(objText)?.[1];
    const template = /\btemplate\s*:\s*['"]([^'"]+)['"]/.exec(objText)?.[1];
    const dataMatch = /\bdata\s*:\s*\[/.exec(objText);
    let rows: Record<string, unknown>[] = [];
    if (dataMatch) {
      const arrText = extractBalanced(objText, dataMatch.index + dataMatch[0].length - 1);
      const parsed = arrText ? lenientJson(arrText) : undefined;
      if (Array.isArray(parsed)) {
        rows = parsed.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
      }
    }
    if (id) out.push({ id, ...(template ? { template } : {}), rows });
  }
  return out;
}

const KEEP_FIELDS = [
  'id', 'name', 'level', 'minlevel', 'maxlevel', 'reqlevel', 'classs', 'subclass',
  'slot', 'side', 'react', 'type', 'category', 'stack', 'cost', 'count', 'outof',
  'percent', 'skill', 'learnedat', 'colors', 'nreagents', 'reagents', 'location',
  'tag', 'boss', 'classification', 'rank', 'itemrewards', 'xp', 'money', 'avail',
  'quality', 'creates', 'stock', 'itemchoices',
] as const;

/** Reduce a raw listview row to compact, readable fields. */
export function summarizeRow(row: Record<string, unknown>, template?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEEP_FIELDS) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') out[k] = row[k];
  }
  // Item names in listviews are prefixed with a quality digit, e.g. "4Thunderfury".
  if (typeof out['quality'] === 'number') out['quality'] = QUALITY_NAMES[out['quality']] ?? undefined;
  if (out['quality'] === undefined) delete out['quality'];
  if (typeof out['name'] === 'string') {
    let name = out['name'];
    const qm = /^(\d)(\D.*)$/.exec(name);
    if (qm && (template === 'item' || row['classs'] !== undefined || row['slot'] !== undefined)) {
      out['quality'] = QUALITY_NAMES[Number(qm[1])] ?? qm[1];
      name = qm[2]!;
    }
    out['name'] = decodeEntities(name);
  }
  if (typeof row['count'] === 'number' && typeof row['outof'] === 'number' && row['outof'] > 0) {
    out['dropChance'] = `${((row['count'] / row['outof']) * 100).toFixed(2)}%`;
    // Keep the sample size. "100% of 6 kills" and "100% of 30000 kills" must not
    // arrive looking equally authoritative.
    out['samples'] = row['outof'];
    delete out['count'];
    delete out['outof'];
  }
  if (typeof out['cost'] === 'object' && Array.isArray(out['cost']) && typeof out['cost'][0] === 'number') {
    out['cost'] = formatMoney(out['cost'][0] as number);
  }
  // Vendor rows: cost is [[copper, currencies?, items?]].
  if (Array.isArray(out['cost']) && Array.isArray(out['cost'][0]) && typeof out['cost'][0][0] === 'number') {
    const [copper, currencies, items] = out['cost'][0] as [number, unknown?, unknown?];
    out['cost'] = copper > 0 ? formatMoney(copper) : undefined;
    if (Array.isArray(currencies) && currencies.length) out['costCurrencies'] = currencies;
    if (Array.isArray(items) && items.length) out['costItems'] = items;
    if (out['cost'] === undefined) delete out['cost'];
  }
  if (out['side'] !== undefined) {
    out['side'] = { 1: 'Alliance', 2: 'Horde', 3: 'Both' }[out['side'] as number] ?? out['side'];
  }
  return out;
}

// ── Entity page ────────────────────────────────────────

export interface PageInfo {
  title?: string;
  description?: string;
  quickFacts?: string;
  text?: string;
  listviews: Listview[];
  /** Names of every entity the page references, keyed `${typeId}:${id}` (WH.Gatherer data). */
  names?: Record<string, string>;
}

/**
 * Wowhead embeds the name of every entity a page references — reagents, quest
 * rewards, spells — as `WH.Gatherer.addData(typeId, env, {id: {name_enus,...}})`.
 * This is the bulk name source for ids in listview rows: no extra requests.
 */
export function parseGatherer(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /Gatherer\.addData\(\s*(\d+)\s*,\s*\d+\s*,\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const typeId = Number(m[1]);
    const objText = extractBalanced(html, m.index + m[0].length);
    const parsed = objText ? lenientJson(objText) : undefined;
    if (!parsed || typeof parsed !== 'object') continue;
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const rec = v as Record<string, unknown>;
      const name = rec['name_enus'] ?? rec['name'];
      if (typeof name === 'string' && name && typeId !== 29) out[`${typeId}:${id}`] = decodeEntities(name);
    }
  }
  return out;
}

function metaContent(html: string, attr: string, value: string): string | undefined {
  const re = new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  const content = tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : undefined;
  return content ? decodeEntities(content).trim() : undefined;
}

export function parsePage(html: string): PageInfo {
  const titleRaw = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = titleRaw ? cleanTitle(decodeEntities(titleRaw)) : undefined;
  const description = metaContent(html, 'name', 'description') ?? metaContent(html, 'property', 'og:description');

  // Quick Facts infobox: WH.markup.printHtml("[ul][li]...", "infobox-contents-0")
  const names = parseGatherer(html);
  const resolve: RefResolver = (typeId, id) => names[`${typeId}:${id}`];

  let quickFacts: string | undefined;
  const qf = /(?:WH\.)?[Mm]arkup\.printHtml\(\s*("(?:[^"\\]|\\.)*")\s*,\s*["']infobox/.exec(html);
  if (qf) {
    try {
      quickFacts = cleanFacts(markupToText(JSON.parse(qf[1]!) as string, resolve));
    } catch {
      /* ignore */
    }
  }

  // Main body text (description, objectives, comments-free).
  let text: string | undefined;
  const start = html.search(/<div[^>]+class=["'][^"']*\btext\b[^"']*["'][^>]*>/i);
  if (start >= 0) {
    let body = html.slice(start, start + 60_000);
    const end = body.search(/<(div[^>]+id=["'](tabs|lv-|comments|ad-)|h2[^>]*>\s*(Comments|Related|Screenshots|Guides))/i);
    if (end > 0) body = body.slice(0, end);
    body = body
      // Action buttons ("View in 3D", "Find upgrades...", "Links").
      .replace(/<div[^>]+class=["'][^"']*db-action-buttons[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
      // Infobox headings ("Quick Facts", "Screenshots", "Videos"); the facts themselves come from markup.
      .replace(/<tr[^>]+class=["'][^"']*infobox-heading[^"']*["'][^>]*>[\s\S]*?<\/tr>/gi, '')
      // The page heading repeats the title.
      .replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, '')
      // "See if you've already completed this by typing: /run print(...(166))" — a macro, not content.
      .replace(/See if you've already completed this[^<]*(<br\s*\/?>\s*)?<pre[\s\S]*?<\/pre>/gi, '');
    text = cleanBodyText(htmlToText(body), title)?.slice(0, 6000);
  }

  return {
    title,
    description,
    quickFacts,
    text,
    listviews: parseListviews(html),
    ...(Object.keys(names).length ? { names } : {}),
  };
}

// ── Tooltip JSON ───────────────────────────────────────

export interface TooltipInfo {
  name?: string;
  quality?: string;
  icon?: string;
  text: string;
}

export function parseTooltip(data: unknown): TooltipInfo | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const html = typeof d['tooltip'] === 'string' ? d['tooltip'] : '';
  if (!html && !d['name']) return undefined;
  const q = Number(d['quality']);
  return {
    ...(typeof d['name'] === 'string' ? { name: decodeEntities(d['name']) } : {}),
    ...(Number.isInteger(q) && QUALITY_NAMES[q] ? { quality: QUALITY_NAMES[q] } : {}),
    ...(typeof d['icon'] === 'string' ? { icon: d['icon'] } : {}),
    text: htmlToText(html),
  };
}

// ── Item XML (wowhead.com/<env>/item=<id>&xml) ─────────

export function parseItemXml(xml: string): Record<string, unknown> | undefined {
  if (!/<wowhead>/i.test(xml) || /<error>/i.test(xml)) return undefined;
  const tag = (name: string) => {
    const m = new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
    if (!m) return undefined;
    const inner = m[2]!.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
    return { attrs: m[1] ?? '', inner };
  };
  const attr = (attrs: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
  const out: Record<string, unknown> = {};
  const name = tag('name');
  if (name) out['name'] = decodeEntities(name.inner);
  const level = tag('level');
  if (level) out['itemLevel'] = Number(level.inner);
  const quality = tag('quality');
  if (quality) out['quality'] = quality.inner;
  const cls = tag('class');
  const sub = tag('subclass');
  if (cls) out['class'] = cls.inner;
  if (sub) out['subclass'] = sub.inner;
  const slot = tag('inventorySlot');
  if (slot?.inner) out['slot'] = slot.inner;
  const tooltip = tag('htmlTooltip');
  if (tooltip) out['tooltip'] = htmlToText(tooltip.inner);
  const created = tag('createdBy');
  if (created) {
    const spell = /<spell\s[^>]*>/i.exec(created.inner)?.[0];
    if (spell) out['createdBySpell'] = { id: Number(attr(spell, 'id')), name: attr(spell, 'name') };
    const reagents = [...created.inner.matchAll(/<reagent\s[^>]*>/gi)].map((r) => ({
      id: Number(attr(r[0], 'id')),
      name: attr(r[0], 'name'),
      count: Number(attr(r[0], 'count')),
    }));
    if (reagents.length) out['reagents'] = reagents;
  }
  const json = tag('json');
  if (json) {
    const parsed = lenientJson(`{${json.inner}}`);
    if (parsed && typeof parsed === 'object') out['data'] = parsed;
  }
  const equip = tag('jsonEquip');
  if (equip) {
    const parsed = lenientJson(`{${equip.inner}}`);
    if (parsed && typeof parsed === 'object') out['equip'] = parsed;
  }
  return Object.keys(out).length ? out : undefined;
}