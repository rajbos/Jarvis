import { StatusBadge } from '../shared/StatusBadge';
import { DiscoverySection } from './DiscoverySection';
import type { OAuthStatus, DiscoveryProgress } from '../types';

interface GitHubStepProps {
  oauthStatus: OAuthStatus | null;
  deviceCode: { userCode: string; verificationUri: string } | null;
  discoveryProgress: DiscoveryProgress | null;
  discoveryFinished: boolean;
  onLogin: () => void;
  onToggleOrgs: () => void;
  loginDisabled: boolean;
}

export function GitHubStep({
  oauthStatus,
  deviceCode,
  discoveryProgress,
  discoveryFinished,
  onLogin,
  onToggleOrgs,
  loginDisabled,
}: GitHubStepProps) {
  const authenticated = oauthStatus?.authenticated;
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
