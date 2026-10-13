# wow-forever-mcp

An MCP server that lets an AI assistant answer questions about **World of Warcraft: Forever** using the [Wowhead Forever database](https://www.wowhead.com/forever).

The retail Blizzard API tools, OAuth and Postgres have been removed — this server talks to Wowhead only. No API keys are needed.

## Tools

| Tool | What it answers |
|------|-----------------|
| `forever_find` | One step: "where does X drop?", "who sells X?", "how do I start quest X?" Searches by name and returns full details of the best match. |
| `forever_search` | Find items, quests, NPCs, spells, zones… by name, returning their ids. |
| `forever_lookup` | Tooltip summary for one entity: stats, level, requirements, effects. Items also get slot, item level and crafting reagents. |
| `forever_details` | Full page data: quick facts, description/objectives, and tables like `dropped-by` (with drop chance), `sold-by`, `starts`, `objective-of`, `reward-from`, `created-by`, `reagent-for`. |

Types: `item`, `quest`, `npc`, `spell`, `object`, `zone`, `faction`, `itemset`, `achievement`, `title`, `event`, `class`, `race`, `skill`, `currency`.

Every response ends with a `source` field — the Wowhead URL the answer came from, so it can be cited:

```json
"source": { "label": "Wowhead: WoW Forever", "url": "https://www.wowhead.com/forever/item=1710" }
```

Answers are quality-adjusted rather than raw:

- Data tables keep the numeric `location` ids **and** add `locations` with area names taken from Wowhead's own table — a model given bare ids fills in zone names from its own knowledge, which reads as authoritative but is not the data source speaking.
- Drop tables report `samples` (the kill count behind a rate) and are ordered by drop chance with rows below `DROP_MIN_SAMPLES` last, so *100% of 6 kills* cannot outrank a real drop rate.
- Transmog, comment, screenshot and video tables are omitted unless explicitly requested through `sections`; they stay listed in `availableTables`.

## Install

Requires Node.js 20+.

```bash
git clone https://github.com/AlvOps/wow-mcp.git
cd wow-mcp
npm install
npm run build
npm run selftest            # live check against Wowhead from this machine
```

`npm run selftest "Hogger"` tests a different search term.

## Connect to Hermes Agent

Hermes launches the server itself over stdio. Add this to `~/.hermes/config.yaml`, adjusting the path:

```yaml
mcp_servers:
  wow-forever:
    command: node
    args: ["/home/talos/wow-mcp/dist/index.js", "--stdio"]
```

Restart the gateway (`systemctl --user restart hermes-gateway.service`), then ask something like *"Where does Defender of Dalaran drop in WoW Forever?"*

### HTTP mode instead

```bash
MCP_AUTH_SECRET=change-me npm run start:http      # serves http://0.0.0.0:3000/mcp
```

```yaml
mcp_servers:
  wow-forever:
    url: "http://localhost:3000/mcp"
    headers:
      Authorization: "Bearer change-me"
```

Docker: `docker build -t wow-forever-mcp . && docker run -p 3000:3000 -e MCP_AUTH_SECRET=change-me wow-forever-mcp`

## Configuration

Everything is optional; see [`.env.example`](.env.example).

## How it works and limits

Wowhead has no official API. The server reads the same endpoints Wowhead's own site uses: search suggestions, the tooltip service, item XML and the entity pages, whose data tables it parses. Responses are cached for an hour to keep traffic light.

- Wowhead sits behind AWS WAF (CloudFront), and the three failure modes look nothing alike (all measured):
  - **no browser-shaped headers → `403`**, a 919-byte "ERROR: The request could not be satisfied" page. This is the edge refusing the request, *not* a token problem. The client always sends `Sec-Fetch-*` with `sec-fetch-site: none`.
  - **headers but no cookie → `202`** carrying `window.gokuProps`: the AWS WAF JavaScript challenge. `202` is a *successful* status, so a plain `response.ok` check parses the challenge page as if it were entity data.
  - **headers and any cookie → `200`** with the real page. A stale token therefore degrades to the `202` case rather than to `403`.
- Getting past it: the server mints the `aws-waf-token` cookie with a headless Chromium and then goes back to being an ordinary HTTP client. The token is **not bound to the client IP or the User-Agent**. Chromium must carry a real User-Agent — the default headless UA is blocked with `403` — hence the explicit `--user-agent`.
- On a `202` **or** a `403` the client re-mints the token once and retries, then fails with a precise message instead of blaming the IP. Minting is bounded: a hard deadline (`MINT_DEADLINE_MS`), a per-CDP-command timeout, and a backoff (`MINT_FAILURE_BACKOFF_MS`) after a failure so a broken Chromium cannot cost a browser spawn on every request.
- Ids that don't exist come back as site-wide *catalog* pages, not clean 404s: `/forever/items` answers `200`, `/forever/npc=99999999` answers `404` whose body is titled `Forever NPCs`. Both parse cleanly and would be reported as real data. The client compares the page's own `rel="canonical"` link against the entity it asked for, so a listing can never be passed off as an entity.
- Requirements: a Chromium binary (auto-detected from `PATH` or Playwright's `~/.cache/ms-playwright`), Node 22+ (for the global `WebSocket` used to read the cookie over CDP), and `~/.wowhead-token` for the cached token.
- Caching: small payloads are cached by entry count *and* byte budget; entity pages are cached **parsed**, so the raw 250KB–850KB HTML is never retained (that was the only way this process could grow to a gigabyte).
- If Wowhead changes its page format, `forever_details` may return fewer tables. `npm run selftest` shows what still works.
- WoW: Forever is new, so Wowhead's data is still filling in; some drop rates are missing or based on Classic.
- Use this for personal use, at modest volume, and respect Wowhead's terms.

## Development

```bash
npm run dev       # run from source
npm run inspect   # MCP Inspector UI: click the tools, see the raw payloads
npm test          # 36 parser/state-machine tests, offline, against a fake Wowhead
npm run selftest  # live check against the real Wowhead from this machine
npm run lint      # type-check

# Ask the server directly, no assistant in the middle (run npm run build first):
node scripts/ask.mjs --list
node scripts/ask.mjs forever_find '{"name":"Hogger","type":"npc","maxRows":3}'
node scripts/ask.mjs forever_details '{"type":"item","id":1710,"sections":["dropped-by"],"maxRows":5}'
```
