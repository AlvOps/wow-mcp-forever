/**
 * forever_browse: category listings. Fixtures mirror the three encodings seen
 * live on /forever/ listing pages (inline Listview data, data held in a page
 * variable, JSON script) plus WH.Gatherer.addData stat records.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEAD_PATHS,
  LISTING_SPECS,
  normalizeBrowsePath,
  parseGathererRecords,
  parseListingListviews,
  parseListingPage,
  specForPath,
} from '../src/wowhead/listing.js';
import { applyWhere, buildRecords, parseSort, shapeBrowse, sortRecords } from '../src/browse.js';
import { finish } from '../src/present.js';
import type { GlobalNames } from '../src/wowhead/zones.js';
import { SWORDS_HTML } from './fixtures.js';

/** Shape (B): inline, quoted-key Listview with Wowhead's own truncation note (as on /forever/npcs). */
export const NPCS_HTML = `<html><head><title>Forever NPCs</title></head><body>
<script>Filter.init({"page":"npcs","facets":[{"id":"min-level","type":"text"},{"id":"max-level","type":"text"}],"activeFacets":[]});</script>
<div id="lv-npcs" class="listview"></div><script>new Listview({"_truncated":1,"note":"15,205 NPCs found (1,000 displayed) - Try filtering your results","sort":["popularity"],"id":"npcs","template":"npc","data":[
{"boss":0,"classification":1,"id":448,"location":[12],"maxlevel":11,"minlevel":11,"name":"Hogger","react":[-1,-1],"tag":null,"type":7,"popularity":4000},
{"boss":0,"classification":0,"id":2,"location":[12],"maxlevel":5,"minlevel":3,"name":"Kobold Vermin","react":[-1,-1],"tag":null,"type":7,"popularity":20}]});</script></body></html>`;

/** JSON-script encoding (as on /forever/zones and /forever/achievements). */
const ZONES_HTML = `<title>Forever Zones</title>
<script type="application/json" id="data.page.listPage.gatherer">[]</script>
<script type="application/json" id="data.page.listPage.listviews">[{"id":"zones","template":"zone","data":[{"id":209,"name":"Shadowfang Keep","minlevel":22,"maxlevel":30,"reqlevel":11,"popularity":2479},{"id":12,"name":"Elwynn Forest","minlevel":1,"maxlevel":10}]}]</script>`;

/** Gatherer records only, no listview: the records ARE the rows. */
const GATHERER_ONLY_HTML = `<title>Forever Achievements</title><script>WH.Gatherer.addData(10, 16, {"64283":{"name_enus":"Played in the {Beta}","icon":"inv_misc_gift_01"},"62054":{"name_enus":"Lord Valthalak Laid to Rest","icon":"x"}});</script>`;

const GLOBALS: GlobalNames = {
  areas: new Map([[12, 'Elwynn Forest']]),
  skills: new Map(),
  classifications: new Map([[1, 'Elite']]),
  currencies: new Map(),
} as unknown as GlobalNames;

function ctxFor(page: ReturnType<typeof parseListingPage>) {
  const names = new Map<string, string>();
  for (const [t, recs] of page.gatherer) for (const [id, r] of recs) if (typeof r['name_enus'] === 'string') names.set(`${t}:${id}`, r['name_enus']);
  return { globals: GLOBALS, names, pageUrl: (p: string, id: number) => `https://www.wowhead.com/forever/${p}=${id}` };
}

function browse(html: string, path: string, opts: Partial<Parameters<typeof shapeBrowse>[4]> = {}) {
  const page = parseListingPage(html);
  return shapeBrowse(page, specForPath(path), path, `https://www.wowhead.com/forever/${path}`, { requestedFilters: [], ...opts }, ctxFor(page));
}

const FORBIDDEN = ['react', 'classification', 'type', 'typeId', 'location', 'minlevel', 'maxlevel', 'skill', 'colors', 'id', 'jsonequip'];
function forbiddenKeys(v: unknown, found: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => forbiddenKeys(x, found));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN.includes(k)) found.push(k);
      forbiddenKeys(x, found);
    }
  }
  return found;
}

// ── Parsing ────────────────────────────────────────────

