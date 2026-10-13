# wow-forever-mcp

An MCP server that lets an AI assistant answer questions about **World of Warcraft: Forever** using the [Wowhead Forever database](https://www.wowhead.com/forever).

Forked from [brunofin/wow-mcp](https://github.com/brunofin/wow-mcp). The retail Blizzard API tools, OAuth and Postgres were removed. No API keys are needed.

## Tools

| Tool | What it answers |
|------|-----------------|
| `forever_find` | One step: "where does X drop?", "who sells X?", "how do I start quest X?" Searches by name and returns full details of the best match. |
| `forever_search` | Find items, quests, NPCs, spells, zones… by name, returning their ids. |
| `forever_lookup` | Tooltip summary for one entity: stats, level, requirements, effects. Items also get slot, item level and crafting reagents. |
| `forever_details` | Full page data: quick facts, description/objectives, and tables like `dropped-by` (with drop chance), `sold-by`, `starts`, `objective-of`, `reward-from`, `created-by`, `reagent-for`. |

Types: `item`, `quest`, `npc`, `spell`, `object`, `zone`, `faction`, `itemset`, `achievement`, `title`, `event`, `class`, `race`, `skill`, `currency`.

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

- If Wowhead changes its page format, `forever_details` may return fewer tables. `npm run selftest` shows what still works.
- WoW: Forever is new, so Wowhead's data is still filling in; some drop rates are missing or based on Classic.
- Use this for personal use, at modest volume, and respect Wowhead's terms.

## Development

```bash
npm run dev       # run from source
npm run inspect   # MCP Inspector UI
npm test          # parser + end-to-end tests against a fake Wowhead
npm run lint      # type-check
```
