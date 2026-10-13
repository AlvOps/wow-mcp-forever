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

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

export class WowheadClient {
  private cache: TtlCache<string>;
  private tokens: WafTokenStore;

  constructor(private readonly env: Env) {
    this.cache = new TtlCache<string>(env.CACHE_TTL_SECONDS * 1000, env.CACHE_SIZE);
    this.tokens = new WafTokenStore(
      env.WOWHEAD_TOKEN_FILE || join(homedir(), '.wowhead-token'),
      env.WOWHEAD_CHROME_PATH || undefined,
      env.WOWHEAD_TOKEN_MAX_AGE_HOURS,
    );
  }

  pageUrl(typePath: string, id: number): string {
    return `${this.env.WOWHEAD_BASE_URL}/${this.env.WOWHEAD_ENV}/${typePath}=${id}`;
  }

  /**
   * A browser-shaped header set. The Sec-Fetch-* headers are not optional:
   * without them Wowhead's WAF answers 403 instead of the challenge.
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

  /**
   * The AWS WAF JavaScript challenge arrives as HTTP 202 with a
   * `window.gokuProps` interstitial. 202 is a *successful* status, so a naive
   * `response.ok` check parses the challenge page as if it were entity data.
   */
  private static isChallenge(status: number, text: string): boolean {
    // The challenge is served as HTTP 202 and carries `gokuProps`.
    // Deliberately NOT testing for `awsWafCookieDomainList`: Wowhead injects that
    // snippet into real pages as well (verified on a 743KB item page), so it
    // produces false positives and throws away perfectly good responses.
    return status === 202 || text.includes('gokuProps');
  }

  // ── Low-level fetch with timeout, retries, token and cache ──

  async fetchText(url: string): Promise<string> {
    return (await this.fetchStatus(url)).text;
  }

  private async fetchStatus(url: string): Promise<{ status: number; text: string }> {
    const cached = this.cache.get(url);
    if (cached !== undefined) return { status: 200, text: cached };

    let lastErr: unknown;
    let refreshed = false;

    for (let attempt = 0; attempt <= this.env.HTTP_RETRY_LIMIT; attempt++) {
      try {
        const token = await this.tokens.getOrMint();
        const res = await fetch(url, {
          headers: this.requestHeaders(token),
          redirect: 'follow',
          signal: AbortSignal.timeout(this.env.HTTP_TIMEOUT_MS),
        });
        const text = await res.text();

        if (WowheadClient.isChallenge(res.status, text)) {
          lastErr = new Error(`Wowhead served the AWS WAF challenge (HTTP ${res.status}) for ${url}`);
          if (!refreshed) {
            refreshed = true;
            logger.info({ url }, 'WAF challenge received: re-minting the token and retrying');
            await this.tokens.getOrMint(true);
            continue;
          }
          break; // token re-mint did not clear it; give up rather than loop
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

        this.cache.set(url, text);
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
    const { status, text } = await this.fetchStatus(url);
    if (status === 404) throw new HttpError(404, url);

    // An id that does not exist answers with the site-wide listing page rather
    // than a 404. It parses cleanly and would be reported as real data, so it
    // has to be rejected explicitly.
    const title = /<title>([^<]*)</i.exec(text)?.[1]?.trim() ?? '';
    if (/^forever items$/i.test(title)) {
      logger.debug({ url, title }, 'entity id resolved to the site listing page');
      throw new HttpError(404, url);
    }

    return parsePage(text);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
