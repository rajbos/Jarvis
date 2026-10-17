// ── Clipboard helper for renderer views ───────────────────────────────────────
// navigator.clipboard.writeText is rejected in Jarvis: it needs Chromium's
// clipboard-sanitized-write permission and the main process denies every
// permission request. Copy through the main process's clipboard module instead.

/** Copies text to the system clipboard. Resolves false (never throws) when it fails. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const result = await window.jarvis.clipboardWriteText(text);
    return result?.ok === true;
  } catch {
    return false;
  }
}
