console.log('[Jarvis] renderer.js loaded');

// Check initial status on load
window.addEventListener('DOMContentLoaded', async () => {
  console.log('[Jarvis] DOMContentLoaded — checking OAuth status');

  // Bind the sign-in button
  const btn = document.getElementById('github-login-btn');
  if (btn) {
    console.log('[Jarvis] Sign-in button found, attaching click handler');
    btn.addEventListener('click', () => startGitHubLogin());
  } else {
    console.error('[Jarvis] Sign-in button NOT found!');
  }

  // Listen for the one-shot push from the main process
  window.jarvis.onOAuthComplete((result) => {
    console.log('[Jarvis] oauth-complete event received:', JSON.stringify(result));
    if (result.error) {
      alert('OAuth error: ' + result.error);
      resetGitHubUI();
      return;
    }
    showGitHubSuccess(result.login, result.name || result.login, result.avatarUrl);
  });

  try {
    const status = await window.jarvis.getGitHubOAuthStatus();
    console.log('[Jarvis] OAuth status:', JSON.stringify(status));
    if (status.authenticated) {
      showGitHubSuccess(status.login, status.login, '');
    }
  } catch (err) {
    console.error('[Jarvis] Error checking OAuth status:', err);
  }
});

async function startGitHubLogin() {
  console.log('[Jarvis] startGitHubLogin called');
  const btn = document.getElementById('github-login-btn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  const result = await window.jarvis.startGitHubOAuth();
  console.log('[Jarvis] OAuth start result:', JSON.stringify(result));

  if (result.error) {
    btn.disabled = false;
    btn.textContent = 'Sign in with GitHub';
    alert('Error: ' + result.error);
    return;
  }

  // Show the device code
  document.getElementById('github-connect').classList.add('hidden');
  document.getElementById('github-device-code').classList.remove('hidden');
  document.getElementById('device-user-code').textContent = result.userCode;

  const link = document.getElementById('verification-link');
  link.href = result.verificationUri;
  link.textContent = result.verificationUri.replace('https://', '');

  // Update badge
  const badge = document.getElementById('github-status-badge');
  badge.textContent = 'Waiting...';
  badge.className = 'status-badge status-in-progress';

  // Main process now owns the polling — no setInterval here
  console.log('[Jarvis] Waiting for main process to push oauth-complete...');
}

function showGitHubSuccess(login, name, avatarUrl) {
  document.getElementById('github-connect').classList.add('hidden');
  document.getElementById('github-device-code').classList.add('hidden');
  document.getElementById('github-success').classList.remove('hidden');

  document.getElementById('user-login').textContent = '@' + login;
  document.getElementById('user-name').textContent = name;
  if (avatarUrl) {
    document.getElementById('user-avatar').src = avatarUrl;
  }

  const badge = document.getElementById('github-status-badge');
  badge.textContent = 'Connected';
  badge.className = 'status-badge status-completed';
}

function resetGitHubUI() {
  document.getElementById('github-connect').classList.remove('hidden');
  document.getElementById('github-device-code').classList.add('hidden');
  document.getElementById('github-success').classList.add('hidden');

  const btn = document.getElementById('github-login-btn');
  btn.disabled = false;
  btn.textContent = 'Sign in with GitHub';

  const badge = document.getElementById('github-status-badge');
  badge.textContent = 'Pending';
  badge.className = 'status-badge status-pending';
}
