console.log('[Jarvis] settings.js loaded');

window.addEventListener('DOMContentLoaded', async () => {
  await refreshOAuthUI();
  await refreshPatUI();

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (!confirm('Sign out of GitHub? This will remove your OAuth session.')) return;
      logoutBtn.disabled = true;
      await window.jarvis.logout();
      await refreshOAuthUI();
      logoutBtn.disabled = false;
    });
  }

  const oauthDiscoveryBtn = document.getElementById('btn-run-oauth-discovery');
  if (oauthDiscoveryBtn) {
    oauthDiscoveryBtn.addEventListener('click', async () => {
      oauthDiscoveryBtn.disabled = true;
      oauthDiscoveryBtn.textContent = 'Starting…';
      try {
        await window.jarvis.startOAuthDiscovery();
      } catch (err) {
        console.error('OAuth discovery failed:', err);
      }
      oauthDiscoveryBtn.disabled = false;
      oauthDiscoveryBtn.textContent = 'Run OAuth Discovery';
    });
  }

  const patSaveBtn = document.getElementById('pat-save-btn');
  if (patSaveBtn) {
    patSaveBtn.addEventListener('click', async () => {
      const input = document.getElementById('pat-input');
      const errorEl = document.getElementById('pat-error');
      const pat = input.value.trim();
      errorEl.textContent = '';
      if (!pat) { errorEl.textContent = 'Please enter a token'; return; }
      patSaveBtn.disabled = true;
      patSaveBtn.textContent = 'Saving...';
      const result = await window.jarvis.savePat(pat);
      patSaveBtn.disabled = false;
      patSaveBtn.textContent = 'Save';
      if (result.error) {
        errorEl.textContent = result.error;
      } else {
        input.value = '';
        errorEl.textContent = '';
        await refreshPatUI();
      }
    });
  }

  const patRemoveBtn = document.getElementById('pat-remove-btn');
  if (patRemoveBtn) {
    patRemoveBtn.addEventListener('click', async () => {
      await window.jarvis.deletePat();
      await refreshPatUI();
    });
  }

  const patDiscoveryBtn = document.getElementById('btn-run-pat-discovery');
  if (patDiscoveryBtn) {
    patDiscoveryBtn.addEventListener('click', async () => {
      patDiscoveryBtn.disabled = true;
      patDiscoveryBtn.textContent = 'Running…';
      try {
        await window.jarvis.startPatDiscovery();
      } catch (err) {
        console.error('PAT discovery failed:', err);
      }
      patDiscoveryBtn.disabled = false;
      patDiscoveryBtn.textContent = 'Run PAT Discovery';
    });
  }
});

async function refreshOAuthUI() {
  try {
    const status = await window.jarvis.getGitHubOAuthStatus();
    const signedIn = document.getElementById('oauth-signed-in');
    const signedOut = document.getElementById('oauth-signed-out');
    if (status.authenticated) {
      document.getElementById('oauth-name-label').textContent = status.login;
      document.getElementById('oauth-login-label').textContent = '@' + status.login;
      const avatar = document.getElementById('oauth-avatar');
      if (status.avatarUrl) { avatar.src = status.avatarUrl; avatar.style.display = ''; }
      else { avatar.style.display = 'none'; }
      signedIn.classList.remove('hidden');
      signedOut.classList.add('hidden');
    } else {
      signedIn.classList.add('hidden');
      signedOut.classList.remove('hidden');
    }
  } catch (err) {
    console.error('[Jarvis] Failed to check OAuth status:', err);
  }
}

async function refreshPatUI() {
  try {
    const status = await window.jarvis.getPatStatus();
    const inputWrap = document.getElementById('pat-input-wrap');
    const savedEl = document.getElementById('pat-saved');
    if (status.hasPat) {
      document.getElementById('pat-name-label').textContent = status.name || status.login || 'PAT User';
      document.getElementById('pat-login-label').textContent = status.login ? '@' + status.login : '';
      const avatar = document.getElementById('pat-avatar');
      if (status.avatarUrl) { avatar.src = status.avatarUrl; avatar.style.display = ''; }
      else { avatar.style.display = 'none'; }
      inputWrap.classList.add('hidden');
      savedEl.classList.remove('hidden');
    } else {
      inputWrap.classList.remove('hidden');
      savedEl.classList.add('hidden');
    }
  } catch (err) {
    console.error('[Jarvis] Failed to check PAT status:', err);
  }
}
