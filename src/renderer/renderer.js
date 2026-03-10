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

  // Listen for discovery progress updates
  window.jarvis.onDiscoveryProgress((progress) => {
    updateDiscoveryUI(progress);
  });
  window.jarvis.onDiscoveryComplete((progress) => {
    updateDiscoveryUI(progress, true);
  });

  const discoveryToggleEl = document.getElementById('discovery-toggle');
  if (discoveryToggleEl) {
    discoveryToggleEl.addEventListener('click', toggleOrgPanel);
  }

  try {
    const status = await window.jarvis.getGitHubOAuthStatus();
    console.log('[Jarvis] OAuth status:', JSON.stringify(status));
    if (status.authenticated) {
      showGitHubSuccess(status.login, status.login, status.avatarUrl || '');
      // Check if discovery is already running or has stored results
      const disco = await window.jarvis.getDiscoveryStatus();
      if (disco.running) {
        showDiscoverySection();
        if (disco.progress) updateDiscoveryUI(disco.progress);
      } else if (disco.progress && disco.progress.phase === 'done') {
        showDiscoverySection();
        updateDiscoveryUI(disco.progress, true);
      } else {
        // No discovery data at all — hide the section
        showDiscoverySection();
      }
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

function showDiscoverySection() {
  document.getElementById('discovery-section').classList.remove('hidden');
}

function updateDiscoveryUI(progress, finished) {
  showDiscoverySection();
  const badge = document.getElementById('discovery-badge');
  const details = document.getElementById('discovery-details');
  const rateLimit = document.getElementById('discovery-rate-limit');

  if (finished || progress.phase === 'done') {
    badge.textContent = 'Complete';
    badge.className = 'status-badge status-completed';
    const fmtOrgs = progress.orgsFound.toLocaleString();
    const fmtRepos = progress.reposFound.toLocaleString();
    details.textContent = `Found ${fmtOrgs} org${progress.orgsFound !== 1 ? 's' : ''} and ${fmtRepos} repo${progress.reposFound !== 1 ? 's' : ''}`;
    rateLimit.textContent = '';
    // Silently refresh org list if the panel is already open
    const orgPanel = document.getElementById('org-panel');
    if (orgPanel && !orgPanel.classList.contains('hidden')) refreshOrgList();
    return;
  }

  const phaseLabels = {
    'orgs': 'Discovering organizations...',
    'repos': `Scanning org repositories... (${progress.reposFound.toLocaleString()} repos so far)`,
    'user-repos': `Scanning personal repositories... (${progress.reposFound.toLocaleString()} repos so far)`,
    'collaborator-repos': `Scanning collaborator repositories... (${progress.reposFound.toLocaleString()} repos so far)`,
  };
  badge.textContent = 'Running';
  badge.className = 'status-badge status-in-progress';
  details.textContent = phaseLabels[progress.phase] || 'Working...';
  if (progress.orgsFound > 0) {
    details.textContent += ` — ${progress.orgsFound.toLocaleString()} org${progress.orgsFound !== 1 ? 's' : ''} found`;
  }
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

function toggleOrgPanel() {
  const panel = document.getElementById('org-panel');
  const chevron = document.getElementById('discovery-chevron');
  if (!panel) return;
  const isOpen = !panel.classList.contains('hidden');
  if (isOpen) {
    panel.classList.add('hidden');
    if (chevron) chevron.textContent = '›';
  } else {
    panel.classList.remove('hidden');
    if (chevron) chevron.textContent = '‹';
    refreshOrgList();
  }
}

async function refreshOrgList() {
  const orgListEl = document.getElementById('org-list');
  if (!orgListEl) return;

  let result;
  try {
    result = await window.jarvis.listOrgs();
  } catch (err) {
    console.error('[Jarvis] Failed to load org list:', err);
    return;
  }

  const orgs = result.orgs || [];
  const directRepoCount = result.directRepoCount || 0;

  if (orgs.length === 0 && directRepoCount === 0) return;

  orgListEl.innerHTML = '';

  for (const org of orgs) {
    const item = document.createElement('div');
    item.className = 'org-item';

    const label = document.createElement('span');
    label.className = 'org-label';
    label.textContent = org.login;

    const meta = document.createElement('span');
    meta.className = 'org-meta';
    meta.textContent = `${org.repoCount.toLocaleString()} repo${org.repoCount !== 1 ? 's' : ''}`;

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = org.discoveryEnabled;
    checkbox.addEventListener('change', async () => {
      await window.jarvis.setOrgEnabled(org.login, checkbox.checked);
    });

    const slider = document.createElement('span');
    slider.className = 'slider';

    toggleLabel.appendChild(checkbox);
    toggleLabel.appendChild(slider);

    item.appendChild(label);
    item.appendChild(meta);
    item.appendChild(toggleLabel);
    orgListEl.appendChild(item);
  }

  // Show direct-access repos (personal + collaborator) if any
  if (directRepoCount > 0) {
    const item = document.createElement('div');
    item.className = 'org-item';

    const label = document.createElement('span');
    label.className = 'org-label';
    label.textContent = 'Personal & collaborator';
    label.style.fontStyle = 'italic';

    const meta = document.createElement('span');
    meta.className = 'org-meta';
    meta.textContent = `${directRepoCount.toLocaleString()} repo${directRepoCount !== 1 ? 's' : ''}`;

    item.appendChild(label);
    item.appendChild(meta);
    orgListEl.appendChild(item);
  }
}

// ── Repo search ──────────────────────────────────────────────────────────────

(function initSearch() {
  const input = document.getElementById('search-input');
  const resultsEl = document.getElementById('search-results');
  if (!input || !resultsEl) return;

  let debounceTimer = null;

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { hideResults(); return; }
    debounceTimer = setTimeout(() => doSearch(q), 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideResults(); input.blur(); }
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('search-wrap').contains(e.target)) hideResults();
  });

  async function doSearch(query) {
    let results;
    try { results = await window.jarvis.searchRepos(query); }
    catch (err) { console.error('[Search]', err); return; }

    resultsEl.innerHTML = '';

    if (!results || results.length === 0) {
      resultsEl.innerHTML = '<div id="search-empty">No repositories found</div>';
      resultsEl.classList.remove('hidden');
      return;
    }

    for (const repo of results) {
      const slashIdx = repo.full_name.indexOf('/');
      const orgPart = slashIdx !== -1 ? repo.full_name.slice(0, slashIdx) : '';

      const item = document.createElement('div');
      item.className = 'search-result-item';

      const main = document.createElement('div');
      main.className = 'sri-main';

      const name = document.createElement('div');
      name.className = 'sri-name';
      name.textContent = repo.name;

      const org = document.createElement('div');
      org.className = 'sri-org';
      org.textContent = orgPart || 'personal';

      main.appendChild(name);
      main.appendChild(org);

      const side = document.createElement('div');
      side.className = 'sri-side';

      if (repo.language) {
        const lang = document.createElement('span');
        lang.className = 'sri-lang';
        lang.textContent = repo.language;
        side.appendChild(lang);
      }
      if (repo.fork) {
        const b = document.createElement('span');
        b.className = 'sri-badge';
        b.textContent = 'fork';
        side.appendChild(b);
      }
      if (repo.archived) {
        const b = document.createElement('span');
        b.className = 'sri-badge';
        b.textContent = 'archived';
        side.appendChild(b);
      }
      if (repo.private) {
        const b = document.createElement('span');
        b.className = 'sri-badge';
        b.textContent = 'private';
        side.appendChild(b);
      }

      item.appendChild(main);
      item.appendChild(side);
      resultsEl.appendChild(item);
    }

    resultsEl.classList.remove('hidden');
  }

  function hideResults() {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
  }
})();

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
