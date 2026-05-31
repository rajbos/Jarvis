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

// Catch unhandled errors/rejections so they appear in the SW inspector instead of silently killing the worker
self.addEventListener('unhandledrejection', (event) => {
  console.error('[JarvisBridge] Unhandled rejection:', event.reason);
});
self.addEventListener('error', (event) => {
  console.error('[JarvisBridge] Unhandled error:', event.message, '@', event.filename, event.lineno);
});
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;
const KEEP_ALIVE_INTERVAL_MS = 20000;
const MAX_TEXT_LENGTH = 50000;
const MAX_HTML_LENGTH = 200000;

let ws = null;
let reconnectDelay = RECONNECT_DELAY_MS;
let reconnectTimer = null;
let keepAliveTimer = null;
let isConnected = false;   // true only after auth-ok received
let isAuthenticated = false;

// ── Token storage ─────────────────────────────────────────────────────────────

async function getStoredToken() {
  try {
    const result = await chrome.storage.local.get('jarvisToken');
    return typeof result.jarvisToken === 'string' ? result.jarvisToken : null;
  } catch {
    return null;
  }
}

async function setStoredToken(token) {
  await chrome.storage.local.set({ jarvisToken: token });
}

// ── Connection management ─────────────────────────────────────────────────────

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const token = await getStoredToken();
  if (!token) {
    console.log('[JarvisBridge] No pairing token configured — not connecting. Open the extension popup to set the token.');
    notifyPopup({ type: 'status', connected: false, needsToken: true });
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
    try {
      console.log('[JarvisBridge] Socket open — sending auth');
      isAuthenticated = false;
      // Send auth token immediately; wait for auth-ok before marking connected
      ws.send(JSON.stringify({ type: 'auth', token }));
    } catch (e) {
      console.error('[JarvisBridge] Error in open handler:', e);
    }
  });

  ws.addEventListener('message', (event) => {
    if (!isAuthenticated) {
      handleAuthResponse(event.data);
      return;
    }
    handleCommand(event.data);
  });

  ws.addEventListener('close', (event) => {
    console.log('[JarvisBridge] Disconnected', event.code, event.reason);
    isConnected = false;
    isAuthenticated = false;
    updateBadge(false);
    stopKeepAlive();
    notifyPopup({ type: 'status', connected: false });
    // Don't reconnect if the server rejected our token
    if (event.code === 1008 && event.reason && event.reason.includes('token')) {
      console.warn('[JarvisBridge] Token rejected by server. Open the extension popup to update the token.');
      notifyPopup({ type: 'status', connected: false, invalidToken: true });
    } else {
      scheduleReconnect();
    }
  });

  ws.addEventListener('error', (event) => {
    console.warn('[JarvisBridge] WebSocket error:', event);
  });
}

function handleAuthResponse(rawData) {
  let msg;
  try { msg = JSON.parse(rawData); } catch { return; }

  if (msg.type === 'auth-ok') {
    isAuthenticated = true;
    isConnected = true;
    reconnectDelay = RECONNECT_DELAY_MS; // reset backoff
    updateBadge(true);
    startKeepAlive();
    notifyPopup({ type: 'status', connected: true });
    console.log('[JarvisBridge] Authenticated — ready');
  } else if (msg.type === 'auth-fail') {
    console.warn('[JarvisBridge] Authentication failed:', msg.reason);
    notifyPopup({ type: 'status', connected: false, invalidToken: msg.reason === 'invalid-token' });
    // The server will close the socket; let the close handler take over
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
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
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => { /* popup not open */ });
  } catch {
    // extension context not ready or no listeners — ignore
  }
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
      case 'scroll-extract':
        data = await cmdScrollExtract(tabId, payload);
        break;
      case 'scrape-stats':
        data = await cmdScrapeStats(tabId, payload);
        break;
      case 'read-form-fields':
        data = await cmdReadFormFields(tabId, payload);
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
    const errMsg = err.message ?? String(err);
    console.error('[JarvisBridge] Command "%s" failed:', String(type), errMsg, err);
    sendResponse({ id, ok: false, error: errMsg });
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

  // Defense-in-depth: validate URL scheme (server also validates, but this is a local guard)
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`URL scheme "${parsed.protocol}" is not allowed`);
    }
  } catch (e) {
    throw new Error(`Invalid or disallowed URL: ${e.message}`);
  }

  const targetTabId = await getTargetTabId(tabId);

  // If the tab is already on the target URL, use reload() to guarantee a
  // clean page state.  Calling tabs.update() with the same URL can be a no-op
  // in some browsers (the SPA stays in whatever — possibly scrolled — state it
  // was in), which breaks virtual-list scraping (e.g. Ruddr projects).
  let alreadyOnUrl = false;
  try {
    const currentTab = await chrome.tabs.get(targetTabId);
    alreadyOnUrl = currentTab.url === url;
  } catch (_) { /* tab may not exist yet — fall through to tabs.update */ }

  if (alreadyOnUrl) {
    console.log('[JarvisBridge] Tab already on target URL — reloading for clean state');
    await chrome.tabs.reload(targetTabId);
  } else {
    await chrome.tabs.update(targetTabId, { url });
  }

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

