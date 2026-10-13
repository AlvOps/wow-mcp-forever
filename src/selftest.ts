#!/usr/bin/env node
/**
 * Live check against Wowhead Forever. Run on the machine that will host the
 * server:  npm run selftest  [optional search term]
 */
import { loadEnv } from './config.js';
import { WowheadClient } from './wowhead/client.js';
import { summarizeRow } from './wowhead/parse.js';
import { typeByName } from './wowhead/types.js';

const env = loadEnv();
const client = new WowheadClient(env);
const term = process.argv[2] ?? 'Defender of Dalaran';
let failures = 0;

function check(label: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
  if (!pass) failures++;
}

const results = await client.search(term, { limit: 5 }).catch((e: Error) => {
  check('search', false, e.message);
  return [];
});
check('search', results.length > 0, results.map((r) => `${r.type} ${r.id} ${r.name}`).join(' | ') || 'no results');

const first = results[0];
if (first) {
  const t = typeByName(first.type)!;
  const tip = await client.tooltip(t, first.id).catch(() => undefined);
  check('tooltip', !!tip, tip ? `${tip.name}: ${tip.text.slice(0, 120).replace(/\n/g, ' / ')}` : 'no tooltip');

  if (t.name === 'item') {
    const xml = await client.itemXml(first.id);
    check('item xml', !!xml, xml ? `ilvl ${xml['itemLevel']}, slot ${xml['slot'] ?? '-'}` : 'no xml');
  }

  try {
    const page = await client.page(t, first.id);
    check('page', !!page.title, `${page.title} | quick facts: ${page.quickFacts ? 'yes' : 'no'}`);
    check(
      'page tables',
      page.listviews.length > 0,
      page.listviews.map((lv) => `${lv.id}(${lv.rows.length})`).join(', ') || 'none found',
    );
    const lv = page.listviews.find((l) => l.rows.length > 0);
    if (lv) console.log(`      sample ${lv.id}:`, JSON.stringify(summarizeRow(lv.rows[0]!, lv.template)));
  } catch (e) {
    check('page', false, (e as Error).message);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
