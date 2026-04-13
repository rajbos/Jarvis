// ── Windows Internet Shortcut reader ─────────────────────────────────────────
// Parses `.url` files (INI-format) to extract the target URL.
// These shortcuts are created by OneNote/OneDrive to link to notebooks that
// are hosted on SharePoint or OneDrive cloud but not locally synced as .one files.

import fs from 'fs';

export interface UrlShortcutInfo {
  /** Raw URL extracted from the shortcut. */
  url: string;
  /** True when the URL appears to be a OneNote notebook link. */
  isOneNote: boolean;
  /** True when the URL points to SharePoint (may need Graph API for content). */
  isSharePoint: boolean;
}

/**
 * Read a Windows `.url` Internet Shortcut file and return the target URL.
 * @throws if the file cannot be read or contains no URL.
 */
export function readUrlShortcut(filePath: string): UrlShortcutInfo {
  const content = fs.readFileSync(filePath, 'utf-8');

  // URL is on a line of the form: URL=https://...
  const match = content.match(/^URL=(.+)$/im);
  if (!match) {
    throw new Error(`No URL= entry found in shortcut file: ${filePath}`);
  }

  const url = match[1].trim();
  const lower = url.toLowerCase();

  const isOneNote =
    lower.startsWith('onenote:') ||
    lower.includes('skysyncredir') || // SharePoint OneNote sync redirect
    lower.includes('onenote') ||
    lower.includes('callerscenarioid=onenote');

  const isSharePoint = lower.includes('sharepoint.com');

  return { url, isOneNote, isSharePoint };
}