test('shape A: addData records carry the full jsonequip stat block (balanced-brace scan)', () => {
  const g = parseGathererRecords(SWORDS_HTML);
  assert.deepEqual([...g.keys()], [3], 'icon data (type 29) is not an entity type');
  const blade = g.get(3)!.get('100')!;
  assert.equal(blade['name_enus'], 'Blade {of} Braces', 'braces inside a value do not end the object');
  const eq = blade['jsonequip'] as Record<string, number>;
  assert.deepEqual([eq['dps'], eq['speed'], eq['dmgmin1'], eq['dmgmax1'], eq['reqlevel'], eq['sellprice']], [20.5, 2.3, 30, 64, 18, 9792]);
  assert.equal(g.get(3)!.size, 4);
});

test('listview rows held in a page variable are resolved; the gallery copy is not', () => {
  const lvs = parseListingListviews(SWORDS_HTML);
  const items = lvs.find((l) => l.id === 'items')!;
  assert.equal(items.rows.length, 5);
  assert.equal(items.truncated, undefined);
  assert.equal(lvs.find((l) => l.id === 'itemsgallery')!.rows.length, 0);
});

test('shape B: inline quoted-key Listview, with Wowhead truncation note surfaced', () => {
  const [lv] = parseListingListviews(NPCS_HTML);
  assert.equal(lv!.id, 'npcs');
  assert.equal(lv!.template, 'npc');
  assert.equal(lv!.rows.length, 2);
  assert.equal(lv!.truncated, true);
  assert.equal(lv!.note, '15,205 NPCs found (1,000 displayed) - Try filtering your results');
  assert.equal(lv!.totalFound, 15205);
});

test('a `note` inside a data row is not mistaken for the table note', () => {
  const html = `new Listview({id: 'npcs', template: 'npc', data: [{"id":1,"name":"A","note":"10 things found"}]});`;
  const [lv] = parseListingListviews(html);
  assert.equal(lv!.note, undefined);
  assert.equal(lv!.totalFound, undefined);
  assert.equal(lv!.rows.length, 1);
});

test('JSON-script listviews (zones/achievements encoding) are parsed', () => {
  const page = parseListingPage(ZONES_HTML);
  assert.equal(page.listviews[0]!.id, 'zones');
  assert.equal(page.listviews[0]!.rows.length, 2);
});

test('Filter.init: applied path filters and accepted filter names are read from the page', () => {
  const page = parseListingPage(SWORDS_HTML);
  assert.deepEqual(page.activeFilters, ['min-req-level:0', 'max-req-level:20']);
  assert.deepEqual(page.supportedFilters, ['min-req-level', 'max-req-level', 'quality']);
  assert.deepEqual(parseListingPage(NPCS_HTML).activeFilters, []);
});

// ── Type map ───────────────────────────────────────────

test('type map: each listing path reads the right gatherer type id', () => {
  assert.equal(specForPath('items/weapons/one-handed-swords')!.gathererType, 3);
  assert.equal(specForPath('items')!.entity, 'item');
  for (const p of ['talents', 'abilities', 'profession-spells']) assert.equal(specForPath(p)!.gathererType, 6, p);
  assert.equal(specForPath('hunter-pets')!.refType, 6, 'pet abilities are spells');
  assert.equal(specForPath('achievements')!.gathererType, 10);
  assert.equal(specForPath('item-sets')!.refType, 3, 'set pieces are items');
  for (const p of ['npcs', 'objects', 'zones', 'factions']) {
    assert.equal(specForPath(p)!.gathererType, undefined, `${p} is listview-only`);
  }
  assert.equal(new Set(LISTING_SPECS.map((s) => s.prefix)).size, LISTING_SPECS.length, 'prefixes are unique');
  assert.equal(specForPath('items-of-power'), undefined, 'prefix match is per segment');
  assert.ok(DEAD_PATHS['pet-species'] && DEAD_PATHS['skill-spells']);
});

