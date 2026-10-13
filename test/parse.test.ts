import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTitle,
  formatMoney,
  htmlToText,
  lenientJson,
  markupToText,
  parseItemXml,
  parsePage,
  parseSuggestions,
  parseTooltip,
  summarizeRow,
} from '../src/wowhead/parse.js';
import { parseAreaNames } from '../src/wowhead/zones.js';
import { ITEM_PAGE, ITEM_XML, SUGGESTIONS, TOOLTIP } from './fixtures.js';

const url = (p: string, id: number) => `https://www.wowhead.com/forever/${p}=${id}`;

test('parseSuggestions maps types, quality and urls', () => {
  const r = parseSuggestions(SUGGESTIONS, url);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], {
    type: 'item', typeId: 3, id: 279841, name: 'Defender of Dalaran', quality: 'Rare',
    url: 'https://www.wowhead.com/forever/item=279841',
  });
  assert.equal(r[1]!.type, 'npc');
  assert.equal(r[2]!.name, 'Defend the Tower & Gate');
});

test('parseSuggestions tolerates junk', () => {
  assert.deepEqual(parseSuggestions(undefined, url), []);
  assert.deepEqual(parseSuggestions({ results: [null, { id: 'x' }] }, url), []);
});

test('parsePage extracts title, facts, text and listviews', () => {
  const p = parsePage(ITEM_PAGE);
  assert.equal(p.title, 'Defender of Dalaran - Item');
  assert.match(p.description!, /looted from Archmage Arugal/);
  assert.match(p.quickFacts!, /- Item Level: 42/);
  assert.match(p.quickFacts!, /Sells for 1g 23s 45c/);
  assert.match(p.text!, /guardians of the city & its towers/);
  assert.deepEqual(p.listviews.map((l) => [l.id, l.rows.length]), [['dropped-by', 2], ['reagent-for', 1]]);
});

test('summarizeRow computes drop chance and strips quality prefix', () => {
  const p = parsePage(ITEM_PAGE);
  const npc = summarizeRow(p.listviews[0]!.rows[0]!, 'npc');
  assert.equal(npc['name'], 'Archmage Arugal');
  assert.equal(npc['dropChance'], '12.00%');
  assert.equal(npc['count'], undefined);
  const item = summarizeRow(p.listviews[1]!.rows[0]!, 'item');
  assert.equal(item['name'], 'Battle Spaulders');
  assert.equal(item['quality'], 'Rare');
});

test('parseTooltip turns html into text', () => {
  const t = parseTooltip(TOOLTIP)!;
  assert.equal(t.quality, 'Rare');
  assert.match(t.text, /Binds when picked up/);
  assert.match(t.text, /1450 Armor\n\+7 Stamina/);
  assert.equal(parseTooltip({ error: 'x' }), undefined);
});

test('parseItemXml reads core fields', () => {
  const x = parseItemXml(ITEM_XML)!;
  assert.equal(x['name'], 'Defender of Dalaran');
  assert.equal(x['itemLevel'], 42);
  assert.equal(x['slot'], 'Off Hand');
  assert.equal(x['subclass'], 'Shield');
  assert.deepEqual(x['equip'], { armor: 1450, sta: 7 });
  assert.equal(parseItemXml('<wowhead><error>Item not found!</error></wowhead>'), undefined);
});

test('summarizeRow keeps the sample size behind a drop chance', () => {
  // "100% of 6 kills" and "100% of 30000 kills" must not look alike.
  const row = summarizeRow({ name: 'Weak Wolf', count: 6, outof: 6 });
  assert.equal(row['dropChance'], '100.00%');
  assert.equal(row['samples'], 6);
  assert.equal(row['count'], undefined);
});

test('cleanTitle drops the type and site suffix', () => {
  assert.equal(cleanTitle('Hogger - NPC - Forever'), 'Hogger');
  assert.equal(cleanTitle('Defender of Dalaran - Item - Forever'), 'Defender of Dalaran');
  assert.equal(cleanTitle('Thunderfury, Blessed Blade of the Windseeker - Item - Forever'),
    'Thunderfury, Blessed Blade of the Windseeker');
  // A listing page has no type suffix and must be left alone.
  assert.equal(cleanTitle('Forever Items'), 'Forever Items');
  assert.equal(cleanTitle('Some Page - Wowhead'), 'Some Page');
});

test('repairJsObjectLiteral never rewrites inside string values', () => {
  // The old regex-based repair turned this value into garbage, silently emptying
  // a whole table. Text that merely looks like a key must survive untouched.
  const literal = `{id:1,name:'say {a: 1} and, "b": 2',trailing:1,}`;
  const parsed = lenientJson(literal) as Record<string, unknown>;
  assert.equal(parsed['name'], 'say {a: 1} and, "b": 2');
  assert.equal(parsed['id'], 1);
  assert.equal(parsed['trailing'], 1);
  assert.deepEqual(lenientJson('{a:undefined}'), { a: null });
});

test('lenientJson still parses strict JSON and gives up quietly on junk', () => {
  assert.deepEqual(lenientJson('{"a":1}'), { a: 1 });
  assert.equal(lenientJson('not json at all'), undefined);
});

test('text helpers', () => {
  assert.equal(formatMoney(10203), '1g 2s 3c');
  assert.equal(markupToText('[ul][li]Start: [npc=123][/li][/ul]'), '- Start: npc #123');
  assert.equal(htmlToText('a<br>b &amp; <span>c</span>'), 'a\nb & c');
});

// ── Area names: listview rows give numeric ids, so a model handed only those
//    invents the zone names. This table is what makes them sourced. ──

test('parseAreaNames reads the area id -> name table', () => {
  // Shape taken from a live nether.wowhead.com/forever/data/global response,
  // including the other setPageData calls that surround it.
  const global = [
    'WH.setPageData("maps.continents",{"1":"Eastern Kingdoms"});',
    'WH.setPageData("wow.area.names",{"-6":"Kalimdor","-3":"Eastern Kingdoms","45":"Arathi Highlands",',
    '"400":"Thousand Needles","405":"Desolace","796":"Scarlet Monastery","16591":"Riverglades"});',
    'WH.setPageData("url.alternatePathCommands",{"x":{"1":"y"}});',
  ].join('');
  const m = parseAreaNames(global);
  assert.equal(m.size, 7);
  assert.equal(m.get(405), 'Desolace');
  assert.equal(m.get(45), 'Arathi Highlands');
  assert.equal(m.get(16591), 'Riverglades');
  // negative ids are continents/regions and are valid rows too
  assert.equal(m.get(-3), 'Eastern Kingdoms');
  assert.equal(m.get(-6), 'Kalimdor');
  assert.equal(m.get(999999), undefined);
});

test('parseAreaNames keeps braces that appear inside a name', () => {
  const m = parseAreaNames('WH.setPageData("wow.area.names",{"1":"Brace { City","2":"Two"})');
  assert.equal(m.size, 2);
  assert.equal(m.get(1), 'Brace { City');
});

test('parseAreaNames degrades to an empty map instead of throwing', () => {
  assert.equal(parseAreaNames('WH.setPageData("something.else",{"1":"x"})').size, 0);
  assert.equal(parseAreaNames('WH.setPageData("wow.area.names", not json)').size, 0);
  assert.equal(parseAreaNames('WH.setPageData("wow.area.names",').size, 0);
  assert.equal(parseAreaNames('').size, 0);
});
