// Jarvis Browser Companion — background service worker (Manifest V3)
// Maintains a WebSocket connection to the Jarvis bridge running on the desktop.

const BRIDGE_URL = 'ws://127.0.0.1:35789';

/** @type {WebSocket|null} */
let ws = null;

function updateStatus(connected) {
  chrome.storage.local.set({ connected });
}

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch {
    updateStatus(false);
    return;
  }

  ws.addEventListener('open', () => {
    updateStatus(true);
  });

  ws.addEventListener('message', async (event) => {
    try {
      const msg = JSON.parse(event.data);
      await handleCommand(msg);
    } catch {
      // ignore malformed messages
    }
  });

  ws.addEventListener('close', () => {
    updateStatus(false);
    ws = null;
  });

  ws.addEventListener('error', () => {
    updateStatus(false);
  });
}

/**
 * Handle a command received from the Jarvis bridge.
 * @param {{ type: string, id?: string, url?: string }} msg
 */
async function handleCommand(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', id: msg.id }));
  } else if (msg.type === 'get-url') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    ws.send(JSON.stringify({ type: 'ack', id: msg.id, data: { url: tab?.url ?? null } }));
  } else if (msg.type === 'navigate') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { url: msg.url });
    }
    ws.send(JSON.stringify({ type: 'ack', id: msg.id, status: 'ok' }));
  }
}

// Use alarms to keep the service worker alive and reconnect when needed.
// Chrome may terminate a service worker after ~30 s of inactivity;
// the alarm fires every 25 s to re-establish the connection if it dropped.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => connect());

// Connect immediately on install / browser start.
connect();
