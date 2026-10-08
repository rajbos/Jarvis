import type { AppUpdater } from 'electron-updater';

/**
 * electron-updater's NsisUpdater.verifySignature() treats a missing
 * `publisherName` (i.e. an unsigned build) as "verified" and installs the
 * download after only a SHA512 check against latest.yml. That fails open, so a
 * compromised release would be auto-installed. This wraps it to fail closed:
 * no recorded publisher means the update is rejected and never installed.
 */
export const MISSING_PUBLISHER_REASON =
  'no publisherName is recorded in app-update.yml (this build is not code-signed), so the update cannot be verified';

interface VerifiableUpdater {
  verifySignature?: (tempUpdateFile: string) => Promise<string | null>;
  configOnDisk?: { value: Promise<{ publisherName?: string | string[] | null }> };
}

/** Returns an error string when the update must be rejected, or null to defer to the original check. */
export async function checkPublisherPresent(updater: VerifiableUpdater): Promise<string | null> {
  try {
    const config = await updater.configOnDisk?.value;
    const name = config?.publisherName;
    const hasPublisher = Array.isArray(name) ? name.length > 0 : typeof name === 'string' && name.trim() !== '';
    return hasPublisher ? null : MISSING_PUBLISHER_REASON;
  } catch (error) {
    return `the update configuration could not be read (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * Wraps `verifySignature` on the updater so a missing publisher fails closed.
 * Returns true when the hook was installed (NsisUpdater / Windows), false when
 * the updater has no signature-verification step to harden.
 */
export function enforceSignatureVerification(
  updater: AppUpdater,
  log: { warn: (...args: unknown[]) => void } = console,
): boolean {
  const target = updater as unknown as VerifiableUpdater;
  const original = target.verifySignature;
  if (typeof original !== 'function') return false;

  target.verifySignature = async (tempUpdateFile: string) => {
    const reason = await checkPublisherPresent(target);
    if (reason) {
      log.warn(`[Updates] Rejecting downloaded update: ${reason}`);
      return reason;
    }
    return original.call(target, tempUpdateFile);
  };
  return true;
}
