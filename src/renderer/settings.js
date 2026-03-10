console.log('[Jarvis] settings.js loaded');

window.addEventListener('DOMContentLoaded', async () => {
  await refreshPatUI();

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
});

async function refreshPatUI() {
  try {
    const { hasPat } = await window.jarvis.getPatStatus();
    const inputWrap = document.getElementById('pat-input-wrap');
    const savedEl = document.getElementById('pat-saved');
    if (hasPat) {
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
