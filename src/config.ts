import { z } from 'zod';

const envSchema = z.object({
  // Wowhead site section for WoW: Forever (https://www.wowhead.com/forever/...).
  WOWHEAD_ENV: z.string().min(1).default('forever'),
  // Optional numeric dataEnv for Wowhead's tooltip service, used only as a
  // fallback if the path-based tooltip URL doesn't answer.
  WOWHEAD_DATA_ENV: z.coerce.number().int().positive().optional(),
  WOWHEAD_BASE_URL: z.string().url().default('https://www.wowhead.com'),
  WOWHEAD_TOOLTIP_URL: z.string().url().default('https://nether.wowhead.com'),

  // Entity pages are behind an AWS WAF JS challenge. A token minted by a real
  // browser (the aws-waf-token cookie) lets plain fetches through for days.
  // Empty path -> ~/.wowhead-token. Empty chrome path -> auto-detect.
  WOWHEAD_TOKEN_FILE: z.string().default(''),
  WOWHEAD_CHROME_PATH: z.string().default(''),
  WOWHEAD_TOKEN_MAX_AGE_HOURS: z.coerce.number().int().positive().default(72),
  // Page loaded to mint the cookie. Empty -> <WOWHEAD_BASE_URL>/<WOWHEAD_ENV>/items.
  WOWHEAD_MINT_URL: z.string().default(''),
  // Hard ceiling on one mint, so a wedged Chromium cannot hang a tool call.
  MINT_DEADLINE_MS: z.coerce.number().int().positive().default(45_000),
  // How long to watch for the challenge cookie before giving up on a mint.
  MINT_COOKIE_WAIT_MS: z.coerce.number().int().positive().default(20_000),
  // After a failed mint, don't spawn another browser for this long.
  MINT_FAILURE_BACKOFF_MS: z.coerce.number().int().min(0).default(600_000),

  // Transport: "stdio" (Hermes launches the server) or "http".
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // Optional static Bearer token required on /mcp in HTTP mode.
  MCP_AUTH_SECRET: z.string().min(1).optional(),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  HTTP_RETRY_LIMIT: z.coerce.number().int().min(0).default(2),
  // Game data changes slowly; cache Wowhead responses for an hour by default.
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(3600),
  // Raw response cache. Small payloads only (search/tooltip/xml): entity page
  // HTML is cached parsed, see PAGE_CACHE_SIZE.
  CACHE_SIZE: z.coerce.number().int().min(0).default(200),
  CACHE_MAX_BYTES: z.coerce.number().int().min(0).default(8_000_000),
  // Parsed entity pages held in memory (counts entries, not bytes).
  PAGE_CACHE_SIZE: z.coerce.number().int().min(0).default(60),
  // Drop tables: rows below this sample size are sorted after the rest, so
  // "100% of 6 kills" cannot outrank a real drop rate.
  DROP_MIN_SAMPLES: z.coerce.number().int().min(0).default(20),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    console.error(
      'Invalid environment variables:',
      JSON.stringify(result.error.flatten().fieldErrors, null, 2),
    );
    process.exit(1);
  }
  return result.data;
}