import crypto, { createHash } from 'crypto';
import { createReadStream } from 'fs';
import type { AppUpdater } from 'electron-updater';
import { bundleFromJSON } from '@sigstore/bundle';
import { getTrustedRoot } from '@sigstore/tuf';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';

/**
 * electron-updater's NsisUpdater.verifySignature() treats a missing
 * `publisherName` (i.e. an unsigned build) as "verified" and installs the
 * download after only a SHA512 check against latest.yml. That fails open, so a
 * compromised release would be auto-installed. This wraps it to fail closed.
 *
 * Jarvis releases are not Authenticode-signed, but release.yml records a
 * Sigstore build-provenance attestation for every installer. For unsigned
 * builds the download is accepted only when GitHub holds an attestation for its
 * exact SHA-256 that was signed by release.yml running on the tag of the
 * version being installed. Anything else is rejected and never installed.
 */
export const MISSING_PUBLISHER_REASON =
  'no publisherName is recorded in app-update.yml (this build is not code-signed), so the update cannot be verified';

const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const FETCH_TIMEOUT_MS = 20_000;

export interface AttestationPolicy {
  /** `owner/repo` the release is published from. */
  repo: string;
  /** Workflow that builds releases, relative to the repo root. */
  workflowPath: string;
  /** Directory where the Sigstore TUF trust root is cached between checks. */
  tufCachePath: string;
}

type TrustedRoot = Awaited<ReturnType<typeof getTrustedRoot>>;

/**
 * Electron ships BoringSSL, where `crypto.verify(undefined, ...)` throws
 * NO_DEFAULT_DIGEST for EC keys (OpenSSL in plain Node defaults to SHA-256).
 * tuf-js verifies the TUF root with exactly that call, swallows the error, and
 * reports "root was signed by 0/3 keys", so the trust root never loads in the
 * packaged app. Default the digest to SHA-256 (what Sigstore's ECDSA P-256 TUF
 * keys use) while the trust root is loaded, then restore the original.
 */
export async function withDefaultEcDigest<T>(run: () => Promise<T>): Promise<T> {
  const original = crypto.verify;
  const patched = ((algorithm: string | null | undefined, ...rest: unknown[]) =>
    (original as (...args: unknown[]) => boolean)(algorithm ?? 'sha256', ...rest)) as typeof crypto.verify;
  crypto.verify = patched;
  try {
    return await run();
  } finally {
    if (crypto.verify === patched) crypto.verify = original;
  }
}

export interface AttestationDeps {
  fetch?: typeof fetch;
  /** Defaults to the Sigstore public-good trust root, fetched and cached via TUF. */
  loadTrustedRoot?: () => Promise<TrustedRoot>;
}

interface VerifiableUpdater {
  verifySignature?: (tempUpdateFile: string) => Promise<string | null>;
  configOnDisk?: { value: Promise<{ publisherName?: string | string[] | null }> };
}

type PublisherState = { kind: 'present' } | { kind: 'missing' } | { kind: 'unreadable'; reason: string };