test('path normaliser is forgiving: URLs, filters in the path, raw filter strings', () => {
  assert.deepEqual(
    normalizeBrowsePath('https://www.wowhead.com/forever/items/weapons/one-handed-swords/min-req-level:0/max-req-level:20'),
    { path: 'items/weapons/one-handed-swords', filters: ['min-req-level:0', 'max-req-level:20'] },
  );
  assert.deepEqual(normalizeBrowsePath('/forever/Items/Weapons/', 'min-req-level:0/max-req-level:20'), {
    path: 'items/weapons',
    filters: ['min-req-level:0', 'max-req-level:20'],
  });
  assert.deepEqual(normalizeBrowsePath('items', ['max-req-level:20', 'max-req-level=30']).filters, ['max-req-level:30']);
  assert.throws(() => normalizeBrowsePath('items/<script>'), /Invalid path segment/);
  assert.throws(() => normalizeBrowsePath('items', ['nonsense']), /Invalid filter/);
});

// ── Sort / where / honesty ─────────────────────────────

test('sort by a numeric stat (dps desc); random-suffix variants folded; rows without the stat last', () => {
  const page = parseListingPage(SWORDS_HTML);
  const built = buildRecords(page, specForPath('items'));
  assert.equal(built.records.length, 4);
  assert.equal(built.variantsFolded, 1);
  const sorted = sortRecords(built.records, parseSort('dps desc'), 'item');
  assert.deepEqual(sorted.map((r) => r.row['name']), ['Blade {of} Braces', 'Notched Shortsword', 'Worn Shortsword', 'Monster - Training Sword']);
  const asc = sortRecords(built.records, parseSort({ field: 'dps', order: 'asc' }), 'item');
  assert.deepEqual(asc.map((r) => r.row['name']).at(-1), 'Monster - Training Sword', 'no dps sorts last in either order');
  assert.deepEqual(parseSort('-reqlevel'), { key: 'reqlevel', label: 'reqlevel', order: 'desc' });
  assert.deepEqual(parseSort('requiredLevel asc'), { key: 'reqlevel', label: 'requiredLevel', order: 'asc' });
});

test('shaped item rows: user-facing names, levels as text, stats as numbers, one zone, a url', () => {
  const body = browse(SWORDS_HTML, 'items/weapons/one-handed-swords', { sort: 'dps desc', limit: 2 });
  const rows = body['rows'] as Record<string, unknown>[];
  assert.deepEqual(rows[0], {
    name: 'Blade {of} Braces',
    quality: 'Rare',
    url: 'https://www.wowhead.com/forever/item=100',
    itemLevel: '23',
    requiredLevel: '18',
    slot: 'One-Hand',
    dps: 20.5,
    speed: 2.3,
    damageMin: 30,
    damageMax: 64,
    stats: { stamina: 5, agility: 3 },
    obtainedBy: 'Drop',
    from: 'Hogger',
    zone: 'Elwynn Forest',
    sellPrice: '97s 92c',
  });
  assert.equal(body['rowsReturned'], 2);
  assert.equal(body['moreRows'], 1);
  assert.deepEqual(forbiddenKeys(body), []);
});

test('local `where` filter reduces rows and reports rowsFilteredOut; no reqlevel counts as 0 for items', () => {
  const body = browse(SWORDS_HTML, 'items/weapons/one-handed-swords', { where: { reqlevel: { lte: 10 } } });
  const names = (body['rows'] as Record<string, unknown>[]).map((r) => r['name']);
  assert.deepEqual(names, ['Notched Shortsword', 'Worn Shortsword'], 'Worn Shortsword has no reqlevel = no requirement');
  assert.equal(body['rowsMatched'], 2);
  assert.equal(body['rowsFilteredOut'], 1);
  // String operators and quality names are accepted too.
  const q = browse(SWORDS_HTML, 'items', { where: { dps: '>=12', quality: { gte: 'Uncommon' } }, includeNoSource: true });
  assert.equal(q['rowsMatched'], 2);
  assert.match(String(q['whereNote']), /1 lacked dps/, 'a row with no value is reported, not silently dropped');
});

test('a `where` that empties the list says so instead of looking like "nothing exists"', () => {
  const body = browse(SWORDS_HTML, 'items', { where: { dps: { gt: 1000 } } });
  assert.deepEqual(body['rows'], []);
  assert.equal(body['emptyBecauseOfFilter'], true);
  assert.equal(body['rowsFilteredOut'], 3);
  assert.match(String(body['filterNote']), /DOES have entries/);
});

