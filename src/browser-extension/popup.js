/**
 * Jarvis Browser Companion — Popup Script
 * Updates the popup UI based on connection status from the background worker.
 */

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const helpEl = document.getElementById('help-text');

function setConnected(connected) {
  if (connected) {
    statusEl.className = 'status-badge connected';
    statusTextEl.textContent = 'Connected to Jarvis';
    if (helpEl) helpEl.style.display = 'none';
  } else {
    statusEl.className = 'status-badge disconnected';
    statusTextEl.textContent = 'Not connected — is Jarvis running?';
    if (helpEl) helpEl.style.display = 'block';
  }
}

// Listen for status messages from the background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    setConnected(msg.connected);
  }
});

// Ask the background worker for current status
chrome.runtime.sendMessage({ type: 'get-status' }).then((response) => {
  if (response && typeof response.connected === 'boolean') {
    setConnected(response.connected);
  }
}).catch(() => {
  setConnected(false);
});
