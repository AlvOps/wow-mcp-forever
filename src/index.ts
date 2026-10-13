#!/usr/bin/env node
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadEnv } from './config.js';
import { registerTools } from './tools.js';
import { WowheadClient } from './wowhead/client.js';
import { logger } from './util/logger.js';

const env = loadEnv();
const client = new WowheadClient(env); // shared so the cache survives across requests

function buildServer(): McpServer {
  const server = new McpServer({ name: 'wow-forever', version: '2.0.0' });
  registerTools(server, client);
  return server;
}

const transport = process.argv.includes('--http') ? 'http' : process.argv.includes('--stdio') ? 'stdio' : env.MCP_TRANSPORT;

if (transport === 'stdio') {
  await buildServer().connect(new StdioServerTransport());
  logger.info('wow-forever MCP server running on stdio (Wowhead env: %s)', env.WOWHEAD_ENV);
} else {
  const authorized = (header: string | undefined) => {
    if (!env.MCP_AUTH_SECRET) return true;
    const expected = Buffer.from(`Bearer ${env.MCP_AUTH_SECRET}`);
    const got = Buffer.from(header ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const http = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req.headers['authorization'])) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Unauthorized' }, id: null }),
      );
      return;
    }
    try {
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer();
      res.on('close', () => {
        void t.close();
        void server.close();
      });
      await server.connect(t);
      await t.handleRequest(req, res);
    } catch (err) {
      logger.error({ err }, 'MCP request error');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }),
        );
      }
    }
  });

  http.listen(env.PORT, env.HOST, () => {
    logger.info('wow-forever MCP server on http://%s:%d/mcp', env.HOST, env.PORT);
    if (!env.MCP_AUTH_SECRET) logger.warn('MCP_AUTH_SECRET not set: /mcp is unauthenticated');
  });
}
