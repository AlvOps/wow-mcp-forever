/**
 * User-facing shaping: what reaches the model must be names, levels, zones
 * and links — never bare ids, internal field names or scraped page chrome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/config.js';
import { WowheadClient } from '../src/wowhead/client.js';
import { shapePage } from '../src/tools.js';
import { cleanBodyText, cleanFacts, markupToText, parseGatherer, parsePage } from '../src/wowhead/parse.js';
import { ANSWER_GUIDANCE, joinZones, resolveFacts } from '../src/present.js';

const env = loadEnv({});

const GLOBAL =
  'WH.setPageData("wow.area.names",{"440":"Tanaris","1377":"Silithus","405":"Desolace","-1":"Azeroth"});' +
  'WH.setPageData("wow.skill.names",{"171":"Alchemy"});' +
  'WH.setPageData("wow.npc.classifications",{"0":"Normal","1":"Elite"});' +
  'WH.setPageData("wow.currency.namesAndIcons",{"1792":{"id":1792,"name":"Honor Points"}});';

/** Routes by URL: the global name tables, tooltips for a few items, 404 otherwise. */
function routedClient(tooltips: Record<string, string> = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/data/global')) return new Response(GLOBAL, { status: 200 });
    const m = /tooltip\/item\/(\d+)/.exec(u);
    if (m && tooltips[m[1]!]) return new Response(JSON.stringify({ name: tooltips[m[1]!], tooltip: '' }), { status: 200 });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const c = new WowheadClient(env, { fetch: impl, tokens: { getOrMint: async () => 'stub' } });
  return { c, calls };
}

const PAGE_HTML = `<html><head><title>Greater Healing Potion - Item - World of Warcraft: Forever</title></head><body>
<script>WH.Gatherer.addData(3, 16, {"3372":{"name_enus":"Leaded Vial","quality":1},"2692":{"name_enus":"Hot Spices","quality":1},"280766":{"name_enus":"Satchel of Potions","quality":2}});
WH.Gatherer.addData(29, 16, {"134832":{"name":"inv_potion_52","icon":"inv_potion_52"}});</script>
<div class="text">
<div class="db-action-buttons"><a href="javascript:">View in 3D</a><a href="javascript:">Find upgrades...</a><a id="open-links-button">Links</a></div>
<table class="infobox"><tr class="infobox-heading"><th>Quick Facts</th></tr><tr><td><div id="infobox-contents-0"></div>
<script>WH.markup.printHtml("[ul][li]Cost: [money=500-526][color=q0] (each)[\\/color][\\/li][li]Side: None[\\/li][li][tooltip name=wowhead-guid1]Consumed when used[\\/tooltip][span tooltip=wowhead-guid1 class=tip]Consumable[\\/span][\\/li][li]Added in patch [acronym=\\"1.60.1.69876\\"]1.60.1[\\/acronym][\\/li][li class=icon-db-link]Icon: [icondb=134832 name=true][\\/li][\\/ul]", "infobox-contents-0", {});</script>
</td></tr></table>
<table><tr class="infobox-heading"><th id="infobox-screenshots">Screenshots</th></tr></table>
<table><tr class="infobox-heading"><th id="infobox-videos">Videos</th></tr></table>
<h1>Greater Healing Potion</h1>
<h2>Vendor Locations</h2><div>This item can be purchased in <a href="javascript:">Arathi Highlands</a>
   &nbsp;(2), <a>Desolace</a>
   .</div>
</div>
<div id="tabs-generic"></div>
<script>
new Listview({template: 'npc', id: 'dropped-by', data: [
  {"id":15817,"name":"Qiraji Brigadier General Pax-lish","minlevel":60,"maxlevel":60,"react":[-1,-1],"type":10,"location":[440,1377,-1],"classification":1,"count":5,"outof":52},
  {"id":2380,"name":"Nandar Branson","minlevel":55,"maxlevel":58,"react":[1,-1],"type":7,"location":[405],"classification":0,"tag":"Alchemy Supplies","count":1,"outof":100}]});
new Listview({template: 'spell', id: 'created-by-spell', data: [
  {"id":1244434,"name":"Greater Healing Potion","level":0,"skill":[171],"learnedat":175,"colors":[0,175,195,215],"creates":[1710,1,1],"reagents":[[3372,1],[2692,3],[3357,1]]}]});
new Listview({template: 'quest', id: 'reward-from-q', data: [
  {"id":95809,"name":"Heartwoven","level":31,"reqlevel":24,"side":2,"type":81,"category":16732,"itemrewards":[[2459,1],[280766,1]],"xp":3150}]});
new Listview({template: 'npc', id: 'sold-by', data: [
  {"id":2380,"name":"Nandar Branson","minlevel":34,"maxlevel":34,"react":[1,-1],"type":7,"stack":1,"cost":[[500,[[1792,10]]]],"location":[405],"tag":"Alchemy Supplies","classification":0,"stock":3}]});
</script></body></html>`;

const INTERNAL_KEYS = [
  'id', 'react', 'classification', 'type', 'typeId', 'location', 'locations', 'minlevel', 'maxlevel',
  'skill', 'colors', 'category', 'reqlevel', 'tag', 'learnedat', 'itemrewards', 'classs', 'subclass', 'slot',
];

async function shaped(tooltips?: Record<string, string>) {
  const { c, calls } = routedClient(tooltips);
  const info = parsePage(PAGE_HTML);
  const out = await shapePage(info, 'https://www.wowhead.com/forever/item=1710', { maxRows: 10 }, c);
  return { out, calls };
}