async function readPublisher(updater: VerifiableUpdater): Promise<PublisherState> {
  try {
    const config = await updater.configOnDisk?.value;
    const name = config?.publisherName;
    const hasPublisher = Array.isArray(name) ? name.length > 0 : typeof name === 'string' && name.trim() !== '';
    return hasPublisher ? { kind: 'present' } : { kind: 'missing' };
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `the update configuration could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/** Returns an error string when no Authenticode publisher is configured, or null when one is. */
export async function checkPublisherPresent(updater: VerifiableUpdater): Promise<string | null> {
  const state = await readPublisher(updater);
  if (state.kind === 'present') return null;
  return state.kind === 'missing' ? MISSING_PUBLISHER_REASON : state.reason;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function verifyWithSigstore(
  bundleJson: unknown,
  expectedIdentity: string,
  verifier: Verifier,
): { payloadType: string; payload: Buffer } {
  const bundle = bundleFromJSON(bundleJson);
  if (bundle.content.$case !== 'dsseEnvelope') throw new Error('attestation is not a DSSE envelope');
  verifier.verify(toSignedEntity(bundle), {
    subjectAlternativeName: expectedIdentity,
    extensions: { issuer: GITHUB_ACTIONS_ISSUER },
  });
  const envelope = bundle.content.dsseEnvelope;
  return { payloadType: envelope.payloadType, payload: Buffer.from(envelope.payload) };
}

function statementCoversDigest(payload: Buffer, sha256: string): boolean {
  try {
    const statement = JSON.parse(payload.toString('utf8')) as { subject?: Array<{ digest?: { sha256?: string } }> };
    return (statement.subject ?? []).some((s) => s.digest?.sha256?.toLowerCase() === sha256);
  } catch {
    return false;
  }
}

/**
 * Checks attestations returned by GitHub for an artifact with the given SHA-256.
 * Accepts when any one is a valid Sigstore bundle signed by the release workflow
 * on tag `v<expectedVersion>` whose in-toto statement covers that digest.
 * Returns null when verified, or a human-readable reason it was rejected.
 */
export async function verifyAttestationBundles(
  attestations: Array<{ bundle?: unknown }>,
  sha256: string,
  expectedVersion: string,
  policy: AttestationPolicy,
  deps: AttestationDeps = {},
): Promise<string | null> {
  const bundles = attestations.map((a) => a.bundle).filter((b) => b != null);
  if (bundles.length === 0) {
    return `GitHub has no usable build provenance attestation for this download (sha256:${sha256})`;
  }

  const expectedIdentity = `https://github.com/${policy.repo}/${policy.workflowPath}@refs/tags/v${expectedVersion}`;
  let verifier: Verifier;
  try {
    const root = await (deps.loadTrustedRoot ?? (() => withDefaultEcDigest(() => getTrustedRoot({ cachePath: policy.tufCachePath }))))();
    verifier = new Verifier(toTrustMaterial(root));
  } catch (error) {
    return `the Sigstore trust root could not be loaded (${error instanceof Error ? error.message : String(error)})`;
  }

  // The transparency-log timestamp (SET) and signature checks also call
  // crypto.verify(undefined, ...) with EC keys, so they need the same digest default.
  return withDefaultEcDigest(async () => {
    const failures: string[] = [];
    for (const bundleJson of bundles) {
      try {
        const { payloadType, payload } = verifyWithSigstore(bundleJson, expectedIdentity, verifier);
        if (payloadType !== IN_TOTO_PAYLOAD_TYPE) {
          failures.push(`unexpected payload type ${payloadType}`);
        } else if (!statementCoversDigest(payload, sha256)) {
          failures.push('attestation does not cover this file');
        } else {
          return null;
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    return `the build provenance attestation for this download did not verify: ${failures.join('; ')}`;
  });
}

/**
 * Verifies a downloaded installer against its GitHub build-provenance attestation.
 * Returns null when verified, or a human-readable reason it was rejected.
 */
export async function verifyReleaseAttestation(
  filePath: string,
  expectedVersion: string,
  policy: AttestationPolicy,
  deps: AttestationDeps = {},
): Promise<string | null> {
  let digest: string;
  try {
    digest = await sha256File(filePath);
  } catch (error) {
    return `the downloaded update could not be read for verification (${error instanceof Error ? error.message : String(error)})`;
  }

  const url = `https://api.github.com/repos/${policy.repo}/attestations/sha256:${digest}`;
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return `the build provenance attestation could not be fetched from GitHub (${error instanceof Error ? error.message : String(error)})`;
  }
  if (response.status === 404) {
    return `no build provenance attestation exists for this download (sha256:${digest}), so it was not built by ${policy.workflowPath}`;
  }
  if (!response.ok) {
    return `the build provenance attestation could not be fetched from GitHub (HTTP ${response.status})`;
  }

  let attestations: Array<{ bundle?: unknown }>;
  try {
    attestations = ((await response.json()) as { attestations?: Array<{ bundle?: unknown }> }).attestations ?? [];
  } catch {
    return 'GitHub returned an unreadable attestation response';
  }
  return verifyAttestationBundles(attestations, digest, expectedVersion, policy, deps);
}

export interface SignatureVerificationOptions {
  log?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
  /** Enables the attestation fallback for builds without an Authenticode publisher. */
  attestation?: {
    policy: () => AttestationPolicy;
    /** Version the updater announced; the attestation must come from its tag. */
    getExpectedVersion: () => string | null;
    deps?: AttestationDeps;
  };
}

/**
 * Wraps `verifySignature` on the updater so unverifiable downloads fail closed.
 * Returns true when the hook was installed (NsisUpdater / Windows), false when
 * the updater has no signature-verification step to harden.
 */
export function enforceSignatureVerification(updater: AppUpdater, options: SignatureVerificationOptions = {}): boolean {
  const log = options.log ?? console;
  const target = updater as unknown as VerifiableUpdater;
  const original = target.verifySignature;
  if (typeof original !== 'function') return false;

  const reject = (reason: string): string => {
    log.warn(`[Updates] Rejecting downloaded update: ${reason}`);
    return reason;
  };

  target.verifySignature = async (tempUpdateFile: string) => {
    const publisher = await readPublisher(target);
    if (publisher.kind === 'present') return original.call(target, tempUpdateFile);
    if (publisher.kind === 'unreadable') return reject(publisher.reason);

    const attestation = options.attestation;
    if (!attestation) return reject(MISSING_PUBLISHER_REASON);

    const version = attestation.getExpectedVersion();
    if (!version) return reject('the version of the downloaded update is unknown, so its build provenance cannot be checked');

    const reason = await verifyReleaseAttestation(tempUpdateFile, version, attestation.policy(), attestation.deps);
    if (reason) return reject(reason);
    log.info?.(`[Updates] Verified build provenance of Jarvis ${version} against ${attestation.policy().workflowPath}`);
    return null;
  };
  return true;
}