async function cmdScrollExtract(tabId, payload) {
  const { selector, maxScrolls = 30, waitMs = 700, includeHref = false, debug = false } = payload;
  if (!selector) throw new Error('selector is required');
  const targetTabId = await getTargetTabId(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: scrollAndExtract,
    args: [selector, maxScrolls, waitMs, includeHref, debug],
  });

  return results[0]?.result ?? null;
}

async function cmdScrapeStats(tabId, payload) {
  const { waitMs = 3000 } = payload;
  const targetTabId = await getTargetTabId(tabId);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: scrapeStatsByLabel,
    args: [waitMs],
  });

  return results[0]?.result ?? null;
}

// Runs inside the page — scrolls the virtual list until no new items appear.
// Uses a poll-then-scroll strategy to handle SPAs that render their lists
// asynchronously after navigation (e.g. Ruddr's React virtual table).
// When includeHref is true each result includes the href of the closest <a> ancestor.
// When debug is true, returns { items, debugLog } instead of just items.
async function scrollAndExtract(selector, maxScrolls, waitMs, includeHref, debug = false) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const debugLog = [];
  const log = (msg) => { if (debug) debugLog.push(msg); console.log(`[JarvisBridge] ${msg}`); };

  // Returns a Map<text, item> — deduplicates by text content.
  const getItems = () => {
    const map = new Map();
    document.querySelectorAll(selector).forEach((el) => {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || map.has(text)) return;
      const item = { text };
      if (includeHref) {
        const anchor = el.tagName === 'A' ? el : el.closest('a');
        item.href = anchor ? (anchor.getAttribute('href') || '') : '';
      }
      map.set(text, item);
    });
    return map;
  };

  // Find the scrollable container for virtual list items.
  // Walk up from a sample element and find the ancestor with the LARGEST scroll range.
  // Virtual lists have huge scrollHeight (all items) but small clientHeight (viewport).
  // We skip shallow scrollers (like page MAIN) that only scroll a few hundred pixels.
  const findScrollContainer = (sampleEl) => {
    let el = sampleEl.parentElement;
    let best = null;
    let bestRange = 0;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      const overflowY = style.overflowY;
      // Check if this element can scroll vertically
      if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        const scrollRange = el.scrollHeight - el.clientHeight;
        // Prefer containers with larger scroll ranges - virtual lists have thousands of pixels
        if (scrollRange > bestRange) {
          best = el;
          bestRange = scrollRange;
        }
      }
      el = el.parentElement;
    }
    
    // Also check siblings near the list items - some virtual lists put the scroller
    // as a sibling wrapper rather than ancestor
    const parent = sampleEl.closest('[class*="virtual"], [class*="list"], [class*="table"], [class*="grid"]')?.parentElement;
    if (parent) {
      for (const sibling of parent.children) {
        const style = getComputedStyle(sibling);
        const overflowY = style.overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && sibling.scrollHeight > sibling.clientHeight) {
          const scrollRange = sibling.scrollHeight - sibling.clientHeight;
          if (scrollRange > bestRange) {
            best = sibling;
            bestRange = scrollRange;
          }
        }
      }
    }
    
    return best; // returns the scrollable container with the largest range
  };

  // Wait for at least one element to appear — SPA may not have rendered yet at
  // the point this function is injected (React renders asynchronously after
  // document.readyState === 'complete').  Poll up to 10 s before giving up.
  let firstEl = document.querySelector(selector);
  if (!firstEl) {
    log(`No elements found for "${selector}", polling...`);
    for (let attempt = 0; attempt < 20 && !firstEl; attempt++) {
      await wait(500);
      firstEl = document.querySelector(selector);
    }
  }

  const collected = new Map(getItems());
  log(`scrollAndExtract start — selector="${selector}", initial=${collected.size}, url=${window.location.href}`);

  // Try to find the virtual list's scroll container
  let scrollContainer = firstEl ? findScrollContainer(firstEl) : null;
  
  // Also check document.documentElement - some SPAs scroll the whole page
  const docScrollRange = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  const containerScrollRange = scrollContainer ? (scrollContainer.scrollHeight - scrollContainer.clientHeight) : 0;
  
  if (docScrollRange > containerScrollRange && docScrollRange > 500) {
    log(`Document has larger scroll range (${docScrollRange}px vs ${containerScrollRange}px), using document scrolling`);
    scrollContainer = null; // use window.scrollBy instead
  } else if (scrollContainer) {
    log(`Found scroll container: ${scrollContainer.tagName}.${scrollContainer.className.split(' ')[0]}, scrollHeight=${scrollContainer.scrollHeight}, clientHeight=${scrollContainer.clientHeight}`);
  } else {
    log(`No scroll container found, will use window.scrollBy`);
  }

  // Ruddr (and many SPAs) use a VIRTUAL list — only visible rows exist in the
  // DOM at any time.  We scroll the container directly by manipulating scrollTop.
  // This triggers the scroll event listeners that virtual lists use to load more items.
  //
  // Require 3 consecutive iterations with no new items before stopping.
  const scrollStep = scrollContainer ? Math.floor(scrollContainer.clientHeight * 0.8) : (window.innerHeight || 800);
  let stableRounds = 0;
  let useScrollIntoView = false; // fallback if scrollTop doesn't work
  for (let i = 0; i < maxScrolls; i++) {
    const before = collected.size;

    // Get all current elements for scrollIntoView fallback
    const allEls = document.querySelectorAll(selector);
    const lastEl = allEls.length > 0 ? allEls[allEls.length - 1] : null;

    // Scroll the container (or window) by a fixed amount
    if (scrollContainer && !useScrollIntoView) {
      const prevTop = scrollContainer.scrollTop;
      scrollContainer.scrollTop += scrollStep;
      const newTop = scrollContainer.scrollTop;
      log(`iter ${i}: scrollTop ${prevTop} → ${newTop} (step=${scrollStep}), collected=${before}`);
      // If scrollTop didn't change after first scroll, the container hit its limit
      if (newTop === prevTop && i === 0) {
        log(`scrollTop stuck at ${newTop}, switching to scrollIntoView fallback`);
        useScrollIntoView = true;
      }
    }
    
    if (!scrollContainer || useScrollIntoView) {
      if (lastEl) {
        // Try scrollIntoView first
        lastEl.scrollIntoView({ behavior: 'instant', block: 'end' });
        
        // Also dispatch a wheel event - some virtual lists respond to wheel but not scroll
        const wheelTarget = lastEl.closest('[class*="table"], [class*="list"], [class*="grid"]') || lastEl.parentElement;
        if (wheelTarget) {
          wheelTarget.dispatchEvent(new WheelEvent('wheel', {
            deltaY: 500,
            deltaMode: 0, // pixels
            bubbles: true,
            cancelable: true
          }));
        }
        
        log(`iter ${i}: scrollIntoView + wheel on "${(lastEl.innerText||'').trim().slice(0,30)}", collected=${before}`);
      } else {
        window.scrollBy(0, window.innerHeight || 800);
        log(`iter ${i}: window.scrollBy, collected=${before}`);
      }
    }

    await wait(waitMs);
    getItems().forEach((item, text) => {
      if (!collected.has(text)) collected.set(text, item);
    });

    if (collected.size === before) {
      stableRounds++;
      log(`iter ${i}: no new items (stable=${stableRounds})`);
      if (stableRounds >= 3) break; // three consecutive iterations with no new items → done
    } else {
      log(`iter ${i}: +${collected.size - before} new items, total=${collected.size}`);
      stableRounds = 0; // new items appeared — reset
    }
  }

  log(`scrollAndExtract done — total=${collected.size}`);
  const items = Array.from(collected.values());
  return debug ? { items, debugLog } : items;
}

