// ── Settings: GitHub device-flow code, ready to paste ────────────────────────
import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

/**
 * Shows the GitHub device code prominently. The main process copies the code to
 * the clipboard when it starts the flow, so usually all that's left is to paste.
 */
export function DeviceCodePrompt({
  userCode, verificationUri, copied: copiedByMain, children,
}: { userCode: string; verificationUri?: string; copied?: boolean; children?: ComponentChildren }) {
  const [copied, setCopied] = useState(copiedByMain === true);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(userCode);
      setCopied(true);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div class="device-code">
      <div class="device-code-row">
        <code class="device-code-value">{userCode}</code>
        <button class="btn-secondary" onClick={() => void copy()}>{copied ? '✓ Copied' : 'Copy code'}</button>
        {verificationUri && (
          <button class="btn-secondary" onClick={() => void window.jarvis.shellOpenUrl(verificationUri)}>
            Open GitHub
          </button>
        )}
      </div>
      <p class="hint" style={{ marginTop: '0.4rem' }}>
        {copied
          ? <>The code is on your clipboard — <strong>paste it</strong> on the GitHub page that just opened and click <strong>Authorize</strong>.</>
          : <>Enter this code on the GitHub page that just opened and click <strong>Authorize</strong>.</>}
        {children && <> {children}</>}
      </p>
    </div>
  );
}
