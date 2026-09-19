import { useState, useEffect, useCallback } from 'preact/hooks';
import type { UpdateState } from '../../types/ipc-payloads';

/**
 * Persistent update affordance in the top bar.
 *
 * The native notification that announces a downloaded update is easy to miss,
 * and dismissing it used to leave the update sitting unused until a later
 * check re-fired the event. This button mirrors the main-process update state,
 * so a ready update stays one click away for as long as it is pending.
 */
export function UpdateButton() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' });
  const [justChecked, setJustChecked] = useState(false);

  useEffect(() => {
    void window.jarvis.getUpdateState().then(setState).catch(() => { /* dev run without updates */ });
    return window.jarvis.onUpdateState(setState);
  }, []);

  // Clear the transient "up to date" confirmation a few seconds after a check.
  useEffect(() => {
    if (!justChecked) return;
    const id = window.setTimeout(() => setJustChecked(false), 4000);
    return () => window.clearTimeout(id);
  }, [justChecked]);

  const onCheck = useCallback(async () => {
    setJustChecked(false);
    await window.jarvis.checkForUpdatesNow();
    setJustChecked(true);
  }, []);

  const onInstall = useCallback(() => {
    void window.jarvis.installUpdate();
  }, []);

  if (state.status === 'downloaded') {
    return (
      <button
        class="update-btn update-btn--ready"
        title={`Restart Jarvis to install ${state.version}`}
        onClick={onInstall}
      >
        <span class="update-btn-dot" />
        Update to {state.version}
      </button>
    );
  }

  if (state.status === 'downloading') {
    return (
      <span class="update-btn update-btn--progress" title={`Downloading Jarvis ${state.version}`}>
        Downloading {state.version}… {state.percent}%
      </span>
    );
  }

  if (state.status === 'checking') {
    return <span class="update-btn update-btn--progress">Checking for updates…</span>;
  }

  if (state.status === 'error') {
    return (
      <button class="update-btn update-btn--error" title={state.error} onClick={onCheck}>
        Update check failed — retry
      </button>
    );
  }

  if (justChecked) {
    return <span class="update-btn update-btn--progress">Up to date</span>;
  }

  return null;
}
