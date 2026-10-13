/**
 * End-to-end: start the real server over stdio, pointed at a fake Wowhead,
 * and call every tool through an MCP client.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ITEM_PAGE, ITEM_XML, SUGGESTIONS, SUGGESTIONS_NEWS_FIRST, SUGGESTIONS_NEWS_ONLY, SWORDS_HTML, TOOLTIP, ZONE_PAGE } from './fixtures.js';

let fake: Server;
let client: Client;
const hits: string[] = [];

before(async () => {
  fake = createServer((req, res) => {
    const u = req.url ?? '';
    hits.push(u);
    if (u.startsWith('/forever/search/suggestions-template')) {
      if (/hall/i.test(u)) return res.end(JSON.stringify(SUGGESTIONS_NEWS_FIRST));
      if (/preview/i.test(u)) return res.end(JSON.stringify(SUGGESTIONS_NEWS_ONLY));
      return res.end(JSON.stringify(SUGGESTIONS));
    }
    if (u === '/forever/zone=16919') return res.end(ZONE_PAGE);
    if (u.startsWith('/forever/tooltip/item/279841')) return res.end(JSON.stringify(TOOLTIP));
    if (u === '/forever/item=279841&xml') return res.end(ITEM_XML);
    if (u === '/forever/item=279841') return res.end(ITEM_PAGE);
    if (u === '/forever/items/weapons/one-handed-swords/min-req-level:0/max-req-level:20') return res.end(SWORDS_HTML);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', '--stdio'],
      env: {
        ...(process.env as Record<string, string>),
        WOWHEAD_BASE_URL: base,
        WOWHEAD_TOOLTIP_URL: base,
        HTTP_RETRY_LIMIT: '0',
        LOG_LEVEL: 'error',
      },
      stderr: 'ignore',
    }),
  );
});

after(async () => {
  await client?.close();
  fake?.close();
});

function body(r: unknown): Record<string, unknown> {
  const c = (r as { content: { text: string }[] }).content[0]!;
  return JSON.parse(c.text);
}

test('lists only the Forever tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['forever_browse', 'forever_details', 'forever_find', 'forever_lookup', 'forever_search']);
});

test('forever_search', async () => {
  const r = body(await client.callTool({ name: 'forever_search', arguments: { query: 'defender', type: 'item' } }));
  assert.deepEqual((r['results'] as { id: number }[]).map((x) => x.id), [279841]);
});

test('forever_lookup item', async () => {
  const r = body(await client.callTool({ name: 'forever_lookup', arguments: { type: 'item', id: 279841 } }));
  assert.equal(r['name'], 'Defender of Dalaran');
  assert.equal((r['item'] as Record<string, unknown>)['slot'], 'Off Hand');
});

test('forever_details with section filter', async () => {
  const r = body(
    await client.callTool({ name: 'forever_details', arguments: { type: 'item', id: 279841, sections: ['dropped-by'] } }),
  );
  const tables = r['tables'] as { table: string; rows: Record<string, unknown>[] }[];
  assert.deepEqual(tables.map((t) => t.table), ['dropped-by']);
  assert.equal(tables[0]!.rows[0]!['dropChance'], '12.00%');
});

test('forever_find picks exact match', async () => {
  const r = body(await client.callTool({ name: 'forever_find', arguments: { name: 'Defender of Dalaran' } }));
  const m = r['match'] as Record<string, unknown>;
  assert.deepEqual([m['type'], m['id'], m['name']], ['item', 279841, 'Defender of Dalaran']);
  assert.match(String(m['url']), /\/forever\/item=279841$/, 'the id always travels with a link');
  assert.ok((r['tables'] as unknown[]).length === 2);
});

test('forever_find falls through a candidate whose page cannot be opened', async () => {
  const r = body(await client.callTool({ name: 'forever_find', arguments: { name: 'Hall of Thanes Walkthrough' } }));
  const m = r['match'] as Record<string, unknown>;
  assert.deepEqual([m['type'], m['id']], ['zone', 16919]);
  assert.match(String(m['url']), /\/forever\/zone=16919$/, 'the id always travels with a link');
  assert.match(String((r['unusableMatches'] as string[])[0]), /news post/i, 'and the skipped hit is named, not hidden');
});

test('forever_find is never a dead end when no candidate can be opened', async () => {
  const res = await client.callTool({ name: 'forever_find', arguments: { name: 'Ruins of Lordaeron Preview' } });
  assert.notEqual(res.isError, true, 'an unopenable hit must not fail the call');
  const r = body(res);
  const matches = r['matches'] as Record<string, unknown>[];
  assert.equal(matches.length, 1);
  assert.match(String(matches[0]!['url']), /forever/);
  assert.equal(r['source'] !== undefined, true);
});

test('every tool response ends with answerGuidance then source', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['forever_search', { query: 'defender' }],
    ['forever_lookup', { type: 'item', id: 279841 }],
    ['forever_details', { type: 'item', id: 279841 }],
    ['forever_find', { name: 'Defender of Dalaran' }],
    ['forever_browse', { path: 'items/weapons/one-handed-swords', filters: ['min-req-level:0', 'max-req-level:20'], sort: 'dps desc' }],
  ];
  for (const [name, args] of calls) {
    const r = body(await client.callTool({ name, arguments: args }));
    const keys = Object.keys(r);
    assert.equal(keys.at(-1), 'source', `${name}: source must be last`);
    assert.equal(keys.at(-2), 'answerGuidance', `${name}: answerGuidance precedes source`);
    assert.match(String(r['answerGuidance']), /Never show numeric ids/);
  }
});

test('forever_lookup returns no raw item json or icon ids', async () => {
  const r = body(await client.callTool({ name: 'forever_lookup', arguments: { type: 'item', id: 279841 } }));
  const item = r['item'] as Record<string, unknown>;
  assert.equal(item['data'], undefined);
  assert.equal(item['equip'], undefined);
  assert.equal(r['icon'], undefined);
});

test('every tool description carries the presentation contract', async () => {
  const { tools } = await client.listTools();
  for (const t of tools) assert.match(String(t.description), /never show numeric ids/i, t.name);
});

test('404 becomes a readable error', async () => {
  const r = await client.callTool({ name: 'forever_details', arguments: { type: 'quest', id: 1 } });
  assert.equal(r.isError, true);
  assert.match((r.content as { text: string }[])[0]!.text, /Not found on Wowhead/);
});

test('forever_browse: one call lists a filtered category sorted by dps', async () => {
  const r = body(
    await client.callTool({
      name: 'forever_browse',
      arguments: { path: 'items/weapons/one-handed-swords', filters: ['min-req-level:0', 'max-req-level:20'], sort: 'dps desc', limit: 3 },
    }),
  );
  assert.deepEqual(r['filtersApplied'], ['min-req-level:0', 'max-req-level:20']);
  const rows = r['rows'] as Record<string, unknown>[];
  assert.deepEqual(rows.map((x) => x['dps']), [20.5, 12.25, 3.1]);
  assert.match(String((r['source'] as { url: string }).url), /one-handed-swords\/min-req-level:0\/max-req-level:20$/);
});

test('forever_browse refuses known-dead listing paths with a pointer to the live one', async () => {
  const r = await client.callTool({ name: 'forever_browse', arguments: { path: 'pet-species' } });
  assert.equal(r.isError, true);
  assert.match((r.content as { text: string }[])[0]!.text, /hunter-pets/);
});
