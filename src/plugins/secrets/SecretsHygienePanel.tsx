import type { RepoSecret } from '../types';
import {
  STALE_SECRET_MONTHS,
  SHARED_SECRET_MIN_REPOS,
  findStaleSecrets,
  findSharedSecretNames,
  findSecretsOnArchivedRepos,
  formatSecretAge,
  secretAgeDays,
} from '../../services/secret-hygiene';

interface SecretsHygienePanelProps {
  secrets: RepoSecret[];
  /** Injectable for tests and screenshots. */
  now?: Date;
}

const mono = { fontFamily: 'monospace', fontSize: '0.8rem' } as const;

export function SecretsHygienePanel({ secrets, now = new Date() }: SecretsHygienePanelProps) {
  const stale = findStaleSecrets(secrets, now);
  const shared = findSharedSecretNames(secrets);
  const archived = findSecretsOnArchivedRepos(secrets);
  const unknownAge = secrets.filter((s) => secretAgeDays(s, now) === null).length;

  return (
    <div class="org-panel secrets-hygiene-panel">
      <div class="org-panel-header">Secret hygiene</div>
      <p style={{ fontSize: '0.8rem', color: '#99a', marginBottom: '0.6rem' }}>
        Repository Actions secrets only (environment and org secrets are not scanned yet).
        {unknownAge > 0 && ` ${unknownAge} secret${unknownAge !== 1 ? 's have' : ' has'} an unknown age until the next rescan.`}
      </p>

      <h4 style={{ margin: '0.5rem 0 0.25rem' }}>Not rotated in {STALE_SECRET_MONTHS} months ({stale.length})</h4>
      {stale.length === 0 ? (
        <div style={{ color: '#99a', fontSize: '0.82rem' }}>None.</div>
      ) : (
        <ul class="secrets-stale-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {stale.map((s) => (
            <li key={`${s.full_name}/${s.secret_name}`} style={{ padding: '0.1rem 0' }}>
              <span style={mono}>{s.secret_name}</span> <span style={{ color: '#99a', fontSize: '0.8rem' }}>
                in {s.full_name} — {formatSecretAge(s.ageDays)} old
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4 style={{ margin: '0.75rem 0 0.25rem' }}>Shared across {SHARED_SECRET_MIN_REPOS}+ repos ({shared.length})</h4>
      {shared.length === 0 ? (
        <div style={{ color: '#99a', fontSize: '0.82rem' }}>None — candidates for an org secret would show here.</div>
      ) : (
        <ul class="secrets-shared-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {shared.map((s) => (
            <li key={s.secret_name} style={{ padding: '0.1rem 0' }} title={s.repos.join('\n')}>
              <span style={mono}>{s.secret_name}</span> <span style={{ color: '#99a', fontSize: '0.8rem' }}>
                in {s.repos.length} repos — org secret candidate
              </span>
            </li>
          ))}
        </ul>
      )}

      <h4 style={{ margin: '0.75rem 0 0.25rem' }}>On archived repos ({archived.length})</h4>
      {archived.length === 0 ? (
        <div style={{ color: '#99a', fontSize: '0.82rem' }}>None.</div>
      ) : (
        <ul class="secrets-archived-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {archived.map((s) => (
            <li key={`${s.full_name}/${s.secret_name}`} style={{ padding: '0.1rem 0' }}>
              <span style={mono}>{s.secret_name}</span> <span style={{ color: '#99a', fontSize: '0.8rem' }}>
                in {s.full_name} (archived) — consider deleting
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