// Runs inside the page — finds <small> label elements and pairs them with the
// preceding sibling element's text (the numeric value). Returns { [label]: value }.
async function scrapeStatsByLabel(waitMs) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait for stats to render (React populates them asynchronously).
  let hasSmall = document.querySelector('small') !== null;
  if (!hasSmall) {
    for (let i = 0; i < 20 && !hasSmall; i++) {
      await wait(waitMs / 20);
      hasSmall = document.querySelector('small') !== null;
    }
  }
  // Extra settle time for numbers to hydrate.
  await wait(500);

  const stats = {};
  document.querySelectorAll('small').forEach((small) => {
    const label = (small.innerText || small.textContent || '').trim();
    if (!label) return;
    const valueEl = small.previousElementSibling;
    if (valueEl) {
      const value = (valueEl.innerText || valueEl.textContent || '').trim();
      if (value) stats[label] = value;
    }
  });

  // Also look for cloud storage folder links anywhere on the page.
  // We capture the first link matching a known cloud provider and store it
  // under the special key '_cloud_folder_url'.
  const cloudPatterns = [
    'onedrive.live.com',
    'sharepoint.com',
    'drive.google.com',
    'dropbox.com',
    '1drv.ms',
  ];
  const allAnchors = Array.from(document.querySelectorAll('a[href]'));
  const cloudAnchor = allAnchors.find((a) => {
    const href = a.getAttribute('href') || '';
    return cloudPatterns.some((p) => href.includes(p));
  });
  if (cloudAnchor) {
    stats['_cloud_folder_url'] = cloudAnchor.getAttribute('href') || '';
  }

  return stats;
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
async function cmdReadFormFields(tabId, payload) {
  const { selectors = [], waitMs = 3000 } = payload;
  if (!Array.isArray(selectors) || selectors.length === 0) throw new Error('selectors array is required');
  const targetTabId = await getTargetTabId(tabId);

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: readFormFields,
      args: [selectors, waitMs],
    });
  } catch (scriptErr) {
    console.error('[JarvisBridge] executeScript(readFormFields) threw:', scriptErr?.message ?? String(scriptErr));
    // Re-throw with a clearer message so the caller knows the exact Chrome error.
    throw new Error(`executeScript failed: ${scriptErr?.message ?? String(scriptErr)}`);
  }

  const result = results[0]?.result;
  console.log('[JarvisBridge] readFormFields result:', JSON.stringify(result));
  return result ?? null;
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
 * Read the .value of form fields (input, textarea, select) matching given CSS selectors.
 * Polls up to waitMs for elements to appear (handles React async rendering / drawer animations).
 * Scrolls each element into view before reading it (some fields are below the fold).
 * Returns an object keyed by selector with the element's current value, or null if not found.
 */