const table = (out: Awaited<ReturnType<typeof shaped>>['out'], id: string) => out.tables.find((t) => t.table === id)!;

test('parseGatherer reads the names a page embeds for the ids it references', () => {
  const names = parseGatherer(PAGE_HTML);
  assert.equal(names['3:3372'], 'Leaded Vial');
  assert.equal(names['3:280766'], 'Satchel of Potions');
  assert.equal(names['29:134832'], undefined, 'icon records are not entity names');
});

test('crafting reagents are resolved to names: page data first, tooltip for the rest', async () => {
  const { out, calls } = await shaped({ '3357': 'Liferoot', '1710': 'Greater Healing Potion', '2459': 'Swiftness Potion' });
  const row = table(out, 'created-by-spell').rows[0]!;
  assert.equal(row['reagents'], '1x Leaded Vial, 3x Hot Spices, 1x Liferoot');
  assert.equal(row['creates'], '1x Greater Healing Potion');
  assert.equal(row['profession'], 'Alchemy (175)');
  assert.ok(calls.some((u) => u.includes('tooltip/item/3357')), 'unknown reagent fetched by tooltip');
  assert.ok(!calls.some((u) => u.includes('tooltip/item/3372')), 'page-named reagent needs no request');

  const quest = table(out, 'reward-from-q').rows[0]!;
  assert.equal(quest['rewards'], '1x Swiftness Potion, 1x Satchel of Potions');
});

test('an unresolvable reagent never yields a half-known list or a bare id', async () => {
  const { out } = await shaped({}); // no tooltip names at all
  const row = table(out, 'created-by-spell').rows[0]!;
  assert.doesNotMatch(String(row['reagents']), /Leaded Vial|\d{3,}|\[/);
  assert.match(String(row['reagents']), /see the linked page/);
});

test('shaped rows carry no internal keys and no id arrays', async () => {
  const { out } = await shaped({ '3357': 'Liferoot', '1710': 'Greater Healing Potion', '2459': 'Swiftness Potion' });
  for (const t of out.tables) {
    for (const row of t.rows) {
      for (const k of INTERNAL_KEYS) assert.ok(!(k in row), `${t.table} row has internal key ${k}`);
      for (const v of Object.values(row)) assert.ok(!Array.isArray(v), `${t.table} row has an array value`);
      assert.match(String(row['url']), /^https:\/\/www\.wowhead\.com\/forever\/[a-z-]+=\d+$/);
    }
  }
  const pax = table(out, 'dropped-by').rows[0]!;
  assert.equal(pax['zone'], 'Tanaris or Silithus', 'one display string, continents dropped');
  assert.equal(pax['level'], '60');
  assert.equal(pax['rank'], 'Elite');
  const vendor = table(out, 'sold-by').rows[0]!;
  assert.equal(vendor['friendlyTo'], 'Alliance');
  assert.equal(vendor['subtitle'], 'Alchemy Supplies');
  assert.equal(vendor['cost'], '5s + 10x Honor Points');
  assert.equal(table(out, 'dropped-by').rows[1]!['level'], '55-58');
});

test('quickFacts render as clean Label: value lines', async () => {
  const { out } = await shaped();
  assert.equal(
    out.quickFacts,
    '- Cost: 5s to 5s 26c (each)\n- Side: None\n- Consumable\n- Added in patch: 1.60.1',
  );
  assert.doesNotMatch(String(out.quickFacts), /Icon:|usedConsumable|1\.60\.1Icon/);
  assert.equal(cleanFacts('- Cost: (each)\n- Icon:\n- Side: None'), '- Side: None');
});

test('body text drops navigation chrome and keeps the prose', async () => {
  const { out } = await shaped();
  const text = String(out.text);
  for (const chrome of ['View in 3D', 'Find upgrades', 'Links', 'Quick Facts', 'Screenshots', 'Videos']) {
    assert.ok(!text.includes(chrome), `text still contains "${chrome}"`);
  }
  assert.match(text, /This item can be purchased in Arathi Highlands \(2\), Desolace\./);
  assert.equal(cleanBodyText('Links\nQuick Facts\nReal prose.'), 'Real prose.');
});

test('markup references resolve to names, and unknown ones never surface as ids', () => {
  const names: Record<string, string> = { '1:123': 'Hogger' };
  const s = markupToText('[ul][li]Start: [npc=123][/li][li]End: [npc=999][/li][/ul]', (t, id) => names[`${t}:${id}`]);
  assert.match(s, /Start: Hogger/);
  // The unknown one is left as a marker for the tool layer, which names it or drops it.
  const final = resolveFacts(s, new Map())!;
  assert.equal(final, '- Start: Hogger');
  assert.equal(resolveFacts(s, new Map([['1:999', 'Gamon']])), '- Start: Hogger\n- End: Gamon');
});

test('payload ends with answerGuidance and then source', async () => {
  const { out } = await shaped();
  const keys = Object.keys(out);
  assert.equal(keys.at(-1), 'source');
  assert.equal(keys.at(-2), 'answerGuidance');
  assert.equal(out.answerGuidance, ANSWER_GUIDANCE);
});

test('joinZones builds one human string', () => {
  assert.equal(joinZones(['Thousand Needles']), 'Thousand Needles');
  assert.equal(joinZones(['Tanaris', 'Silithus']), 'Tanaris or Silithus');
  assert.equal(joinZones(['A', 'B', 'C', 'A']), 'A, B or C');
});
