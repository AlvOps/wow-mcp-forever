/**
 * Area/zone names.
 *
 * Listview rows carry `location: [405]` — numeric area ids — so a model given
 * only ids will otherwise invent the zone names from its own knowledge. That
 * looks authoritative in an answer and is not: it is not the data source
 * speaking.
 *
 * Wowhead's own global page data carries the complete id -> name table
 * (`wow.area.names`, ~170 entries, on nether.wowhead.com, i.e. NOT behind the
 * entity-page WAF challenge). One small request names every row.
 */
import { extractBalanced } from './parse.js';
import { logger } from '../util/logger.js';

/** Parse `WH.setPageData("wow.area.names", {...})` out of the global page data. */
export function parseAreaNames(text: string): Map<number, string> {
  const key = text.indexOf('wow.area.names');
  if (key < 0) return new Map();
  const start = text.indexOf('{', key);
  if (start < 0) return new Map();
  const objText = extractBalanced(text, start);
  if (!objText) return new Map();

  try {
    const raw = JSON.parse(objText) as Record<string, string>;
    const map = new Map<number, string>();
    for (const [id, name] of Object.entries(raw)) {
      const n = Number(id);
      if (Number.isFinite(n) && typeof name === 'string' && name) map.set(n, name);
    }
    return map;
  } catch {
    return new Map();
  }
}

export class AreaNames {
  private map?: Map<number, string>;
  private inFlight?: Promise<Map<number, string>>;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly userAgent: string,
  ) {}

  /** Loaded once per process; the table is static game data. */
  async load(): Promise<Map<number, string>> {
    if (this.map) return this.map;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchTable().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchTable(): Promise<Map<number, string>> {
    try {
      const res = await fetch(this.url, {
        headers: {
          'user-agent': this.userAgent,
          accept: '*/*',
          'sec-fetch-site': 'none',
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-dest': 'script',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.url}`);
      const map = parseAreaNames(await res.text());
      if (map.size === 0) throw new Error('wow.area.names not found in the global page data');
      this.map = map;
      logger.info('loaded %d area names', map.size);
      return map;
    } catch (err) {
      // Not fatal: rows keep their numeric ids and the tool still answers.
      logger.warn({ err, url: this.url }, 'area name table unavailable; leaving location ids as-is');
      return new Map();
    }
  }
}
