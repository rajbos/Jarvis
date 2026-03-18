import type { RepoSecret, SecretsScanResult, SecretsScanProgress } from '../types';

interface SecretsScanPanelProps {
  scanning: boolean;
  scanProgress: SecretsScanProgress | null;
  lastResult: SecretsScanResult | null;
  secrets: RepoSecret[];
  onScan: () => void;
  onClose: () => void;
}

export function SecretsScanPanel({
  scanning,
  scanProgress,
  lastResult,
  secrets,
  onScan,
  onClose,
}: SecretsScanPanelProps) {
  // Group secrets by repo
  const byRepo = new Map<string, string[]>();
  for (const s of secrets) {
    const list = byRepo.get(s.full_name) ?? [];
    list.push(s.secret_name);
    byRepo.set(s.full_name, list);
  }

  return (
    <div class="org-panel secrets-panel">
      <div class="org-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Repository Secrets</span>
        <button class="repo-panel-close" title="Close" onClick={onClose}>&times;</button>
      </div>

      <p style={{ fontSize: '0.82rem', color: '#c8c8c8', marginBottom: '0.75rem' }}>
        Scans your personal repositories for GitHub Actions secret names via the GitHub API.
        Only secret <em>names</em> are retrieved — values are never exposed.
      </p>

      <button
        onClick={onScan}
        disabled={scanning}
        style={{ width: '100%', marginBottom: '0.75rem' }}
      >
        {scanning ? 'Scanning…' : 'Scan Now'}
      </button>

      {scanning && scanProgress && scanProgress.total > 0 && (
        <div style={{ fontSize: '0.82rem', color: '#aab', marginBottom: '0.5rem' }}>
          Scanned {scanProgress.done} / {scanProgress.total} repos
          {scanProgress.secretsFound > 0 && (
            <span style={{ color: '#9a9' }}> — {scanProgress.secretsFound} secret{scanProgress.secretsFound !== 1 ? 's' : ''} found so far</span>
          )}
        </div>
      )}

      {lastResult?.error && (
        <div style={{ color: '#f88', fontSize: '0.82rem', marginBottom: '0.5rem' }}>
          Error: {lastResult.error}
        </div>
      )}

      {lastResult && !lastResult.error && (
        <div style={{ fontSize: '0.82rem', color: '#9a9', marginBottom: '0.75rem' }}>
          Scanned {lastResult.scanned} repo{lastResult.scanned !== 1 ? 's' : ''} —{' '}
          {lastResult.secretsFound} secret{lastResult.secretsFound !== 1 ? 's' : ''} found.
          {lastResult.errors && lastResult.errors.length > 0 && (
            <span style={{ color: '#fa8' }}>
              {' '}({lastResult.errors.length} error{lastResult.errors.length !== 1 ? 's' : ''})
            </span>
          )}
        </div>
      )}

      {byRepo.size === 0 && !scanning && (
        <div style={{ color: '#99a', fontSize: '0.82rem', padding: '0.35rem 0' }}>
          {lastResult ? 'No secrets found.' : 'No scan results yet.'}
        </div>
      )}

      {byRepo.size > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {Array.from(byRepo.entries()).map(([repo, names]) => (
            <li key={repo} style={{ marginBottom: '0.6rem' }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#ccc', marginBottom: '0.2rem' }}>
                {repo}
              </div>
              <ul style={{ listStyle: 'none', padding: '0 0 0 0.75rem', margin: 0 }}>
                {names.map((n) => (
                  <li key={n} style={{ fontSize: '0.8rem', color: '#99a', fontFamily: 'monospace', padding: '0.1rem 0' }}>
                    {n}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
