import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../config.js';
import { TtlCache } from '../util/cache.js';
import { logger } from '../util/logger.js';
import {
  type PageInfo,
  type SearchResult,
  type TooltipInfo,
  parseItemXml,
  parseListviews,
  parsePage,
  parseSuggestions,
  parseTooltip,
  summarizeRow,
} from './parse.js';
import { REAL_UA, WafTokenStore } from './token.js';
import { type EntityType, typeByName } from './types.js';
import { AreaNames } from './zones.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly reason?: string,
  ) {
    super(reason ? `${reason} (HTTP ${status} from ${url})` : `HTTP ${status} from ${url}`);
  }
}

/** Just the part of the token store the client needs, so tests can stub it. */
export interface TokenSource {
  getOrMint(force?: boolean): Promise<string | undefined>;
}

export interface ClientDeps {
  fetch?: typeof fetch;
  tokens?: TokenSource;
}

/**
 * The AWS WAF JavaScript challenge arrives as HTTP 202 with a
 * `window.gokuProps` interstitial. 202 is a *successful* status, so a naive
 * `response.ok` check parses the challenge page as if it were entity data.
 *
 * Deliberately NOT testing for `awsWafCookieDomainList`: Wowhead injects that
 * snippet into real pages as well (verified on a 743KB item page), so it
 * produces false positives and throws away perfectly good responses.
 */
export function isWafChallenge(status: number, text: string): boolean {
  return status === 202 || text.includes('gokuProps');
}

export class WowheadClient {
  private cache: TtlCache<string>;
  private pages: TtlCache<PageInfo>;
  private tokens: TokenSource;
  private areas: AreaNames;
  private doFetch: typeof fetch;

  constructor(
    private readonly env: Env,
    deps: ClientDeps = {},
  ) {
    // Raw payloads (search JSON, tooltips, item XML) are small, so cap by bytes
    // as well as by entry count.
    this.cache = new TtlCache<string>(
      env.CACHE_TTL_SECONDS * 1000,
      env.CACHE_SIZE,
      env.CACHE_MAX_BYTES,
      (s) => s.length,
    );
    // Entity pages are ~250KB-850KB of HTML and are cached *parsed*: keeping the
    // raw strings was the one way this process could grow to a gigabyte.
    this.pages = new TtlCache<PageInfo>(env.CACHE_TTL_SECONDS * 1000, env.PAGE_CACHE_SIZE);

    this.doFetch = deps.fetch ?? fetch;
    this.tokens =
      deps.tokens ??
      new WafTokenStore(
        env.WOWHEAD_TOKEN_FILE || join(homedir(), '.wowhead-token'),
        env.WOWHEAD_CHROME_PATH || undefined,
        env.WOWHEAD_TOKEN_MAX_AGE_HOURS,
        {
          // Derived from the configured site/env rather than hardcoded.
          mintUrl: env.WOWHEAD_MINT_URL || `${env.WOWHEAD_BASE_URL}/${env.WOWHEAD_ENV}/items`,
          deadlineMs: env.MINT_DEADLINE_MS,
          cookieWaitMs: env.MINT_COOKIE_WAIT_MS,
          callTimeoutMs: Math.max(5_000, Math.min(20_000, env.MINT_DEADLINE_MS - 5_000)),
        },
        env.MINT_FAILURE_BACKOFF_MS,
      );
    this.areas = new AreaNames(
      `${env.WOWHEAD_TOOLTIP_URL}/${env.WOWHEAD_ENV}/data/global`,
      env.HTTP_TIMEOUT_MS,
      REAL_UA,
    );
  }

  pageUrl(typePath: string, id: number): string {
    return `${this.env.WOWHEAD_BASE_URL}/${this.env.WOWHEAD_ENV}/${typePath}=${id}`;
  }

  /** Human-facing search URL, used to cite where an answer came from. */
  searchUrl(query: string): string {
    return `${this.env.WOWHEAD_BASE_URL}/${this.env.WOWHEAD_ENV}/search?q=${encodeURIComponent(query)}`;
  }

