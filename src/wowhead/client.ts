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
import { type EntityType, typeByName } from './types.js';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 wow-forever-mcp';

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

  constructor(private readonly env: Env) {
    this.cache = new TtlCache<string>(env.CACHE_TTL_SECONDS * 1000, env.CACHE_SIZE);
  }

  pageUrl(typePath: string, id: number): string {
    return `${this.env.WOWHEAD_BASE_URL}/${this.env.WOWHEAD_ENV}/${typePath}=${id}`;
  }

  // ── Low-level fetch with timeout, retries and cache ──

  async fetchText(url: string): Promise<string> {
    const cached = this.cache.get(url);
    if (cached !== undefined) return cached;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.env.HTTP_RETRY_LIMIT; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            'user-agent': USER_AGENT,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'sec-fetch-site': 'none',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
            'upgrade-insecure-requests': '1',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(this.env.HTTP_TIMEOUT_MS),
        });
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
        const text = await res.text();
        this.cache.set(url, text);
        return text;
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
    return parsePage(await this.fetchText(this.pageUrl(type.path, id)));
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
