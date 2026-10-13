#!/usr/bin/env node
/**
 * Ask the wow-forever server directly over MCP — no Hermes in the middle.
 * Useful for checking exactly what the model gets handed.
 *
 *   node scripts/ask.mjs --list
 *   node scripts/ask.mjs forever_find '{"name":"Hogger","type":"npc","maxRows":3}'
 *   node scripts/ask.mjs forever_details '{"type":"item","id":1710,"sections":["dropped-by"],"maxRows":5}'
 *   node scripts/ask.mjs forever_search '{"query":"healing potion","limit":5}'
 *   node scripts/ask.mjs forever_lookup '{"type":"item","id":279841}'
 *
 * Run `npm run build` first.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [toolName, argsJson = '{}'] = process.argv.slice(2);
if (!toolName) {
  console.error('usage: node scripts/ask.mjs [--list | <tool> \'<json args>\']');
  process.exit(2);
}

let args;
try {
  args = JSON.parse(argsJson);
} catch {
  console.error(`args must be JSON, got: ${argsJson}`);
  process.exit(2);
}

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const child = spawn(process.execPath, [entry, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (err) => {
  console.error('could not start the server:', err.message);
  process.exit(1);
});

let buf = '';
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const done = (code) => {
  child.kill();
  process.exit(code);
};

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith('{')) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      if (toolName === '--list') {
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      } else {
        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        });
      }
    }

    if (msg.id === 2) {
      if (msg.error) {
        console.error('MCP error:', JSON.stringify(msg.error));
        done(1);
      }
      if (toolName === '--list') {
        for (const t of msg.result.tools) console.log(`${t.name.padEnd(18)} ${t.description.split('.')[0]}.`);
        done(0);
      }
      const text = msg.result?.content?.[0]?.text ?? '';
      if (msg.result?.isError) {
        console.error(text);
        done(1);
      }
      // Print it as the model would receive it.
      try {
        console.log(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        console.log(text);
      }
      done(0);
    }
  }
});

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ask', version: '1.0.0' },
  },
});

setTimeout(() => {
  console.error('timed out after 180s');
  done(1);
}, 180_000);
