import { StatusBadge } from '../shared/StatusBadge';
import { DiscoverySection } from './DiscoverySection';
import type { OAuthStatus, DiscoveryProgress, PatStatus } from '../types';

interface GitHubStepProps {
  oauthStatus: OAuthStatus | null;
  patStatus: PatStatus | null;
  /** Expiry date of the PAT from the github-authentication-token-expiration header (null when it does not expire) */
  patExpiresAt?: string | null;
  deviceCode: { userCode: string; verificationUri: string } | null;
  discoveryProgress: DiscoveryProgress | null;
  discoveryFinished: boolean;
  onLogin: () => void;
  onToggleOrgs: () => void;
  onOpenSettings: () => void;
  loginDisabled: boolean;
}

export function GitHubStep({
  oauthStatus,
  patStatus,
  patExpiresAt,
  deviceCode,
  discoveryProgress,
  discoveryFinished,
  onLogin,
  onToggleOrgs,
  onOpenSettings,
  loginDisabled,
}: GitHubStepProps) {
  const authenticated = oauthStatus?.authenticated;

  // The header value looks like "2026-09-30 12:34:56 UTC" — normalize to ISO-ish for Date parsing
  const patExpiryDate = patExpiresAt ? new Date(patExpiresAt.replace(' UTC', 'Z')) : null;
  const patExpiryValid = patExpiryDate !== null && !isNaN(patExpiryDate.getTime());
  const patExpiredByDate = patExpiryValid && patExpiryDate!.getTime() <= Date.now();
  const patExpiringSoon =
    patExpiryValid && !patExpiredByDate &&
    patExpiryDate!.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000;
  const patExpired = Boolean(patStatus?.expired) || patExpiredByDate;
  let badgeStatus: 'pending' | 'completed' | 'in-progress' = 'pending';
  let badgeLabel = 'Pending';
  if (authenticated) {
    badgeStatus = 'completed';
    badgeLabel = 'Connected';
  } else if (deviceCode) {
    badgeStatus = 'in-progress';
    badgeLabel = 'Waiting...';
  }

  return (
    <div class="step" id="github-step">
      <h2>
        GitHub Account <StatusBadge status={badgeStatus} label={badgeLabel} />
      </h2>
      {!authenticated && <p>Connect your GitHub account to discover organizations and repositories.</p>}

      {!authenticated && !deviceCode && (
        <button onClick={onLogin} disabled={loginDisabled}>
          {loginDisabled ? 'Starting...' : 'Sign in with GitHub'}
        </button>
      )}

      {!authenticated && deviceCode && (
        <div>
          <div class="user-code">{deviceCode.userCode}</div>
          <p class="code-instructions">
            Enter this code at{' '}
            <a href={deviceCode.verificationUri} target="_blank">
              {deviceCode.verificationUri.replace('https://', '')}
            </a>
          </p>
          <p class="code-instructions" style={{ marginTop: '0.5rem' }}>
            Waiting for authorization...
          </p>
        </div>
      )}

      {authenticated && oauthStatus && (
        <div class="user-info">
          {oauthStatus.avatarUrl && <img src={oauthStatus.avatarUrl} alt="avatar" />}
          <div>
            <div class="name">{oauthStatus.login}</div>
            <div class="login">@{oauthStatus.login}</div>
          </div>
        </div>
      )}

      {authenticated && patStatus?.hasPat && (
        <div class="pat-row">
          <span>
            Personal Access Token
            {patExpiryValid && !patExpired && (
              <span style={{ color: '#8892b0' }}>
                {' '}— expires {patExpiryDate!.toLocaleDateString()}
              </span>
            )}
          </span>
          {patExpired
            ? <StatusBadge status="error" label="Expired" />
            : patExpiringSoon
              ? <StatusBadge status="pending" label="Expiring soon" />
              : <StatusBadge status="completed" label="PAT Connected" />}
        </div>
      )}

      {authenticated && patStatus?.hasPat && patExpiringSoon && (
        <div class="pat-expired-warning" style={{ background: '#3d320a', borderColor: '#ffd43b', color: '#ffec99' }}>
          ⚠️ Your GitHub Personal Access Token expires on {patExpiryDate!.toLocaleDateString()}.
          Generate a new one before then to keep org repo discovery working.
          <br />
          <button onClick={onOpenSettings} style={{ background: '#ffd43b' }}>Open Settings to replace the token</button>
        </div>
      )}

      {authenticated && patStatus?.hasPat && patExpired && (
        <div class="pat-expired-warning">
          ⚠️ Your GitHub Personal Access Token has expired or been revoked. Repository
          discovery and other features that rely on it will fail until you enter a new token.
          <br />
          <button onClick={onOpenSettings}>Open Settings to refresh the token</button>
        </div>
      )}

      {authenticated && (
        <DiscoverySection
          progress={discoveryProgress}
          finished={discoveryFinished}
          onToggleOrgs={onToggleOrgs}
        />
      )}
    </div>
  );
}
