/**
 * Jarvis Browser Companion — Background Service Worker
 *
 * Maintains a persistent WebSocket connection to the Jarvis desktop app
 * running on the local machine. Routes commands from Jarvis to the active
 * browser tab and sends results back.
 *
 * Protocol (JSON over WebSocket):
 *   Jarvis → Extension:  BridgeCommand  { id, type, tabId?, payload }
 *   Extension → Jarvis:  BridgeResponse { id, ok, data?, error? }
 *                        BridgeEvent    { type, data? }
 */

const JARVIS_WS_URL = 'ws://127.0.0.1:35789';
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;
const KEEP_ALIVE_INTERVAL_MS = 20000;
const MAX_TEXT_LENGTH = 50000;
const MAX_HTML_LENGTH = 200000;

let ws = null;
let reconnectDelay = RECONNECT_DELAY_MS;
let reconnectTimer = null;
let keepAliveTimer = null;
let isConnected = false;

// ── Connection management ─────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log('[JarvisBridge] Connecting to', JARVIS_WS_URL);
  try {
    ws = new WebSocket(JARVIS_WS_URL);
  } catch (e) {
    console.warn('[JarvisBridge] Could not create WebSocket:', e);
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    console.log('[JarvisBridge] Connected to Jarvis desktop app');
    isConnected = true;
    reconnectDelay = RECONNECT_DELAY_MS; // reset backoff
    updateBadge(true);
    startKeepAlive();
    notifyPopup({ type: 'status', connected: true });
  });

  ws.addEventListener('message', (event) => {
    handleCommand(event.data);
  });

  ws.addEventListener('close', (event) => {
    console.log('[JarvisBridge] Disconnected', event.code, event.reason);
    isConnected = false;
    updateBadge(false);
    stopKeepAlive();
    notifyPopup({ type: 'status', connected: false });
    scheduleReconnect();
  });

  ws.addEventListener('error', (event) => {
    console.warn('[JarvisBridge] WebSocket error:', event);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  // Exponential backoff, capped
  reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY_MS);
}

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Service workers can be unloaded; sending a ping keeps the connection alive
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, KEEP_ALIVE_INTERVAL_MS);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function updateBadge(connected) {
  chrome.action.setBadgeText({ text: connected ? '●' : '' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#4caf50' : '#f44336' });
}

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* popup may not be open */ });
}

// ── Command handling ──────────────────────────────────────────────────────────

async function handleCommand(rawData) {
  let cmd;
  try {
    cmd = JSON.parse(rawData);
  } catch {
    console.warn('[JarvisBridge] Invalid JSON from Jarvis');
    return;
  }

  // Ignore keep-alive pings
  if (cmd.type === 'ping') return;

  const { id, type, tabId, payload } = cmd;

  try {
    let data;
    switch (type) {
      case 'navigate':
        data = await cmdNavigate(tabId, payload);
        break;
      case 'evaluate':
        data = await cmdEvaluate(tabId, payload);
        break;
      case 'extract':
        data = await cmdExtract(tabId, payload);
        break;
      case 'click':
        data = await cmdClick(tabId, payload);
        break;
      case 'fill':
        data = await cmdFill(tabId, payload);
        break;
      case 'screenshot':
        data = await cmdScreenshot(tabId, payload);
        break;
      case 'list-tabs':
        data = await cmdListTabs();
        break;
      case 'get-page-content':
        data = await cmdGetPageContent(tabId);
        break;
      case 'focus-window':
        data = await cmdFocusWindow(tabId);
        break;
      default:
        throw new Error(`Unknown command type: ${type}`);
    }
    sendResponse({ id, ok: true, data });
  } catch (err) {
    sendResponse({ id, ok: false, error: err.message ?? String(err) });
  }
}

function sendResponse(response) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(response));
  }
}

// ── Tab helpers ───────────────────────────────────────────────────────────────

async function getTargetTabId(preferredTabId) {
  if (typeof preferredTabId === 'number') return preferredTabId;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
}

// ── Command implementations ───────────────────────────────────────────────────

async function cmdNavigate(tabId, payload) {
  const { url } = payload;
  if (!url) throw new Error('url is required');

  const targetTabId = await getTargetTabId(tabId);
  await chrome.tabs.update(targetTabId, { url });

  // Wait for the page to finish loading
  await waitForTabLoaded(targetTabId);
  const tab = await chrome.tabs.get(targetTabId);
  return { url: tab.url, title: tab.title, tabId: targetTabId };
}

async function cmdEvaluate(tabId, payload) {
  const { instructions, testMode } = payload;
  const targetTabId = await getTargetTabId(tabId);

  // Inject content script message to execute the steps
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: executeInstructions,
    args: [instructions, testMode === true],
  });

  return results[0]?.result ?? null;
}
async function cmdExtract(tabId, payload) {
  const { selector } = payload;
  if (!selector) throw new Error('selector is required');
  const targetTabId = await getTargetTabId(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: extractBySelector,
    args: [selector],
  });

  return results[0]?.result ?? null;
}

async function cmdClick(tabId, payload) {
  const { selector } = payload;
  if (!selector) throw new Error('selector is required');
  const targetTabId = await getTargetTabId(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: clickElement,
    args: [selector],
  });

  return results[0]?.result ?? null;
}

async function cmdFill(tabId, payload) {
  const { selector, value } = payload;
  if (!selector) throw new Error('selector is required');
  if (value === undefined) throw new Error('value is required');
  const targetTabId = await getTargetTabId(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: fillElement,
    args: [selector, String(value)],
  });

  return results[0]?.result ?? null;
}

