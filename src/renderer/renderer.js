console.log('[Jarvis] renderer.js loaded');

let currentUserLogin = null;
let lastRepoPanelState = null; // { orgLogin, displayName, repos }

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
    // Reset PAT discovery button
    const btn = document.getElementById('btn-run-pat-discovery');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Run PAT Discovery';
    }
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
    'user-repos': `Scanning personal + collaborator repos... (${progress.reposFound.toLocaleString()} repos so far)`,
    'pat-repos': progress.currentOrg
      ? `PAT: scanning ${progress.currentOrg}... (${progress.reposFound.toLocaleString()} new repos)`
      : `PAT: scanning collaborator repos... (${progress.reposFound.toLocaleString()} new repos)`,
  };
  badge.textContent = 'Running';
  badge.className = 'status-badge status-in-progress';
  details.textContent = phaseLabels[progress.phase] || 'Working...';
  if (progress.orgsFound > 0) {
    details.textContent += ` — ${progress.orgsFound.toLocaleString()} org${progress.orgsFound !== 1 ? 's' : ''} found`;
  }
}

function showGitHubSuccess(login, name, avatarUrl) {
  currentUserLogin = login;
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

  // Show the PAT discovery button if a PAT is configured
  refreshPatDiscoveryButton();
}

async function refreshPatDiscoveryButton() {
  const btn = document.getElementById('btn-run-pat-discovery');
  if (!btn) return;
  try {
    const { hasPat } = await window.jarvis.getPatStatus();
    if (hasPat) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  } catch {
    btn.classList.add('hidden');
  }
}

document.getElementById('btn-run-pat-discovery')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-run-pat-discovery');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Running…';
  }
  try {
    await window.jarvis.startPatDiscovery();
  } catch (err) {
    console.error('PAT discovery failed:', err);
  }
  // Button state will be reset when discovery-complete fires
});

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
    checkbox.addEventListener('change', async (e) => {
      e.stopPropagation();
      await window.jarvis.setOrgEnabled(org.login, checkbox.checked);
    });
    // Prevent click from bubbling to org-item
    toggleLabel.addEventListener('click', (e) => e.stopPropagation());

    const slider = document.createElement('span');
    slider.className = 'slider';

    toggleLabel.appendChild(checkbox);
    toggleLabel.appendChild(slider);

    item.appendChild(label);
    item.appendChild(meta);
    item.appendChild(toggleLabel);
    orgListEl.appendChild(item);

    // Click to show repos for this org
    item.addEventListener('click', () => showRepoPanel(org.login, org.login));
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

    // Click to show direct-access repos
    item.addEventListener('click', () => showRepoPanel(null, 'Personal & collaborator'));
  }
}

// ── Repo detail panel ────────────────────────────────────────────────────────

async function showRepoPanel(orgLogin, displayName) {
  const panel = document.getElementById('repo-panel');
  const title = document.getElementById('repo-panel-title');
  const listEl = document.getElementById('repo-panel-list');
  const filterWrap = document.getElementById('repo-panel-filter');
  const hideMyCheckbox = document.getElementById('hide-my-repos');
  if (!panel || !listEl) return;

  // Show/hide filter only for direct repos
  if (orgLogin === null && filterWrap) {
    filterWrap.classList.remove('hidden');
  } else if (filterWrap) {
    filterWrap.classList.add('hidden');
  }

  // Highlight selected org item
  document.querySelectorAll('.org-item').forEach((el) => el.classList.remove('active'));
  const orgItems = document.querySelectorAll('.org-item');
  for (const oi of orgItems) {
    const label = oi.querySelector('.org-label');
    if (label && label.textContent === displayName) {
      oi.classList.add('active');
      break;
    }
  }

  title.textContent = displayName;
  listEl.innerHTML = '<div style="color:#99a;font-size:0.85rem;padding:0.5rem;">Loading…</div>';
  panel.classList.remove('hidden');

  let repos;
  try {
    repos = await window.jarvis.listReposForOrg(orgLogin);
  } catch (err) {
    console.error('[Jarvis] Failed to load repos:', err);
    listEl.innerHTML = '<div style="color:#e94560;font-size:0.85rem;padding:0.5rem;">Failed to load repositories</div>';
    return;
  }

  lastRepoPanelState = { orgLogin, displayName, repos };
  renderRepoCards();
}

