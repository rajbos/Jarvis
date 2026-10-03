// ── Web links for github.com and GHE.com (renderer-safe: no Node imports) ────

const GHE_COM_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/;

/** Web base URL for a host; anything that is not github.com or a GHE.com host falls back to github.com. */
export function webBase(host?: string | null): string {
  const h = (host ?? '').trim().toLowerCase();
  return h && GHE_COM_RE.test(h) ? `https://${h}` : 'https://github.com';
}

/** `https://github.com/owner/repo` (or the GHE.com equivalent) for a repo full name. */
export function repoWebUrl(fullName: string, host?: string | null): string {
  return `${webBase(host)}/${fullName}`;
}

/**
 * Turn a REST API URL (`…/repos/owner/repo/issues/1`) into the matching web URL,
 * keeping its host. Other URLs are returned unchanged.
 */
export function apiUrlToWebUrl(url: string): string {
  const m = url.match(/^https:\/\/api\.(github\.com|[a-z0-9-]+\.ghe\.com)\/repos\/(.*)$/i);
  return m ? `https://${m[1].toLowerCase()}/${m[2]}` : url;
}
