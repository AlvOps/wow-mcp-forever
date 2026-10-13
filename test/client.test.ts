/**
 * The fetch/token state machine and the wiring around it. This was the untested
 * part of the server, and the place where a silent failure costs the most: a
 * wrong-but-200 body parses cleanly, so nothing downstream can tell.
 *
 * `fetch` and the token store are injected so every branch is exercised without
 * touching the network or launching a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/config.js';
import { HttpError, WowheadClient, isWafChallenge } from '../src/wowhead/client.js';
import { shapePage } from '../src/tools.js';
import { TtlCache } from '../src/util/cache.js';
import { typeById } from '../src/wowhead/types.js';

const env = loadEnv({});

const CHALLENGE = '<html><script>window.gokuProps = {"a":1};</script></html>';
const LISTING = '<html><head><title>Forever Items</title><link rel="canonical" href="https://www.wowhead.com/forever/items"></head></html>';
const PAGE = (id = 279841) =>
  `<html><head><title>Defender of Dalaran - Item - Forever</title>` +
  `<link rel="canonical" href="https://www.wowhead.com/forever/item=${id}"></head>` +
  `<body><script>new Listview({id:'dropped-by',template:'npc',data:[` +
  `{id:1,name:'Weak Wolf',count:1,outof:6,location:[405]},` +
  `{id:2,name:'Strong Wolf',count:40,outof:100,location:[405]}]});</script></body></html>`;

/** A fetch stub that plays back a scripted list of responses in order. */
function scriptedFetch(steps: Array<{ status: number; body: string }>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    return new Response(step.body, { status: step.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function tokenStub() {
  const forced: boolean[] = [];
  return {
    forced,
    source: {
      getOrMint: async (force?: boolean) => {
        forced.push(force === true);
        return 'stub-token';
      },
    },
  };
}

function client(fetchImpl: typeof fetch, tokens = tokenStub().source) {
  return new WowheadClient(env, { fetch: fetchImpl, tokens });
}

test('isWafChallenge flags 202 and gokuProps only', () => {
  assert.equal(isWafChallenge(202, ''), true);
  assert.equal(isWafChallenge(200, CHALLENGE), true);
  // A real page also mentions awsWafCookieDomainList — not a challenge signal.
  assert.equal(isWafChallenge(200, '<html>awsWafCookieDomainList</html>'), false);
  assert.equal(isWafChallenge(403, 'ERROR: The request could not be satisfied'), false);
});

test('a plain 200 is returned and then served from cache', async () => {
  const { impl, calls } = scriptedFetch([{ status: 200, body: PAGE() }]);
  const c = client(impl);
  assert.match(await c.fetchText('https://www.wowhead.com/forever/item=279841'), /Defender of Dalaran/);
  await c.fetchText('https://www.wowhead.com/forever/item=279841');
  assert.equal(calls.length, 1, 'second read should come from the cache');
});

test('a 202 challenge triggers exactly one forced re-mint, then succeeds', async () => {
  const { impl } = scriptedFetch([
    { status: 202, body: CHALLENGE },
    { status: 200, body: PAGE() },
  ]);
  const tokens = tokenStub();
  const c = client(impl, tokens.source);
  const text = await c.fetchText('https://www.wowhead.com/forever/item=279841');
  assert.match(text, /Defender of Dalaran/);
  // Exactly one forced re-mint; the successful retry re-reads the token normally.
  assert.equal(tokens.forced.filter(Boolean).length, 1, 'the retry must force a fresh token');
  assert.equal(tokens.forced[0], false, 'the first attempt uses the stored token');
});

test('a 403 refreshes the token once and then succeeds', async () => {
  const { impl } = scriptedFetch([
    { status: 403, body: 'ERROR: The request could not be satisfied' },
    { status: 200, body: PAGE() },
  ]);
  const tokens = tokenStub();
  const c = client(impl, tokens.source);
  assert.match(await c.fetchText('https://www.wowhead.com/forever/item=279841'), /Defender of Dalaran/);
  assert.equal(tokens.forced.filter(Boolean).length, 1, 'exactly one forced re-mint');
});

test('a repeated 403 fails with a precise, non-misleading error', async () => {
  const { impl, calls } = scriptedFetch([{ status: 403, body: 'nope' }]);
  const c = client(impl);
  await assert.rejects(
    () => c.fetchText('https://www.wowhead.com/forever/item=279841'),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 403);
      assert.match(err.message, /refused the request/i);
      return true;
    },
  );
  assert.equal(calls.length, 2, 'one original attempt plus one after the token refresh');
});

test('a challenge that survives a re-mint fails instead of looping', async () => {
  const { impl, calls } = scriptedFetch([{ status: 202, body: CHALLENGE }]);
  const c = client(impl);
  await assert.rejects(
    () => c.fetchText('https://www.wowhead.com/forever/item=279841'),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 202);
      assert.match(err.message, /AWS WAF challenge/i);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test('a 500 is retried without burning a token', async () => {
  const { impl, calls } = scriptedFetch([
    { status: 500, body: 'boom' },
    { status: 200, body: PAGE() },
  ]);
  const tokens = tokenStub();
  const c = client(impl, tokens.source);
  assert.match(await c.fetchText('https://www.wowhead.com/forever/item=279841'), /Defender of Dalaran/);
  assert.deepEqual(tokens.forced, [false, false], 'server errors are not token problems');
  assert.equal(calls.length, 2);
});

test('page rejects a listing page even though it parses cleanly', async () => {
  const { impl } = scriptedFetch([{ status: 200, body: LISTING }]);
  const c = client(impl);
  await assert.rejects(
    () => c.page(typeById(3)!, 279841),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test('page detects the listing by canonical link even with a 404 status', async () => {
  const { impl } = scriptedFetch([
    { status: 404, body: `<html><title>Forever NPCs</title><link rel="canonical" href="https://www.wowhead.com/forever/npcs"></html>` },
  ]);
  const c = client(impl);
  await assert.rejects(() => c.page(typeById(1)!, 99999999), /HTTP 404/);
});

test('page caches the parsed page and cleans the title', async () => {
  const { impl, calls } = scriptedFetch([{ status: 200, body: PAGE() }]);
  const c = client(impl);
  const first = await c.page(typeById(3)!, 279841);
  assert.equal(first.title, 'Defender of Dalaran');
  await c.page(typeById(3)!, 279841);
  assert.equal(calls.length, 1, 'the parsed page should be reused, not re-parsed');
});

// ── Cache: the memory-growth fix ──

test('TtlCache evicts least-recently-used, not oldest-inserted', () => {
  const c = new TtlCache<string>(60_000, 2);
  c.set('a', 'A');
  c.set('b', 'B');
  c.get('a'); // touch a
  c.set('c', 'C');
  assert.equal(c.get('a'), 'A', 'a was used most recently and should survive');
  assert.equal(c.get('b'), undefined, 'b was the least recently used');
});

test('TtlCache honours a byte budget', () => {
  const c = new TtlCache<string>(60_000, 100, 10, (s) => s.length);
  c.set('big', 'x'.repeat(8));
  assert.equal(c.byteSize, 8);
  c.set('big2', 'y'.repeat(8)); // 16 > 10 -> evict the first
  assert.equal(c.get('big'), undefined);
  assert.equal(c.get('big2'), 'y'.repeat(8));
  assert.equal(c.byteSize, 8);
});

// ── shapePage: the answer-quality fixes the user asked for ──

const SHAPE_INFO = {
  title: 'Greater Healing Potion',
  listviews: [
    {
      id: 'dropped-by',
      template: 'npc',
      rows: [
        { id: 1, name: 'Fluke Wolf', count: 6, outof: 6, location: [405] },      // 100% of 6
        { id: 2, name: 'Solid Wolf', count: 28, outof: 100, location: [405] },   // 28% of 100
      ],
    },
    { id: 'outfits', template: 'item', rows: [{ id: 3, name: 'Some Outfit' }] },
    { id: 'comments', template: 'comment', rows: [] },
  ],
};

async function shapedClient() {
  // Serves the area-name table, so `locations` resolve without the network.
  const { impl } = scriptedFetch([
    { status: 200, body: 'WH.setPageData("wow.area.names",{"405":"Desolace"});' },
  ]);
  return client(impl);
}

test('shapePage sinks low-sample flukes below real drop rates', async () => {
  const c = await shapedClient();
  const shaped = await shapePage(SHAPE_INFO, 'https://www.wowhead.com/forever/item=1710', { maxRows: 10 }, c);
  const drop = shaped.tables.find((t) => t.table === 'dropped-by')!;
  assert.deepEqual(drop.rows.map((r) => r['name']), ['Solid Wolf', 'Fluke Wolf'],
    '28% of 100 must outrank 100% of 6');
  assert.equal(drop.rows[0]!['samples'], 100, 'the sample size travels with the rate');
  assert.equal(drop.rows[0]!['zone'], 'Desolace', 'zone names come from the data');
  assert.equal(drop.rowsOnPage, 2);
  assert.match(String(drop.sortedBy), /dropChance desc/);
});

test('shapePage hides noise tables unless they are asked for', async () => {
  const c = await shapedClient();
  const shaped = await shapePage(SHAPE_INFO, 'https://www.wowhead.com/forever/item=1710', { maxRows: 10 }, c);
  assert.deepEqual(shaped.tables.map((t) => t.table), ['dropped-by']);
  assert.ok(shaped.availableTables.some((t) => t.startsWith('outfits')), 'still discoverable');

  const asked = await shapePage(
    SHAPE_INFO, 'https://www.wowhead.com/forever/item=1710', { maxRows: 10, sections: ['outfits'] }, c);
  assert.deepEqual(asked.tables.map((t) => t.table), ['outfits']);
});

test('every shaped payload ends with the Wowhead source link', async () => {
  const c = await shapedClient();
  const shaped = await shapePage(SHAPE_INFO, 'https://www.wowhead.com/forever/item=1710', { maxRows: 10 }, c);
  assert.equal(Object.keys(shaped).at(-1), 'source', 'source must be the final field');
  assert.equal(shaped.source.url, 'https://www.wowhead.com/forever/item=1710');
});

// ── Reaching a catalog page by canonical link ──

test('a page whose canonical link points elsewhere is treated as missing', async () => {
  // The tell for /forever/items: a 200 body whose canonical is the listing.
  const c = client(scriptedFetch([{ status: 200, body: LISTING }]).impl);
  await assert.rejects(() => c.page(typeById(3)!, 279841), /HTTP 404/);
});

test('a guide page is reachable even though its canonical is a slug without the id', async () => {
  // Live: /forever/guide=34887 canonicalises to
  // /forever/guide/hall-of-thanes-dungeon-overview-location-rewards — no `guide=34887`
  // anywhere — so the id-in-canonical test threw a fake 404 on a page that fetched fine.
  const GUIDE = `<html><head><title>The Hall of Thanes Dungeon Overview Guide - Wow Forever - Wowhead</title>` +
    `<link rel="canonical" href="https://www.wowhead.com/forever/guide/hall-of-thanes-dungeon-overview-location-rewards"></head>` +
    `<body><script>new Listview({id:'quests',template:'quest',data:[{id:96403,name:'Important Heirlooms',level:14}]});</script></body></html>`;
  const c = client(scriptedFetch([{ status: 200, body: GUIDE }]).impl);
  const page = await c.page(typeById(100)!, 34887);
  assert.match(String(page.title), /Hall of Thanes/);
  assert.equal(page.listviews[0]!.rows[0]!['name'], 'Important Heirlooms');
});

test('the guides listing is still not an entity page for guide=<id>', async () => {
  // Same trailing-slash rule: /forever/guides has no `/guide/` segment.
  const c = client(scriptedFetch([{ status: 200, body: `<html><title>Forever Guides</title><link rel="canonical" href="https://www.wowhead.com/forever/guides"></html>` }]).impl);
  await assert.rejects(() => c.page(typeById(100)!, 999999), /HTTP 404/);
});