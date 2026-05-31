/**
 * Jarvis Browser Companion — Popup Script
 * Updates the popup UI based on connection/auth status from the background worker.
 */

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const tokenInput = document.getElementById('token-input');
const btnSave = document.getElementById('btn-save');
const savedMsg = document.getElementById('saved-msg');

function setStatus(connected, invalidToken, needsToken) {
  if (connected) {
    statusEl.className = 'status-badge connected';
    statusTextEl.textContent = 'Connected to Jarvis';
  } else if (invalidToken) {
    statusEl.className = 'status-badge invalid-token';
    statusTextEl.textContent = 'Invalid token — update below';
  } else if (needsToken) {
    statusEl.className = 'status-badge disconnected';
    statusTextEl.textContent = 'Token required — paste below';
  } else {
    statusEl.className = 'status-badge disconnected';
    statusTextEl.textContent = 'Not connected — is Jarvis running?';
  }
}

// Load stored token into the input field
chrome.storage.local.get('jarvisToken').then((result) => {
  if (typeof result.jarvisToken === 'string' && result.jarvisToken) {
    tokenInput.value = result.jarvisToken;
  }
});

// Save token and trigger reconnect
btnSave.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return;
  await chrome.storage.local.set({ jarvisToken: token });
  savedMsg.style.display = 'block';
  setTimeout(() => { savedMsg.style.display = 'none'; }, 3000);
  // Tell the background service worker to reconnect with the new token
  chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => { /* SW may be sleeping */ });
});

// Listen for status messages from the background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    setStatus(msg.connected, msg.invalidToken, msg.needsToken);
  }
});

// Ask the background worker for current status
chrome.runtime.sendMessage({ type: 'get-status' }).then((response) => {
  if (response && typeof response.connected === 'boolean') {
    setStatus(response.connected, false, false);
  }
}).catch(() => {
  setStatus(false, false, false);
});