async function readFormFields(selectors, waitMs) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const result = {};

  // Scroll to the bottom of the page first — some React forms only render
  // off-screen fields after the page has been scrolled to reveal them.
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  await wait(600);

  // Poll until at least one element appears (any of the provided selectors).
  const combinedSelector = selectors.join(', ');
  let ready = document.querySelector(combinedSelector) !== null;
  if (!ready) {
    const pollInterval = Math.max(100, waitMs / 20);
    const maxAttempts = Math.ceil(waitMs / pollInterval);
    for (let i = 0; i < maxAttempts && !ready; i++) {
      await wait(pollInterval);
      ready = document.querySelector(combinedSelector) !== null;
    }
  }

  // Extra settle time for CSS animations (e.g. drawer-appear-done classes).
  await wait(500);

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      // Scroll the specific element into view so React virtualized lists render it.
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await wait(400);
      result[selector] = el.value ?? el.textContent?.trim() ?? null;
    } else {
      result[selector] = null;
    }
  }

  return result;
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
  if (msg.type === 'reconnect') {
    // Popup saved a new token — close existing socket and reconnect immediately
    if (ws) {
      ws.close(1000, 'Manual reconnect');
      ws = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectDelay = RECONNECT_DELAY_MS; // reset backoff
    isConnected = false;
    isAuthenticated = false;
    void connect();
    sendResponse({ ok: true });
    return true;
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[JarvisBridge] Extension installed/updated');
  void connect();
});

chrome.runtime.onStartup.addListener(() => {
  void connect();
});

// Connect immediately when service worker starts
void connect();

// Re-connect if the service worker wakes up and isn't connected
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive' && !isConnected) {
    void connect();
  }
});
