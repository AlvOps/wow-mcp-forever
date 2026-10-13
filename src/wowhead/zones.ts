/**
 * Global name tables (areas, skills, NPC classifications, currencies).
 *
 * Listview rows carry `location: [405]` — numeric area ids — and similar ids
 * for skills (`skill: [171]`), NPC rank (`classification: 1`) and currencies.
 * A model given only ids will otherwise invent the names from its own
 * knowledge. That looks authoritative in an answer and is not: it is not the
 * data source speaking.
 *
 * Wowhead's own global page data carries these id -> name tables
 * (`wow.area.names`, `wow.skill.names`, `wow.npc.classifications`,
 * `wow.currency.namesAndIcons`; on nether.wowhead.com, i.e. NOT behind the
 * entity-page WAF challenge). One small request names every row.
 */
import { extractBalanced } from './parse.js';
import { logger } from '../util/logger.js';

/** Parse `WH.setPageData("<key>", {...})` out of the global page data. */
export function parsePageDataObject(text: string, key: string): Record<string, unknown> | undefined {
  const needle = `"${key}"`;
  const at = text.indexOf(needle);
  if (at < 0) return undefined;
  const start = text.indexOf('{', at + needle.length);
  if (start < 0) return undefined;
  // The value must directly follow the key (`"key",{`); otherwise we would
  // read the next key's object.
  if (!/^\s*,\s*$/.test(text.slice(at + needle.length, start))) return undefined;
  const objText = extractBalanced(text, start);
  if (!objText) return undefined;
  try {
    const raw = JSON.parse(objText) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Numeric id -> name map for a page-data key. Values may be strings or `{name}` objects. */
export function parseNameTable(text: string, key: string): Map<number, string> {
  const raw = parsePageDataObject(text, key);
  const map = new Map<number, string>();
  if (!raw) return map;
  for (const [id, v] of Object.entries(raw)) {
    const n = Number(id);
    const name =
      typeof v === 'string' ? v : v && typeof v === 'object' ? (v as Record<string, unknown>)['name'] : undefined;
    if (Number.isFinite(n) && typeof name === 'string' && name) map.set(n, name);
  }
  return map;
}

/** Parse `WH.setPageData("wow.area.names", {...})` out of the global page data. */
export function parseAreaNames(text: string): Map<number, string> {
  return parseNameTable(text, 'wow.area.names');
}

export interface GlobalNames {
  areas: Map<number, string>;
  skills: Map<number, string>;
  classifications: Map<number, string>;
  currencies: Map<number, string>;
}

const EMPTY = (): GlobalNames => ({
  areas: new Map(),
  skills: new Map(),
  classifications: new Map(),
  currencies: new Map(),
});

export function parseGlobalNames(text: string): GlobalNames {
  return {
    areas: parseAreaNames(text),
    skills: parseNameTable(text, 'wow.skill.names'),
    classifications: parseNameTable(text, 'wow.npc.classifications'),
    currencies: parseNameTable(text, 'wow.currency.namesAndIcons'),
  };
}

export class AreaNames {
  private tables?: GlobalNames;
  private inFlight?: Promise<GlobalNames>;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly userAgent: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  /** Area id -> name. Loaded once per process; the table is static game data. */
  async load(): Promise<Map<number, string>> {
    return (await this.loadAll()).areas;
  }

  /** Every global name table, loaded in one request. */
  async loadAll(): Promise<GlobalNames> {
    if (this.tables) return this.tables;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchTable().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchTable(): Promise<GlobalNames> {
    try {
      const res = await this.doFetch(this.url, {
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
      const tables = parseGlobalNames(await res.text());
      if (tables.areas.size === 0) throw new Error('wow.area.names not found in the global page data');
      this.tables = tables;
      logger.info(
        'loaded %d area, %d skill, %d classification, %d currency names',
        tables.areas.size,
        tables.skills.size,
        tables.classifications.size,
        tables.currencies.size,
      );
      return tables;
    } catch (err) {
      // Not fatal: the affected fields are left out of rows (never shown as ids).
      logger.warn({ err, url: this.url }, 'global name tables unavailable');
      return EMPTY();
    }
  }
}
