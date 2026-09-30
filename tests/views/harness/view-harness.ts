/**
 * Node-side harness for running the renderer views in a headless browser.
 *
 *   1. Bundles the real renderer entry points (same esbuild options as
 *      `npm run build`) plus the fake `window.jarvis` into a temp dir.
 *   2. Serves that dir over http://127.0.0.1:<random port>.
 *   3. Opens a view in headless Chromium with the fake API injected before any
 *      page script runs, and every request that leaves the harness origin aborted.
 *
 * Usage from a test file:
 *
 *   const harness = useViewHarness();
 *   const view = await harness.open('index', { responses: { groupsList: [] } });
 *   await view.page.getByRole('button', { name: /Groups Dashboard/ }).click();
 *   expect(await view.calls('groupsList')).toHaveLength(1);
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import esbuild from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { options as rendererBuildOptions } from '../../../scripts/build-renderer.mjs';
import type { JarvisApi } from '../../../src/plugins/types';
import type { EventMethod, InvokeMethod, RecordedCall } from './mock-jarvis-api';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RENDERER_SRC = path.join(ROOT, 'src', 'renderer');
const MOCK_ENTRY = path.join(__dirname, 'mock-jarvis-api.ts');

/** The HTML pages Electron loads — one per BrowserWindow — plus test-only fixture pages. */
export type ViewName = 'index' | 'settings' | 'about' | 'error-boundary';

const ERROR_BOUNDARY_ENTRY = path.join(__dirname, 'error-boundary-fixture.tsx');

export interface OpenViewOptions {
  /** Per-view response overrides (JSON values) for fake `window.jarvis` methods. */
  responses?: Partial<{ [M in InvokeMethod]: Awaited<ReturnType<JarvisApi[M]>> }>;
  /** Pins the fixture clock (ms since epoch). Defaults to the real current time. */
  now?: number;
  /** Seeds localStorage before the page loads (e.g. chat panel open/closed). */
  localStorage?: Record<string, string>;
  viewport?: { width: number; height: number };
}

export interface OpenedView {
  page: Page;
  /** Uncaught exceptions and console.error output collected from the page. */
  errors: string[];
  /** URLs the page tried to reach outside the harness origin (all were aborted). */
  blockedRequests: string[];
  /** Recorded fake-API calls, optionally filtered by method name. */
  calls(method?: keyof JarvisApi): Promise<RecordedCall[]>;
  /** Fires a main → renderer push event (e.g. 'onChatToken') to the page's listeners. */
  emit(event: EventMethod, payload?: unknown): Promise<number>;
}

interface BuiltViews {
  dir: string;
  mockScript: string;
}

async function buildViews(): Promise<BuiltViews> {
  const dir = await mkdtemp(path.join(tmpdir(), 'jarvis-views-'));
  await esbuild.build({ ...rendererBuildOptions, outdir: dir, logLevel: 'warning', sourcemap: 'inline' });
  for (const file of await readdir(RENDERER_SRC)) {
    if (file.endsWith('.html')) await copyFile(path.join(RENDERER_SRC, file), path.join(dir, file));
  }
  // Test-only page: a throwing panel inside the real ErrorBoundary.
  await esbuild.build({
    ...rendererBuildOptions,
    entryPoints: { 'error-boundary': ERROR_BOUNDARY_ENTRY },
    outdir: dir,
    logLevel: 'warning',
    sourcemap: 'inline',
  });
  await writeFile(
    path.join(dir, 'error-boundary.html'),
    '<!doctype html><html><head><meta charset="UTF-8"><title>ErrorBoundary fixture</title></head>' +
      '<body><div id="app"></div><script src="error-boundary.js"></script></body></html>',
  );
  const mock = await esbuild.build({
    entryPoints: [MOCK_ENTRY],
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    logLevel: 'warning',
  });
  return { dir, mockScript: mock.outputFiles[0].text };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

function serve(dir: string): Promise<Server> {
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = path.join(dir, path.normalize(urlPath).replace(/^([/\\])+/, ''));
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    readFile(file).then(
      (body) => res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body),
      () => res.writeHead(404).end(),
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Launches Playwright's bundled Chromium; when it is not installed (no
 * `npx playwright install chromium` yet) falls back to a locally installed
 * Edge or Chrome so the tests still run on a dev machine. Set
 * JARVIS_VIEW_BROWSER_CHANNEL to force a channel.
 */
async function launchBrowser(): Promise<Browser> {
  const forced = process.env.JARVIS_VIEW_BROWSER_CHANNEL;
  if (forced) return chromium.launch({ channel: forced });
  const failures: string[] = [];
  for (const channel of [undefined, 'msedge', 'chrome']) {
    try {
      return await chromium.launch(channel ? { channel } : {});
    } catch (err) {
      failures.push(`${channel ?? 'bundled chromium'}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`No headless browser available. Run "npx playwright install chromium".\n${failures.join('\n')}`);
}

export class ViewHarness {
  private built?: BuiltViews;
  private server?: Server;
  private browser?: Browser;
  private contexts: BrowserContext[] = [];
  private origin = '';

  async start(): Promise<void> {
    this.built = await buildViews();
    this.server = await serve(this.built.dir);
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.browser = await launchBrowser();
  }

  async open(view: ViewName, opts: OpenViewOptions = {}): Promise<OpenedView> {
    if (!this.browser || !this.built) throw new Error('ViewHarness.start() has not run');
    const context = await this.browser.newContext({ viewport: opts.viewport ?? { width: 1400, height: 900 } });
    this.contexts.push(context);

    const blockedRequests: string[] = [];
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(this.origin)) return route.continue();
      blockedRequests.push(url);
      return route.abort('blockedbyclient');
    });

    await context.addInitScript(
      ({ responses, now, storage }) => {
        window.__JARVIS_VIEW_OVERRIDES__ = responses;
        if (now !== undefined) window.__JARVIS_VIEW_NOW__ = now;
        for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
      },
      { responses: opts.responses ?? {}, now: opts.now, storage: opts.localStorage ?? {} },
    );
    await context.addInitScript({ content: this.built.mockScript });

    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(`${this.origin}/${view}.html`);

    return {
      page,
      errors,
      blockedRequests,
      calls: (method) =>
        page.evaluate((m) => window.__jarvisTest.calls.filter((c) => !m || c.method === m), method),
      emit: (event, payload) =>
        page.evaluate(({ e, p }) => window.__jarvisTest.emit(e, p), { e: event, p: payload }),
    };
  }

  /** Closes every page opened since the last reset (keeps the browser warm). */
  async closePages(): Promise<void> {
    await Promise.all(this.contexts.map((c) => c.close()));
    this.contexts = [];
  }

  async stop(): Promise<void> {
    await this.closePages();
    await this.browser?.close();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    if (this.built) await rm(this.built.dir, { recursive: true, force: true });
  }
}

/** Registers vitest hooks that start one harness per test file and close pages after each test. */
export function useViewHarness(): ViewHarness {
  const harness = new ViewHarness();
  beforeAll(() => harness.start(), 120_000);
  afterEach(() => harness.closePages());
  afterAll(() => harness.stop());
  return harness;
}
