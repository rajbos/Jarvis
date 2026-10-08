/**
 * Unit tests for the plain-JS browser extension (src/browser-extension/*.js).
 *
 * The scripts are not modules: they are evaluated in a fresh `vm` context with a
 * hand-rolled `chrome`/`WebSocket`/`document` mock, mirroring how the browser
 * runs them. Top-level functions become properties of the context, and top-level
 * `let` state stays readable by evaluating further snippets in the same context.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EXT_DIR = path.resolve(__dirname, '../../src/browser-extension');
const read = (file: string) => fs.readFileSync(path.join(EXT_DIR, file), 'utf-8');

// ── Mocks ─────────────────────────────────────────────────────────────────────

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  handlers: Record<string, Array<(e: unknown) => void>> = {};
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.handlers[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  emit(type: string, event: unknown = {}) {
    for (const fn of this.handlers[type] ?? []) fn(event);
  }
}

interface FakeElement {
  click: ReturnType<typeof vi.fn>;
  submit?: ReturnType<typeof vi.fn>;
  value: string;
  dispatchEvent: ReturnType<typeof vi.fn>;
}

function makeElement(withSubmit = false): FakeElement {
  return {
    click: vi.fn(),
    ...(withSubmit ? { submit: vi.fn() } : {}),
    value: '',
    dispatchEvent: vi.fn(),
  };
}

function makeChrome(token?: unknown) {
  const messageListeners: Array<(...a: unknown[]) => unknown> = [];
  return {
    messageListeners,
    storage: {
      local: {
        get: vi.fn().mockResolvedValue(token === undefined ? {} : { jarvisToken: token }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: { addListener: (fn: (...a: unknown[]) => unknown) => messageListeners.push(fn) },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      reload: vi.fn(),
      captureVisibleTab: vi.fn(),
      remove: vi.fn(),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn() },
    windows: { update: vi.fn() },
  };
}

type Ctx = vm.Context & Record<string, (...args: unknown[]) => unknown>;

interface Harness {
  ctx: Ctx;
  chrome: ReturnType<typeof makeChrome>;
  timeouts: Array<{ fn: () => void; ms: number }>;
  intervals: Array<{ fn: () => void; ms: number }>;
  ev: <T = unknown>(code: string) => T;
}

async function loadBackground(token?: unknown, elements: Record<string, FakeElement> = {}): Promise<Harness> {
  FakeWebSocket.instances = [];
  const chrome = makeChrome(token);
  const timeouts: Harness['timeouts'] = [];
  const intervals: Harness['intervals'] = [];
  const ctx = vm.createContext({
    chrome,
    WebSocket: FakeWebSocket,
    URL,
    JSON,
    Math,
    Promise,
    Array,
    Error,
    Event: class { constructor(public type: string, public init?: unknown) {} },
    console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    self: { addEventListener: vi.fn() },
    document: { querySelector: (sel: string) => elements[sel] ?? null },
    setTimeout: (fn: () => void, ms: number) => timeouts.push({ fn, ms }),
    clearTimeout: vi.fn(),
    setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
    clearInterval: vi.fn(),
  }) as Ctx;
  vm.runInContext(read('background.js'), ctx);
  await flush();
  return { ctx, chrome, timeouts, intervals, ev: (code) => vm.runInContext(code, ctx) };
}

const flush = () => new Promise((r) => setImmediate(r));

// ── background.js ─────────────────────────────────────────────────────────────

describe('browser-extension background.js: connection', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it('does not open a socket and reports needsToken when no token is stored', async () => {
    const h = await loadBackground(undefined);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'status', connected: false, needsToken: true });
  });

  it('ignores a non-string stored token', async () => {
    await loadBackground(12345);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('treats a storage failure as "no token"', async () => {
    FakeWebSocket.instances = [];
    const chrome = makeChrome('x');
    chrome.storage.local.get.mockRejectedValue(new Error('boom'));
    const ctx = vm.createContext({
      chrome, WebSocket: FakeWebSocket, console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      self: { addEventListener: vi.fn() }, setTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(), clearTimeout: vi.fn(),
    });
    vm.runInContext(read('background.js'), ctx);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('connects to the loopback server and sends the stored token on open', async () => {
    await loadBackground('secret-token');
    expect(FakeWebSocket.instances).toHaveLength(1);
    const sock = FakeWebSocket.instances[0];
    expect(sock.url).toBe('ws://127.0.0.1:35789');
    sock.emit('open');
    expect(JSON.parse(sock.sent[0])).toEqual({ type: 'auth', token: 'secret-token' });
  });

  it('marks the bridge connected only after auth-ok, then starts keep-alive pings', async () => {
    const h = await loadBackground('t');
    const sock = FakeWebSocket.instances[0];
    sock.emit('open');
    expect(h.ev('isConnected')).toBe(false);

    sock.emit('message', { data: JSON.stringify({ type: 'auth-ok' }) });
    expect(h.ev('isConnected')).toBe(true);
    expect(h.chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '●' });
    expect(h.intervals).toHaveLength(1);
    expect(h.intervals[0].ms).toBe(20000);

    sock.readyState = FakeWebSocket.OPEN;
    h.intervals[0].fn();
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ type: 'ping' });
  });

  it('stays unauthenticated on auth-fail and flags an invalid token', async () => {
    const h = await loadBackground('t');
    const sock = FakeWebSocket.instances[0];
    sock.emit('message', { data: JSON.stringify({ type: 'auth-fail', reason: 'invalid-token' }) });
    expect(h.ev('isConnected')).toBe(false);
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'status', connected: false, invalidToken: true });
  });

  it('ignores malformed JSON during the auth handshake', async () => {
    const h = await loadBackground('t');
    FakeWebSocket.instances[0].emit('message', { data: 'not json' });
    expect(h.ev('isConnected')).toBe(false);
  });

  it('does not reconnect when the server closes with a token rejection', async () => {
    const h = await loadBackground('t');
    FakeWebSocket.instances[0].emit('close', { code: 1008, reason: 'invalid token' });
    expect(h.timeouts).toHaveLength(0);
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'status', connected: false, invalidToken: true });
  });

  it('reconnects with capped exponential backoff after other closes', async () => {
    const h = await loadBackground('t');
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      FakeWebSocket.instances.at(-1)!.emit('close', { code: 1006, reason: '' });
      const t = h.timeouts.at(-1)!;
      delays.push(t.ms);
      t.fn(); // fires the timer: clears reconnectTimer and connects again
      await flush();
    }
    expect(delays[0]).toBe(3000);
    expect(delays[1]).toBe(4500);
    expect(Math.max(...delays)).toBe(30000);
    expect(delays.slice(-1)[0]).toBe(30000);
  });

  it('resets the backoff after a successful authentication', async () => {
    const h = await loadBackground('t');
    FakeWebSocket.instances[0].emit('close', { code: 1006, reason: '' });
    expect(h.ev('reconnectDelay')).toBe(4500);
    h.timeouts.at(-1)!.fn();
    await flush();
    FakeWebSocket.instances.at(-1)!.emit('message', { data: JSON.stringify({ type: 'auth-ok' }) });
    expect(h.ev('reconnectDelay')).toBe(3000);
  });

  it('does not stack reconnect timers', async () => {
    const h = await loadBackground('t');
    h.ev('scheduleReconnect()');
    h.ev('scheduleReconnect()');
    expect(h.timeouts).toHaveLength(1);
  });
});

describe('browser-extension background.js: popup messages', () => {
  it('answers get-status with the current connection state', async () => {
    const h = await loadBackground('t');
    const respond = vi.fn();
    h.chrome.messageListeners[0]({ type: 'get-status' }, {}, respond);
    expect(respond).toHaveBeenCalledWith({ connected: false });
  });

  it('reconnects immediately on a reconnect message', async () => {
    const h = await loadBackground('t');
    const respond = vi.fn();
    h.chrome.messageListeners[0]({ type: 'reconnect' }, {}, respond);
    await flush();
    expect(respond).toHaveBeenCalledWith({ ok: true });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('browser-extension background.js: handleCommand', () => {
  async function connected() {
    const h = await loadBackground('t');
    const sock = FakeWebSocket.instances[0];
    sock.readyState = FakeWebSocket.OPEN;
    return { h, sock, send: async (cmd: unknown) => {
      await h.ctx.handleCommand(typeof cmd === 'string' ? cmd : JSON.stringify(cmd));
      return sock.sent.map((s) => JSON.parse(s)).filter((m) => m.id !== undefined).at(-1);
    } };
  }

  it('ignores invalid JSON and ping messages without responding', async () => {
    const { sock, send } = await connected();
    await send('{nope');
    await send({ type: 'ping' });
    expect(sock.sent).toHaveLength(0);
  });

  it('responds with an error for unknown command types', async () => {
    const { send } = await connected();
    const res = await send({ id: 'a', type: 'bogus' });
    expect(res).toEqual({ id: 'a', ok: false, error: 'Unknown command type: bogus' });
  });

  it('lists tabs, mapping only the documented fields', async () => {
    const { h, send } = await connected();
    h.chrome.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://a', title: 'A', active: true, windowId: 9, secret: 'x' },
    ]);
    const res = await send({ id: 'b', type: 'list-tabs' });
    expect(res).toEqual({ id: 'b', ok: true, data: [{ id: 1, url: 'https://a', title: 'A', active: true, windowId: 9 }] });
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'not a url'])(
    'rejects navigation to %s',
    async (url) => {
      const { h, send } = await connected();
      const res = await send({ id: 'n', type: 'navigate', tabId: 1, payload: { url } });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/Invalid or disallowed URL/);
      expect(h.chrome.tabs.update).not.toHaveBeenCalled();
    },
  );

  it('requires a url for navigate', async () => {
    const { send } = await connected();
    const res = await send({ id: 'n', type: 'navigate', tabId: 1, payload: {} });
    expect(res).toEqual({ id: 'n', ok: false, error: 'url is required' });
  });

  it('requires a selector for extract', async () => {
    const { send } = await connected();
    const res = await send({ id: 'e', type: 'extract', tabId: 1, payload: {} });
    expect(res).toEqual({ id: 'e', ok: false, error: 'selector is required' });
  });

  it('fails when there is no active tab and no tabId', async () => {
    const { send } = await connected();
    const res = await send({ id: 's', type: 'screenshot' });
    expect(res).toEqual({ id: 's', ok: false, error: 'No active tab found' });
  });

  it('captures a screenshot of the target tab window', async () => {
    const { h, send } = await connected();
    h.chrome.tabs.get.mockResolvedValue({ windowId: 4 });
    h.chrome.tabs.captureVisibleTab.mockResolvedValue('data:image/png;base64,AAA');
    const res = await send({ id: 's', type: 'screenshot', tabId: 7 });
    expect(res).toEqual({ id: 's', ok: true, data: { dataUrl: 'data:image/png;base64,AAA' } });
    expect(h.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(4, { format: 'png' });
  });

  it('evaluate injects executeInstructions with the testMode flag', async () => {
    const { h, send } = await connected();
    h.chrome.scripting.executeScript.mockResolvedValue([{ result: [{ ok: true }] }]);
    const res = await send({ id: 'v', type: 'evaluate', tabId: 3, payload: { instructions: 'click #a', testMode: true } });
    expect(res).toEqual({ id: 'v', ok: true, data: [{ ok: true }] });
    const call = h.chrome.scripting.executeScript.mock.calls[0][0];
    expect(call.target).toEqual({ tabId: 3 });
    expect(call.args).toEqual(['click #a', true]);
    expect(call.func.name).toBe('executeInstructions');
  });

  it('sends nothing when the socket is not open', async () => {
    const { sock, send } = await connected();
    sock.readyState = FakeWebSocket.CLOSED;
    await send({ id: 'x', type: 'bogus' });
    expect(sock.sent).toHaveLength(0);
  });
});

describe('browser-extension background.js: executeInstructions', () => {
  const run = async (instr: string, testMode: boolean, els: Record<string, FakeElement>) => {
    const h = await loadBackground(undefined, els);
    const out = (await h.ctx.executeInstructions(instr, testMode)) as { steps: Array<Record<string, unknown>>; testMode: boolean };
    expect(out.testMode).toBe(testMode);
    return out.steps;
  };

  it('returns an empty list for empty input and skips blank lines and comments', async () => {
    expect(await run('', false, {})).toEqual([]);
    expect(await run('\n  # a comment\n\n', false, {})).toEqual([]);
  });

  it('clicks an element', async () => {
    const el = makeElement();
    const res = await run('click #go', false, { '#go': el });
    expect(el.click).toHaveBeenCalledTimes(1);
    expect(res).toEqual([{ step: 'click #go', ok: true, testMode: false }]);
  });

  it('reports a missing element without throwing and keeps going', async () => {
    const el = makeElement();
    const res = await run('click #missing\nclick #go', false, { '#go': el });
    expect(res[0]).toEqual({ step: 'click #missing', ok: false, error: 'Element not found: #missing' });
    expect(res[1].ok).toBe(true);
    expect(el.click).toHaveBeenCalled();
  });

  it('testMode validates selectors but performs no side effects', async () => {
    const el = makeElement(true);
    const res = await run('click #a\nfill #a hello\nselect #a x\nsubmit #a', true, { '#a': el });
    expect(res.every((r) => r.ok === true && r.testMode === true)).toBe(true);
    expect(el.click).not.toHaveBeenCalled();
    expect(el.submit).not.toHaveBeenCalled();
    expect(el.dispatchEvent).not.toHaveBeenCalled();
    expect(el.value).toBe('');
  });

  it('fill sets the value (kept verbatim incl. spaces) and fires input+change', async () => {
    const el = makeElement();
    await run('fill #name Rob Bos  Jr', false, { '#name': el });
    expect(el.value).toBe('Rob Bos  Jr');
    expect(el.dispatchEvent.mock.calls.map((c) => c[0].type)).toEqual(['input', 'change']);
  });

  it('fill supports attribute selectors that contain no spaces', async () => {
    const el = makeElement();
    await run('fill input[data-testid="x"] some value', false, { 'input[data-testid="x"]': el });
    expect(el.value).toBe('some value');
  });

  it('known limitation: the selector token ends at the first space', async () => {
    const el = makeElement();
    const res = await run('fill form input value', false, { 'form input': el });
    expect(res[0].ok).toBe(false);
    expect(res[0].error).toBe('Element not found: form');
  });

  it('select sets the value and fires only change', async () => {
    const el = makeElement();
    await run('select #country NL', false, { '#country': el });
    expect(el.value).toBe('NL');
    expect(el.dispatchEvent.mock.calls.map((c) => c[0].type)).toEqual(['change']);
  });

  it('submit prefers form.submit() and falls back to click()', async () => {
    const form = makeElement(true);
    const btn = makeElement();
    await run('submit #form\nsubmit #btn', false, { '#form': form, '#btn': btn });
    expect(form.submit).toHaveBeenCalledTimes(1);
    expect(btn.click).toHaveBeenCalledTimes(1);
  });

  it('flags unknown instructions', async () => {
    const res = await run('dance #a', false, {});
    expect(res).toEqual([{ step: 'dance #a', ok: false, error: 'Unknown instruction' }]);
  });

  it('wait clamps to 10s and is skipped in testMode', async () => {
    const h = await loadBackground(undefined, {});
    const p = h.ctx.executeInstructions('wait 999999', false) as Promise<unknown>;
    await flush();
    expect(h.timeouts.at(-1)!.ms).toBe(10000);
    h.timeouts.at(-1)!.fn();
    await p;
    const before = h.timeouts.length;
    await h.ctx.executeInstructions('wait 500', true);
    expect(h.timeouts).toHaveLength(before);
  });

  it('matches step keywords case-insensitively', async () => {
    const el = makeElement();
    await run('CLICK #go', false, { '#go': el });
    expect(el.click).toHaveBeenCalled();
  });
});

// ── content.js ────────────────────────────────────────────────────────────────

describe('browser-extension content.js', () => {
  function loadContent(elements: Record<string, Record<string, unknown>> = {}, bodyText = 'x'.repeat(60000)) {
    const listeners: Array<(...a: unknown[]) => unknown> = [];
    const win: Record<string, unknown> = { location: { href: 'https://example.test/p' } };
    const ctx = vm.createContext({
      window: win,
      chrome: { runtime: { onMessage: { addListener: (fn: (...a: unknown[]) => unknown) => listeners.push(fn) } } },
      Array,
      Event: class { constructor(public type: string) {} },
      document: {
        title: 'T',
        body: { innerText: bodyText },
        querySelector: (s: string) => elements[s] ?? null,
        querySelectorAll: (s: string) => (elements[s] ? [elements[s]] : []),
      },
    });
    vm.runInContext(read('content.js'), ctx);
    const send = (msg: unknown) => {
      const respond = vi.fn();
      const ret = listeners[0](msg, {}, respond);
      return { respond, ret };
    };
    return { listeners, win, send, ctx };
  }

  it('registers exactly once, even if injected twice', () => {
    const a = loadContent();
    expect(a.listeners).toHaveLength(1);
    expect(a.win.__jarvisCompanionInjected).toBe(true);
    // Re-evaluating in the same context hits the double-injection guard
    vm.runInContext(read('content.js'), a.ctx);
    expect(a.listeners).toHaveLength(1);
  });

  it('ignores messages that do not come from the background worker', () => {
    const { send } = loadContent();
    const { respond, ret } = send({ type: 'get-content' });
    expect(respond).not.toHaveBeenCalled();
    expect(ret).toBeUndefined();
  });

  it('returns truncated page content', () => {
    const { send } = loadContent();
    const { respond, ret } = send({ source: 'jarvis-background', type: 'get-content' });
    expect(ret).toBe(true);
    const arg = respond.mock.calls[0][0];
    expect(arg.ok).toBe(true);
    expect(arg.data).toMatchObject({ title: 'T', url: 'https://example.test/p' });
    expect(arg.data.text).toHaveLength(50000);
  });

  it('extracts, clicks and fills elements', () => {
    const el = { tagName: 'A', innerText: ' hi ', value: undefined, href: 'https://h', click: vi.fn(), dispatchEvent: vi.fn() };
    const { send } = loadContent({ a: el });
    expect(send({ source: 'jarvis-background', type: 'extract', selector: 'a' }).respond.mock.calls[0][0].data)
      .toEqual([{ tag: 'a', text: 'hi', value: null, href: 'https://h' }]);
    expect(send({ source: 'jarvis-background', type: 'click', selector: 'a' }).respond).toHaveBeenCalledWith({ ok: true, data: { ok: true } });
    expect(el.click).toHaveBeenCalled();
    send({ source: 'jarvis-background', type: 'fill', selector: 'a', value: 'v' });
    expect(el.value).toBe('v');
    expect(el.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it('reports errors for missing elements and unknown message types', () => {
    const { send } = loadContent();
    expect(send({ source: 'jarvis-background', type: 'click', selector: '#nope' }).respond)
      .toHaveBeenCalledWith({ ok: false, error: 'Element not found: #nope' });
    expect(send({ source: 'jarvis-background', type: 'wat' }).respond.mock.calls[0][0].error)
      .toMatch(/Unknown content script message type: wat/);
  });
});

// ── popup.js ──────────────────────────────────────────────────────────────────

describe('browser-extension popup.js', () => {
  function loadPopup(storedToken?: string) {
    const els: Record<string, Record<string, unknown> & { listeners: Record<string, () => unknown> }> = {};
    for (const id of ['status', 'status-text', 'token-input', 'btn-save', 'saved-msg']) {
      els[id] = {
        className: '', textContent: '', value: '', style: {}, listeners: {},
        addEventListener(this: { listeners: Record<string, () => unknown> }, t: string, fn: () => unknown) { this.listeners[t] = fn; },
      };
    }
    const msgListeners: Array<(m: unknown) => void> = [];
    const chrome = {
      storage: { local: { get: vi.fn().mockResolvedValue(storedToken ? { jarvisToken: storedToken } : {}), set: vi.fn().mockResolvedValue(undefined) } },
      runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: (fn: (m: unknown) => void) => msgListeners.push(fn) },
      },
    };
    const timers: Array<() => void> = [];
    const ctx = vm.createContext({
      chrome,
      document: { getElementById: (id: string) => els[id] },
      setTimeout: (fn: () => void) => timers.push(fn),
    });
    vm.runInContext(read('popup.js'), ctx);
    return { els, chrome, msgListeners, timers };
  }

  it.each([
    [{ connected: true }, 'status-badge connected', 'Connected to Jarvis'],
    [{ connected: false, invalidToken: true }, 'status-badge invalid-token', 'Invalid token — update below'],
    [{ connected: false, needsToken: true }, 'status-badge disconnected', 'Token required — paste below'],
    [{ connected: false }, 'status-badge disconnected', 'Not connected — is Jarvis running?'],
  ])('renders status %j', (msg, cls, text) => {
    const { els, msgListeners } = loadPopup();
    msgListeners[0]({ type: 'status', ...msg });
    expect(els['status'].className).toBe(cls);
    expect(els['status-text'].textContent).toBe(text);
  });

  it('prefills the stored token', async () => {
    const { els } = loadPopup('abc');
    await flush();
    expect(els['token-input'].value).toBe('abc');
  });

  it('saves a trimmed token and asks the worker to reconnect', async () => {
    const { els, chrome, timers } = loadPopup();
    els['token-input'].value = '  tok  ';
    await els['btn-save'].listeners['click']();
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ jarvisToken: 'tok' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'reconnect' });
    expect((els['saved-msg'].style as Record<string, string>).display).toBe('block');
    timers[0]();
    expect((els['saved-msg'].style as Record<string, string>).display).toBe('none');
  });

  it('does nothing when the token is blank', async () => {
    const { els, chrome } = loadPopup();
    els['token-input'].value = '   ';
    await els['btn-save'].listeners['click']();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});
