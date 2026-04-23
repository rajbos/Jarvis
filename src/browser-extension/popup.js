// Reads the connection status stored by the background service worker and
// updates the popup UI. Also listens for live status-change messages.

function updateStatus(connected) {
  const dot   = document.getElementById('dot');
  const label = document.getElementById('label');
  const hint  = document.getElementById('hint');

  dot.className = `dot ${connected ? 'connected' : 'disconnected'}`;
  label.textContent = connected ? 'Connected to Jarvis' : 'Disconnected';
  hint.textContent  = connected
    ? 'Jarvis can see your active tab.'
    : 'Make sure Jarvis is running.';
}

// Read persisted status on open.
chrome.storage.local.get('connected', ({ connected }) => {
  updateStatus(connected ?? false);
});

// Listen for live updates pushed by the background worker.
chrome.storage.onChanged.addListener((changes) => {
  if ('connected' in changes) {
    updateStatus(changes.connected.newValue ?? false);
  }
});