function renderRepoCards() {
  if (!lastRepoPanelState) return;
  const { orgLogin, repos } = lastRepoPanelState;
  const listEl = document.getElementById('repo-panel-list');
  const hideMyCheckbox = document.getElementById('hide-my-repos');
  if (!listEl) return;

  listEl.innerHTML = '';

  if (!repos || repos.length === 0) {
    listEl.innerHTML = '<div style="color:#99a;font-size:0.85rem;padding:0.5rem;">No repositories found</div>';
    return;
  }

  // Filter out user's own repos if checkbox is checked (only for direct repos)
  const hideOwn = orgLogin === null && hideMyCheckbox && hideMyCheckbox.checked && currentUserLogin;
  const filteredRepos = hideOwn
    ? repos.filter((r) => !r.full_name.startsWith(currentUserLogin + '/'))
    : repos;

  if (filteredRepos.length === 0) {
    listEl.innerHTML = '<div style="color:#99a;font-size:0.85rem;padding:0.5rem;">No repositories (all filtered)</div>';
    return;
  }

  for (const repo of filteredRepos) {
    const card = document.createElement('div');
    card.className = 'repo-card';

    const nameEl = document.createElement('div');
    nameEl.className = 'repo-card-name';
    // Show owner prefix for direct repos (personal & collaborator)
    if (orgLogin === null && repo.full_name.includes('/')) {
      const owner = repo.full_name.split('/')[0];
      const ownerSpan = document.createElement('span');
      ownerSpan.className = 'repo-card-owner';
      ownerSpan.textContent = owner + ' / ';
      nameEl.appendChild(ownerSpan);
      nameEl.appendChild(document.createTextNode(repo.name));
    } else {
      nameEl.textContent = repo.name;
    }
    card.appendChild(nameEl);

    if (repo.description) {
      const descEl = document.createElement('div');
      descEl.className = 'repo-card-desc';
      descEl.textContent = repo.description;
      card.appendChild(descEl);
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'repo-card-meta';

    if (repo.language) {
      const langEl = document.createElement('span');
      langEl.className = 'repo-card-lang';
      langEl.textContent = repo.language;
      metaEl.appendChild(langEl);
    }

    if (repo.private) {
      const b = document.createElement('span');
      b.className = 'repo-card-badge';
      b.textContent = 'private';
      metaEl.appendChild(b);
    }

    if (repo.fork) {
      const b = document.createElement('span');
      b.className = 'repo-card-badge';
      b.textContent = 'fork';
      metaEl.appendChild(b);
      if (repo.parent_full_name) {
        const p = document.createElement('span');
        p.className = 'repo-card-date';
        p.textContent = '← ' + repo.parent_full_name;
        metaEl.appendChild(p);
      }
    }

    if (repo.archived) {
      const b = document.createElement('span');
      b.className = 'repo-card-badge';
      b.textContent = 'archived';
      metaEl.appendChild(b);
    }

    if (repo.default_branch) {
      const b = document.createElement('span');
      b.className = 'repo-card-date';
      b.textContent = repo.default_branch;
      metaEl.appendChild(b);
    }

    if (repo.last_pushed_at) {
      const d = document.createElement('span');
      d.className = 'repo-card-date';
      d.textContent = 'pushed ' + new Date(repo.last_pushed_at).toLocaleDateString();
      metaEl.appendChild(d);
    }

    card.appendChild(metaEl);
    listEl.appendChild(card);
  }
}

// Close repo panel + filter toggle
document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('repo-panel-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      document.getElementById('repo-panel').classList.add('hidden');
      document.querySelectorAll('.org-item').forEach((el) => el.classList.remove('active'));
    });
  }

  const hideMyCheckbox = document.getElementById('hide-my-repos');
  if (hideMyCheckbox) {
    hideMyCheckbox.addEventListener('change', () => renderRepoCards());
  }
});

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
