// ── GitHub hosts: github.com and GHE.com (data residency) ────────────────────
//
// A "host" is the web hostname of a GitHub instance. Jarvis supports github.com
// and GitHub Enterprise Cloud with data residency (`<subdomain>.ghe.com`); both
// speak the same REST API, only the base URLs differ:
//
//   github.com            → https://api.github.com
//   <subdomain>.ghe.com   → https://api.<subdomain>.ghe.com
//
// Hosts are validated against this allow-list before any token is sent, so a
// crafted remote URL or config value can never make Jarvis send a token to an
// arbitrary server.
//
// Discovery and notification code builds API URLs deep inside many helpers.
// Rather than thread a base URL through every signature, the host is carried by
// an AsyncLocalStorage context: `runWithHost(host, fn)` and `currentApiBase()`.

import { AsyncLocalStorage } from 'async_hooks';

export const DEFAULT_HOST = 'github.com';

const GHE_COM_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ghe\.com$/;

/** Normalise a host name (lowercase, no scheme/port/path); null when empty. */
export function normalizeHost(host: string | null | undefined): string | null {
  const h = (host ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  return h || null;
}

/** True for github.com and `<subdomain>.ghe.com`. */
export function isSupportedHost(host: string | null | undefined): boolean {
  const h = normalizeHost(host);
  return h === DEFAULT_HOST || (h !== null && GHE_COM_RE.test(h));
}

/** REST API base URL for a supported host. Throws for an unsupported one. */
export function apiBaseForHost(host: string): string {
  const h = normalizeHost(host);
  if (h === DEFAULT_HOST) return 'https://api.github.com';
  if (h !== null && GHE_COM_RE.test(h)) return `https://api.${h}`;
  throw new Error(`Unsupported GitHub host: ${host}`);
}

/** Web base URL (for links) for a supported host. */
export function webBaseForHost(host: string): string {
  const h = normalizeHost(host);
  if (h === DEFAULT_HOST || (h !== null && GHE_COM_RE.test(h))) return `https://${h}`;
  throw new Error(`Unsupported GitHub host: ${host}`);
}

/** Host an API URL (or web URL) belongs to; null when it is not a supported host. */
export function hostOfUrl(url: string): string | null {
  const m = url.match(/^https:\/\/([^/]+)/i);
  if (!m) return null;
  const h = m[1].toLowerCase();
  if (h === 'api.github.com') return DEFAULT_HOST;
  if (h === DEFAULT_HOST) return DEFAULT_HOST;
  const api = h.match(/^api\.(.+\.ghe\.com)$/);
  const candidate = api ? api[1] : h;
  return GHE_COM_RE.test(candidate) ? candidate : null;
}

/** True when `url` is an API URL of any supported host. */
export function isGitHubApiUrl(url: string): boolean {
  return /^https:\/\/api\.github\.com\//.test(url) || /^https:\/\/api\.[a-z0-9-]+\.ghe\.com\//i.test(url);
}

// ── Account ids ──────────────────────────────────────────────────────────────
// One string identifies an account everywhere (config keys, assignments, UI):
// the bare login on github.com (so all existing data stays valid) and
// `login@host` anywhere else.

export interface AccountRef {
  host: string;
  login: string;
}

export function accountId(host: string, login: string): string {
  const h = normalizeHost(host) ?? DEFAULT_HOST;
  return h === DEFAULT_HOST ? login : `${login}@${h}`;
}

export function parseAccountId(id: string): AccountRef {
  const at = id.lastIndexOf('@');
  if (at <= 0) return { host: DEFAULT_HOST, login: id };
  return { host: normalizeHost(id.slice(at + 1)) ?? DEFAULT_HOST, login: id.slice(0, at) };
}

/** Lowercase key for an owner or `owner/repo` on a host: bare on github.com, `host/…` elsewhere. */
export function hostKey(host: string, ownerOrRepo: string): string {
  const h = normalizeHost(host) ?? DEFAULT_HOST;
  const k = ownerOrRepo.trim().toLowerCase();
  return h === DEFAULT_HOST ? k : `${h}/${k}`;
}

/** Split a {@link hostKey} back into host and owner-or-repo. */
export function parseHostKey(key: string): { host: string; rest: string } {
  const first = key.split('/')[0];
  if (first.includes('.') && GHE_COM_RE.test(first)) return { host: first, rest: key.slice(first.length + 1) };
  return { host: DEFAULT_HOST, rest: key };
}

// ── Host context ─────────────────────────────────────────────────────────────

export interface HostContext {
  host: string;
  apiBase: string;
  /** Account the work runs as (an {@link accountId}); recorded as the viewer of discovered repos. */
  account?: string;
}

const storage = new AsyncLocalStorage<HostContext>();

/** Run `fn` (and everything it awaits) against `host`'s API. */
export function runWithHost<T>(host: string, fn: () => T, account?: string): T {
  const h = normalizeHost(host) ?? DEFAULT_HOST;
  return storage.run({ host: h, apiBase: apiBaseForHost(h), account }, fn);
}

export function currentHostContext(): HostContext {
  return storage.getStore() ?? { host: DEFAULT_HOST, apiBase: apiBaseForHost(DEFAULT_HOST) };
}

export function currentApiBase(): string {
  return currentHostContext().apiBase;
}

export function currentHost(): string {
  return currentHostContext().host;
}
