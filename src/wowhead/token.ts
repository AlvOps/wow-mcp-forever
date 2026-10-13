/**
 * Entity pages on Wowhead sit behind an AWS WAF JavaScript challenge: a plain
 * fetch gets HTTP 202 carrying a `window.gokuProps` interstitial instead of the
 * page. Getting past it needs a real browser, which leaves an `aws-waf-token`
 * cookie behind. That cookie is NOT bound to the client IP or the User-Agent
 * (verified empirically), so a plain fetch carrying it — together with the
 * Sec-Fetch headers — receives the real HTML, Listview tables included, for
 * several days.
 *
 * So we mint a token with headless Chromium when we don't have a fresh one, and
 * otherwise stay an ordinary HTTP client.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from '../util/logger.js';

/**
 * Chromium's own headless UA is blocked outright; a plausible one is required.
 * The HTTP client sends the same one so browser and fetches look identical.
 */
export const REAL_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

/** Any challenged page works and it only has to load enough to set the cookie. */
const MINT_URL = 'https://www.wowhead.com/forever/items';

interface StoredToken {
  token: string;
  mintedAt: number;
}

function which(bin: string): string | undefined {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

/** Locate a Chromium binary: explicit path, PATH, then Playwright's user download. */
export function findChrome(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    const found = which(name);
    if (found) return found;
  }
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(root)) {
    for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium'))) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = join(root, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

export class WafTokenStore {
  /** One mint at a time: parallel fetches must not each launch a browser. */
  private inFlight?: Promise<string | undefined>;

  constructor(
    private readonly file: string,
    private readonly chromePath: string | undefined,
    private readonly maxAgeHours: number,
  ) {}

  /** A token we already hold that is still considered fresh. */
  get(): string | undefined {
    const stored = this.read();
    if (!stored) return undefined;
    const ageMs = Date.now() - stored.mintedAt;
    if (ageMs > this.maxAgeHours * 3_600_000) return undefined;
    return stored.token;
  }

  /**
   * Fresh token if we have one, otherwise mint one with a browser.
   * Pass `force` after Wowhead served a challenge despite a token we believed
   * was still good.
   */
  async getOrMint(force = false): Promise<string | undefined> {
    const cached = force ? undefined : this.get();
    if (cached) return cached;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.mint().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async mint(): Promise<string | undefined> {
    const chrome = this.chromePath ?? findChrome();
    if (!chrome) {
      logger.warn('no Chromium found: cannot mint an aws-waf-token, entity pages will fail');
      return undefined;
    }
    try {
      const token = await mintWithBrowser(chrome, MINT_URL);
      if (!token) return undefined;
      this.write(token);
      return token;
    } catch (err) {
      logger.error({ err }, 'aws-waf-token mint failed');
      return undefined;
    }
  }

  private read(): StoredToken | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoredToken;
      return typeof raw?.token === 'string' && raw.token ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  private write(token: string): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ token, mintedAt: Date.now() }, null, 2), { mode: 0o600 });
      logger.info('minted a fresh aws-waf-token (valid ~%dh)', this.maxAgeHours);
    } catch (err) {
      logger.warn({ err, file: this.file }, 'could not persist the WAF token');
    }
  }
}

async function waitForTarget(port: number, timeoutMs: number): Promise<{ webSocketDebuggerUrl: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl };
    } catch {
      /* browser not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return undefined;
}

/**
 * Load a challenged page in headless Chromium and read the decrypted
 * `aws-waf-token` cookie back over CDP. (Reading it from the on-disk cookie
 * store does NOT work — Chromium keeps the value encrypted.)
 */
export async function mintWithBrowser(chrome: string, url: string): Promise<string | undefined> {
  const WS = (globalThis as { WebSocket?: unknown }).WebSocket as
    | (new (url: string) => WebSocket)
    | undefined;
  if (!WS) throw new Error('global WebSocket unavailable — Node 22+ required');

  const port = 9200 + Math.floor(Math.random() * 700);
  const profile = mkdtempSync(join(tmpdir(), 'wow-waf-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--user-agent=${REAL_UA}`,
      `--remote-debugging-port=${port}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const target = await waitForTarget(port, 30_000);
    if (!target) throw new Error('Chromium did not expose a CDP target');

    const ws = new WS(target.webSocketDebuggerUrl);
    let nextId = 0;
    const pending = new Map<number, (msg: any) => void>();
    const call = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const msg = JSON.parse(String(event.data)) as { id?: number };
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* ignore non-JSON frames */
      }
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('CDP socket error')));
    });

    await call('Network.enable');
    await call('Page.enable');
    await call('Page.navigate', { url });
    // The challenge script runs after load; give it room to set the cookie.
    await new Promise((r) => setTimeout(r, 12_000));

    const cookies = await call('Network.getAllCookies');
    const token = (cookies?.result?.cookies ?? []).find(
      (c: { name: string; value: string }) => c.name === 'aws-waf-token',
    )?.value as string | undefined;

    try {
      ws.close();
    } catch {
      /* already closing */
    }
    return token || undefined;
  } finally {
    child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }
}