async function cmdScreenshot(tabId, _payload) {
  const targetTabId = await getTargetTabId(tabId);
  const tab = await chrome.tabs.get(targetTabId);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return { dataUrl };
}

async function cmdListTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }));
}

async function cmdGetPageContent(tabId) {
  const targetTabId = await getTargetTabId(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: getPageContent,
    args: [MAX_TEXT_LENGTH, MAX_HTML_LENGTH],
  });

  return results[0]?.result ?? null;
}

async function cmdFocusWindow(tabId) {
  // Determine which window to focus.
  // If a specific tab is requested, bring that tab's window to the front.
  // Otherwise focus the last-focused window that contains a normal tab.
  let windowId;
  if (typeof tabId === 'number') {
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
  } else {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    windowId = tab?.windowId;
  }
  if (windowId === undefined) throw new Error('No browser window found');
  await chrome.windows.update(windowId, { focused: true });
  return { ok: true, windowId };
}

// ── Tab load helper ───────────────────────────────────────────────────────────

function waitForTabLoaded(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab navigation timeout'));
    }, 15000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Small delay to allow page scripts to run
        setTimeout(resolve, 300);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Page functions (injected into tabs via chrome.scripting.executeScript) ────
// These must be self-contained — no closure variables from the service worker.

/**
 * Parses simple step instructions and executes them in the page.
 * Instructions format (one step per line):
 *   navigate <url>
 *   click <selector>
 *   fill <selector> <value>
 *   select <selector> <value>
 *   wait <ms>
 *   submit <selector>
 *
 * Returns a summary of steps executed.
 * NOTE: This is an async function so `wait` steps use proper async delay
 * rather than a busy loop. chrome.scripting.executeScript handles Promise results.
 */
async function executeInstructions(instructions, testMode) {
  const lines = (instructions || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const results = [];

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (lower.startsWith('click ')) {
      const selector = line.slice(6).trim();
      const el = document.querySelector(selector);
      if (!el) {
        results.push({ step: line, ok: false, error: `Element not found: ${selector}` });
        continue;
      }
      if (!testMode) el.click();
      results.push({ step: line, ok: true, testMode });

    } else if (lower.startsWith('fill ')) {
      // fill <selector> <value>  (value is everything after the selector token)
      const rest = line.slice(5).trim();
      const spaceIdx = rest.indexOf(' ');
      const selector = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const value = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
      const el = document.querySelector(selector);
      if (!el) {
        results.push({ step: line, ok: false, error: `Element not found: ${selector}` });
        continue;
      }
      if (!testMode) {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      results.push({ step: line, ok: true, testMode });

    } else if (lower.startsWith('select ')) {
      const rest = line.slice(7).trim();
      const spaceIdx = rest.indexOf(' ');
      const selector = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const value = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
      const el = document.querySelector(selector);
      if (!el) {
        results.push({ step: line, ok: false, error: `Element not found: ${selector}` });
        continue;
      }
      if (!testMode) {
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      results.push({ step: line, ok: true, testMode });

    } else if (lower.startsWith('submit ')) {
      const selector = line.slice(7).trim();
      const el = document.querySelector(selector);
      if (!el) {
        results.push({ step: line, ok: false, error: `Element not found: ${selector}` });
        continue;
      }
      if (!testMode) {
        if (typeof el.submit === 'function') el.submit();
        else el.click();
      }
      results.push({ step: line, ok: true, testMode });

    } else if (lower.startsWith('wait ')) {
      const ms = parseInt(line.slice(5).trim(), 10);
      const clampedMs = Math.min(Math.max(ms, 0), 10000);
      if (!isNaN(ms) && clampedMs > 0 && !testMode) {
        await new Promise((resolve) => setTimeout(resolve, clampedMs));
      }
      results.push({ step: line, ok: true, testMode });

    } else {
      results.push({ step: line, ok: false, error: 'Unknown instruction' });
    }
  }

  return { steps: results, testMode };
}

/**
 * Extract text content from elements matching a CSS selector.
 */
function extractBySelector(selector) {
  const elements = Array.from(document.querySelectorAll(selector));
  return elements.map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: el.innerText?.trim() ?? el.textContent?.trim() ?? '',
    html: el.innerHTML,
    value: el.value ?? null,
    href: el.href ?? null,
  }));
}

/**
 * Click an element matching a CSS selector.
 */
function clickElement(selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: `Element not found: ${selector}` };
  el.click();
  return { ok: true };
}

/**
 * Fill an input/textarea/select with a value.
 */
function fillElement(selector, value) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: `Element not found: ${selector}` };
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}

/**
 * Return the page's visible text content and title.
 * Lengths are capped to avoid sending too much data over the bridge.
 */
function getPageContent(maxTextLength, maxHtmlLength) {
  return {
    title: document.title,
    url: window.location.href,
    text: document.body?.innerText?.slice(0, maxTextLength) ?? '',
    html: document.documentElement.outerHTML.slice(0, maxHtmlLength),
  };
}

// ── Message handler (from popup / content scripts) ───────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get-status') {
    sendResponse({ connected: isConnected });
    return true;
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[JarvisBridge] Extension installed/updated');
  connect();
});

chrome.runtime.onStartup.addListener(() => {
  connect();
});

// Connect immediately when service worker starts
connect();

// Re-connect if the service worker wakes up and isn't connected
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && !isConnected) {
    connect();
  }
});