test('items with no known source are hidden by default, counted, and available on request', () => {
  const body = browse(SWORDS_HTML, 'items', { sort: 'level desc' });
  const names = (body['rows'] as Record<string, unknown>[]).map((r) => r['name']);
  assert.ok(!names.includes('Monster - Training Sword'), 'NPC-only gear cannot top a ranking');
  assert.equal(body['noSourceHidden'], 1);
  assert.match(String(body['noSourceNote']), /includeNoSource/);
  const all = browse(SWORDS_HTML, 'items', { sort: 'level desc', includeNoSource: true });
  assert.equal((all['rows'] as Record<string, unknown>[])[0]!['name'], 'Monster - Training Sword');
  assert.equal(all['noSourceHidden'], undefined);
  // Not applied outside items.
  assert.equal(browse(NPCS_HTML, 'npcs')['noSourceHidden'], undefined);
});

test('path filters: only claimed when Wowhead reports them applied', () => {
  const ok = browse(SWORDS_HTML, 'items/weapons/one-handed-swords', { requestedFilters: ['min-req-level:0', 'max-req-level:20'] });
  assert.deepEqual(ok['filtersApplied'], ['min-req-level:0', 'max-req-level:20']);
  assert.equal(ok['filtersNotApplied'], undefined);
  const ignored = browse(NPCS_HTML, 'npcs', { requestedFilters: ['max-req-level:20'] });
  assert.equal(ignored['filtersApplied'], undefined);
  assert.deepEqual(ignored['filtersNotApplied'], ['max-req-level:20']);
  assert.match(String(ignored['pathFilterNote']), /NOT narrowed.*accepts: min-level, max-level/);
});

test('npcs: truncation note and totals are in the payload; npc rows are shaped', () => {
  const body = browse(NPCS_HTML, 'npcs', { sort: 'maxlevel desc' });
  assert.equal(body['truncated'], true);
  assert.equal(body['totalOnWowhead'], 15205);
  assert.match(String(body['truncationNote']), /15,205 NPCs found \(1,000 displayed\)/);
  const rows = body['rows'] as Record<string, unknown>[];
  assert.deepEqual(rows[0], { name: 'Hogger', url: 'https://www.wowhead.com/forever/npc=448', level: '11', rank: 'Elite', zone: 'Elwynn Forest' });
  assert.deepEqual(forbiddenKeys(body), []);
});

test('shape A fallback: a page with only gatherer records still lists them', () => {
  const body = browse(GATHERER_ONLY_HTML, 'achievements');
  const rows = body['rows'] as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => r['name']).sort(), ['Lord Valthalak Laid to Rest', 'Played in the {Beta}']);
  assert.match(String(rows[0]!['url']), /\/forever\/achievement=\d+$/);
});

test('JSON-script zones listing is shaped; source stays last after finish()', () => {
  const body = browse(ZONES_HTML, 'zones', { sort: 'reqlevel desc' });
  const out = finish(body, { label: 'Wowhead: WoW Forever', url: 'https://www.wowhead.com/forever/zones' });
  const keys = Object.keys(out);
  assert.equal(keys.at(-1), 'source');
  assert.equal(keys.at(-2), 'answerGuidance');
  assert.deepEqual((out['rows'] as Record<string, unknown>[])[0], { name: 'Shadowfang Keep', url: 'https://www.wowhead.com/forever/zone=209', level: '22-30' });
  assert.deepEqual(forbiddenKeys(out), []);
});

test('rows cap at 200 whatever limit is asked for', () => {
  const rows = Array.from({ length: 300 }, (_, i) => `{"id":${i + 1},"name":"N${i}","minlevel":1,"maxlevel":1}`).join(',');
  const html = `new Listview({id: 'npcs', template: 'npc', data: [${rows}]});`;
  const body = browse(html, 'npcs', { limit: 999 });
  assert.equal((body['rows'] as unknown[]).length, 200);
  assert.equal(body['moreRows'], 100);
});

test('applyWhere with no conditions is a no-op', () => {
  const built = buildRecords(parseListingPage(SWORDS_HTML), specForPath('items'));
  assert.equal(applyWhere(built.records, {}, 'item').removed, 0);
});
