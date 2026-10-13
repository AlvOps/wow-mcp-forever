import pino from 'pino';

/**
 * Application logger.
 *
 * stdout belongs to the MCP stdio transport: one stray byte there is an invalid
 * JSON-RPC frame and the client breaks. So logs go to fd 2, always.
 *
 * The destination MUST be pino's second argument. `pino({ destination })` is
 * silently ignored — pino reads no such option — which is what previously sent
 * log lines to stdout whenever NODE_ENV=production disabled the transport.
 * Do not reintroduce a transport either: pino/file spawns a worker thread and
 * buys nothing when the destination is a file descriptor.
 *
 * Reads LOG_LEVEL directly from process.env so it can be imported before
 * loadEnv() has run (e.g. in tests).
 */
export const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }, pino.destination(2));