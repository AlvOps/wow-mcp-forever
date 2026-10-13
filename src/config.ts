import { z } from 'zod';

const envSchema = z.object({
  // Wowhead site section for WoW: Forever (https://www.wowhead.com/forever/...).
  WOWHEAD_ENV: z.string().min(1).default('forever'),
  // Optional numeric dataEnv for Wowhead's tooltip service, used only as a
  // fallback if the path-based tooltip URL doesn't answer.
  WOWHEAD_DATA_ENV: z.coerce.number().int().positive().optional(),
  WOWHEAD_BASE_URL: z.string().url().default('https://www.wowhead.com'),
  WOWHEAD_TOOLTIP_URL: z.string().url().default('https://nether.wowhead.com'),

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
  CACHE_SIZE: z.coerce.number().int().min(0).default(1000),
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
