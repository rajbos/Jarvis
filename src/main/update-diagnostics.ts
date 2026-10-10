import type { DiagnosticReport } from '../types/ipc-payloads';

export const RELEASES_URL = 'https://github.com/rajbos/Jarvis/releases';

export type UpdateErrorCategory = 'verification-failed' | 'release-missing' | 'rate-limited' | 'offline' | 'unknown';

interface CategoryInfo {
  label: string;
  summary: string;
  /** Body for the OS notification shown after a manual check. */
  notification: string;
}

const CATEGORIES: Record<UpdateErrorCategory, CategoryInfo> = {
  'verification-failed': {
    label: 'Update could not be verified',
    summary:
      'Jarvis downloaded the update but could not prove it was built by the official release workflow, so it was not installed. ' +
      'This protects against tampered releases; check that the release has a build provenance attestation.',
    notification: 'The downloaded update could not be verified and was not installed.',
  },
  'release-missing': {
    label: 'Release metadata missing',
    summary:
      'GitHub Releases did not have the files Jarvis needs to update (latest.yml or the installer). ' +
      'The latest release may still be uploading, or its assets are incomplete.',
    notification: 'The latest release on GitHub is missing its update files.',
  },
  'rate-limited': {
    label: 'GitHub rate limit',
    summary: 'GitHub refused the request because of rate limiting. Jarvis will check again later.',
    notification: 'GitHub rate-limited the update check. Try again later.',
  },
  offline: {
    label: 'GitHub unreachable',
    summary: 'Jarvis could not reach GitHub. Check the network connection, VPN or proxy.',
    notification: 'Jarvis could not reach GitHub Releases. Try again later.',
  },
  unknown: {
    label: 'Unexpected error',
    summary: 'The update check failed for a reason Jarvis does not recognise. The log has the full error.',
    notification: 'The update check failed. Open Jarvis for details.',
  },
};

const OFFLINE_CODES = /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b|net::ERR_/;

function errorFields(error: unknown): { message: string; code?: string; statusCode?: number } {
  if (error instanceof Error) {
    const e = error as Error & { code?: unknown; statusCode?: unknown };
    return {
      message: e.message,
      code: typeof e.code === 'string' ? e.code : undefined,
      statusCode: typeof e.statusCode === 'number' ? e.statusCode : undefined,
    };
  }
  return { message: String(error) };
}

export function classifyUpdateError(error: unknown): UpdateErrorCategory {
  const { message, code, statusCode } = errorFields(error);
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE' || /not signed by the application owner|build provenance/i.test(message)) {
    return 'verification-failed';
  }
  if (statusCode === 429 || /rate limit/i.test(message)) return 'rate-limited';
  if (
    statusCode === 404
    || code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    || code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
    || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
    || /Cannot find .+ in the latest release artifacts/.test(message)
  ) {
    return 'release-missing';
  }
  if (OFFLINE_CODES.test(`${code ?? ''} ${message}`)) return 'offline';
  return 'unknown';
}

export function updateErrorNotification(error: unknown): string {
  return CATEGORIES[classifyUpdateError(error)].notification;
}

export function buildUpdateDiagnostic(
  error: unknown,
  context: { currentVersion: string; targetVersion: string | null; now?: Date },
): DiagnosticReport {
  const category = classifyUpdateError(error);
  const info = CATEGORIES[category];
  const { message, code, statusCode } = errorFields(error);
  const now = context.now ?? new Date();

  const facts: DiagnosticReport['facts'] = [
    { label: 'Cause', value: info.label },
    { label: 'Installed version', value: context.currentVersion },
  ];
  if (context.targetVersion) facts.push({ label: 'Update version', value: context.targetVersion });
  if (code) facts.push({ label: 'Error code', value: code });
  if (statusCode) facts.push({ label: 'HTTP status', value: String(statusCode) });
  facts.push({ label: 'Error', value: message });

  const links = [{ label: 'Releases page', url: RELEASES_URL }];
  if (context.targetVersion) {
    links.push({ label: `Release v${context.targetVersion}`, url: `${RELEASES_URL}/tag/v${context.targetVersion}` });
  }

  return {
    id: `updates-${now.getTime()}`,
    source: 'updates',
    title: 'Update check failed',
    summary: info.summary,
    facts,
    logFilter: 'Update',
    links,
    retry: 'update-check',
    occurredAt: now.toISOString(),
  };
}
