// ── Secret hygiene calculations (pure, no DB or network) ─────────────────────
// Only secret names and timestamps are ever handled here, never values.

/** A secret counts as stale when it was not updated within this many months. */
export const STALE_SECRET_MONTHS = 12;
/** A secret name present in at least this many repos is an org-secret candidate. */
export const SHARED_SECRET_MIN_REPOS = 3;

export interface HygieneSecret {
  full_name: string;
  secret_name: string;
  /** GitHub's created_at; null for rows scanned before age tracking. */
  created_at?: string | null;
  /** GitHub's updated_at; null for rows scanned before age tracking. */
  updated_at?: string | null;
  archived?: number | boolean | null;
}

export interface StaleSecret {
  full_name: string;
  secret_name: string;
  updated_at: string;
  ageDays: number;
}

export interface SharedSecretName {
  secret_name: string;
  repos: string[];
}

const DAY_MS = 86_400_000;

/** Days since the secret was last rotated (updated, falling back to created); null = age unknown. */
export function secretAgeDays(s: Pick<HygieneSecret, 'created_at' | 'updated_at'>, now: Date): number | null {
  const raw = s.updated_at ?? s.created_at;
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** Human label for an age; null renders as "age unknown". */
export function formatSecretAge(ageDays: number | null): string {
  if (ageDays === null) return 'age unknown';
  if (ageDays < 60) return `${ageDays} day${ageDays === 1 ? '' : 's'}`;
  if (ageDays < 730) return `${Math.floor(ageDays / 30)} months`;
  return `${Math.floor(ageDays / 365)} years`;
}

/** Secrets not rotated within `thresholdMonths`, oldest first. Unknown-age secrets are skipped. */
export function findStaleSecrets(
  secrets: HygieneSecret[],
  now: Date,
  thresholdMonths: number = STALE_SECRET_MONTHS,
): StaleSecret[] {
  const cutoffDays = Math.round(thresholdMonths * 30.4375);
  const out: StaleSecret[] = [];
  for (const s of secrets) {
    const ageDays = secretAgeDays(s, now);
    if (ageDays === null || ageDays < cutoffDays) continue;
    out.push({ full_name: s.full_name, secret_name: s.secret_name, updated_at: (s.updated_at ?? s.created_at) as string, ageDays });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays || a.full_name.localeCompare(b.full_name));
}

/** Secret names present in at least `minRepos` distinct repos (case-insensitive), most widespread first. */
export function findSharedSecretNames(
  secrets: HygieneSecret[],
  minRepos: number = SHARED_SECRET_MIN_REPOS,
): SharedSecretName[] {
  const byName = new Map<string, { display: string; repos: Set<string> }>();
  for (const s of secrets) {
    const key = s.secret_name.toUpperCase();
    const entry = byName.get(key) ?? { display: s.secret_name, repos: new Set<string>() };
    entry.repos.add(s.full_name);
    byName.set(key, entry);
  }
  return [...byName.values()]
    .filter((e) => e.repos.size >= minRepos)
    .map((e) => ({ secret_name: e.display, repos: [...e.repos].sort() }))
    .sort((a, b) => b.repos.length - a.repos.length || a.secret_name.localeCompare(b.secret_name));
}

/** Secrets that live on archived repos. */
export function findSecretsOnArchivedRepos(secrets: HygieneSecret[]): HygieneSecret[] {
  return secrets.filter((s) => s.archived === true || s.archived === 1);
}
