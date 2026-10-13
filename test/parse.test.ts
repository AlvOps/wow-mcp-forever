import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMoney,
  htmlToText,
  markupToText,
  parseItemXml,
  parsePage,
  parseSuggestions,
  parseTooltip,
  summarizeRow,
} from '../src/wowhead/parse.js';
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

test('text helpers', () => {
  assert.equal(formatMoney(10203), '1g 2s 3c');
  assert.equal(markupToText('[ul][li]Start: [npc=123][/li][/ul]'), '- Start: npc #123');
  assert.equal(htmlToText('a<br>b &amp; <span>c</span>'), 'a\nb & c');
});