  /** Drop rows with fewer samples than this are ordered after the rest. */
  get dropMinSamples(): number {
    return this.env.DROP_MIN_SAMPLES;
  }

  /**
   * A browser-shaped header set. The Sec-Fetch-* headers are not optional:
   * without them Wowhead's edge answers 403 (a 919-byte CloudFront error page)
   * instead of the challenge.
   */
  private requestHeaders(token?: string): Record<string, string> {
    return {
      'user-agent': REAL_UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'upgrade-insecure-requests': '1',
      ...(token ? { cookie: `aws-waf-token=${token}` } : {}),
    };
  }

  // ── Low-level fetch with timeout, retries, token and cache ──

  async fetchText(url: string): Promise<string> {
    return (await this.fetchStatus(url)).text;
  }

  private async fetchStatus(
    url: string,
    opts: { cacheText?: boolean } = {},
  ): Promise<{ status: number; text: string }> {
    const cacheText = opts.cacheText ?? true;
    if (cacheText) {
      const cached = this.cache.get(url);
      if (cached !== undefined) return { status: 200, text: cached };
    }

    let lastErr: unknown;
    /** At most one token refresh per request, whatever symptom triggered it. */
    let recovered = false;

    for (let attempt = 0; attempt <= this.env.HTTP_RETRY_LIMIT; attempt++) {
      try {
        const token = await this.tokens.getOrMint();
        const res = await this.doFetch(url, {
          headers: this.requestHeaders(token),
          redirect: 'follow',
          signal: AbortSignal.timeout(this.env.HTTP_TIMEOUT_MS),
        });
        const text = await res.text();

        if (isWafChallenge(res.status, text)) {
          if (!recovered) {
            recovered = true;
            logger.info({ url }, 'WAF challenge received: re-minting the token and retrying');
            await this.tokens.getOrMint(true);
            continue;
          }
          throw new HttpError(
            res.status,
            url,
            'Wowhead served the AWS WAF challenge and a fresh token did not clear it',
          );
        }

        if (res.status === 403) {
          // A 403 here is the edge refusing a non-browser-shaped request rather
          // than a challenge (a stale cookie still passes; a *missing* cookie
          // yields the 202 challenge above). A rejected token can look the same,
          // so refresh once before giving up.
          if (!recovered) {
            recovered = true;
            logger.info({ url }, 'HTTP 403 received: re-minting the token and retrying once');
            await this.tokens.getOrMint(true);
            continue;
          }
          throw new HttpError(403, url, 'Wowhead refused the request (HTTP 403) twice');
        }

        if (!res.ok) {
          const err = new HttpError(res.status, url);
          // Only retry rate limits and server errors.
          if (res.status === 429 || res.status >= 500) {
            lastErr = err;
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw err;
        }

        if (cacheText) this.cache.set(url, text);
        return { status: res.status, text };
      } catch (err) {
        if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
        lastErr = err;
        logger.debug({ err, url, attempt }, 'fetch failed');
        if (attempt < this.env.HTTP_RETRY_LIMIT) await sleep(500 * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async fetchJson(url: string): Promise<unknown> {
    const text = await this.fetchText(url);
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * Area id -> name table, from Wowhead's own global page data. Tables report
   * numeric `location` ids; without this a model invents the zone names.
   */
  async areaNames(): Promise<Map<number, string>> {
    return this.areas.load();
  }

  // ── Search ──

  async search(query: string, opts: { type?: EntityType; limit?: number } = {}): Promise<SearchResult[]> {
    const limit = opts.limit ?? 10;
    const base = `${this.env.WOWHEAD_BASE_URL}/${this.env.WOWHEAD_ENV}`;
    let results: SearchResult[] = [];

    try {
      const data = await this.fetchJson(`${base}/search/suggestions-template?q=${encodeURIComponent(query)}`);
      results = parseSuggestions(data, (path, id) => this.pageUrl(path, id));
    } catch (err) {
      logger.debug({ err }, 'suggestions endpoint failed; falling back to search page');
    }

    // Fallback: the full search page, which lists results in Listview tables.
    if (results.length === 0) {
      try {
        const html = await this.fetchText(`${base}/search?q=${encodeURIComponent(query)}`);
        for (const lv of parseListviews(html)) {
          const t = typeByName(lv.template ?? '') ?? typeByName(lv.id.replace(/s$/, ''));
          if (!t) continue;
          for (const row of lv.rows) {
            const r = summarizeRow(row, lv.template);
            if (typeof r['id'] !== 'number' || typeof r['name'] !== 'string') continue;
            results.push({
              type: t.name,
              typeId: t.id,
              id: r['id'],
              name: r['name'],
              ...(typeof r['quality'] === 'string' ? { quality: r['quality'] } : {}),
              url: this.pageUrl(t.path, r['id']),
            });
          }
        }
      } catch (err) {
        logger.debug({ err }, 'search page failed');
      }
    }

    if (opts.type) results = results.filter((r) => r.typeId === opts.type!.id || r.type === opts.type!.name);
    return results.slice(0, limit);
  }

  // ── Tooltip (short summary card) ──

  async tooltip(type: EntityType, id: number): Promise<TooltipInfo | undefined> {
    const tip = this.env.WOWHEAD_TOOLTIP_URL;
    const urls = [`${tip}/${this.env.WOWHEAD_ENV}/tooltip/${type.tooltip}/${id}?locale=0`];
    if (this.env.WOWHEAD_DATA_ENV) {
      urls.push(`${tip}/tooltip/${type.tooltip}/${id}?dataEnv=${this.env.WOWHEAD_DATA_ENV}&locale=0`);
    }
    for (const url of urls) {
      try {
        const info = parseTooltip(await this.fetchJson(url));
        if (info) return info;
      } catch (err) {
        logger.debug({ err, url }, 'tooltip failed');
      }
    }
    return undefined;
  }

  // ── Item XML (stats, slot, crafting reagents) ──

  async itemXml(id: number): Promise<Record<string, unknown> | undefined> {
    try {
      const xml = await this.fetchText(`${this.env.WOWHEAD_BASE_URL}/${this.env.WOWHEAD_ENV}/item=${id}&xml`);
      return parseItemXml(xml);
    } catch (err) {
      logger.debug({ err, id }, 'item xml failed');
      return undefined;
    }
  }

  // ── Full entity page (drops, quest chains, vendors, ...) ──

  async page(type: EntityType, id: number): Promise<PageInfo> {
    const url = this.pageUrl(type.path, id);
    const cached = this.pages.get(url);
    if (cached) return cached;

    // Raw HTML is deliberately not kept: only the parsed page is cached.
    const { text } = await this.fetchStatus(url, { cacheText: false });
    const rawTitle = /<title>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim() ?? '';
    if (!this.looksLikeEntity(text, rawTitle, type.path, id)) {
      logger.debug({ url, rawTitle }, 'entity id resolved to a listing page');
      throw new HttpError(404, url, 'Wowhead has no such entity');
    }

    const info = parsePage(text);
    this.pages.set(url, info);
    return info;
  }

  /**
   * Ids that don't exist answer with a site-wide *listing* page: a 200 for
   * /forever/items, a 404 whose body is "Forever NPCs" for /forever/npc=99999999.
   * Either body parses cleanly and would be reported as real data. The page's
   * own canonical link names the resource it belongs to, so a mismatch is the
   * reliable tell — far better than matching one hardcoded title.
   */
  private looksLikeEntity(html: string, rawTitle: string, typePath: string, id: number): boolean {
    const canonical =
      /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1] ??
      /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1];
    if (canonical) return canonical.includes(`${typePath}=${id}`);
    // No canonical at all: fall back to the listing-page titles.
    return !/^forever\s+[a-z]+s$/i.test(rawTitle);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
