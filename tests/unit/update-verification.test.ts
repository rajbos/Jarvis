import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { AppUpdater } from 'electron-updater';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import {
  MISSING_PUBLISHER_REASON,
  checkPublisherPresent,
  enforceSignatureVerification,
  sha256File,
  verifyAttestationBundles,
  verifyReleaseAttestation,
  withDefaultEcDigest,
  type AttestationPolicy,
} from '../../src/main/update-verification';

const FIXTURES = path.join(__dirname, 'fixtures', 'attestation');
// Real attestation recorded by release.yml for Jarvis-Setup-0.2.1.exe, and the
// Sigstore public-good trust root, so verification runs offline.
const REAL_ATTESTATIONS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'jarvis-0.2.1-attestations.json'), 'utf8')) as {
  attestations: Array<{ bundle?: unknown }>;
};
const REAL_DIGEST = 'aba16a31352acc3dd4d9c3f7e59c3e011451a2769b6735e6703a955f91b3eaf5';
const loadTrustedRoot = async () =>
  TrustedRoot.fromJSON(JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sigstore-trusted-root.json'), 'utf8')));

const POLICY: AttestationPolicy = {
  repo: 'rajbos/Jarvis',
  workflowPath: '.github/workflows/release.yml',
  tufCachePath: path.join(os.tmpdir(), 'unused-tuf-cache'),
};

function fakeUpdater(config: Promise<{ publisherName?: string | string[] | null }>, original = vi.fn(async (_file: string): Promise<string | null> => null)) {
  const updater = { verifySignature: original, configOnDisk: { value: config } };
  return { updater, original, asUpdater: updater as unknown as AppUpdater };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function tempFile(contents: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-verify-')), 'Jarvis-Setup.exe');
  fs.writeFileSync(file, contents);
  return file;
}

describe('update signature verification fails closed', () => {
  it('rejects an update when app-update.yml has no publisherName and no attestation fallback is configured', async () => {
    const { updater, original, asUpdater } = fakeUpdater(Promise.resolve({}));
    const log = { warn: vi.fn() };
    expect(enforceSignatureVerification(asUpdater, { log })).toBe(true);

    await expect(updater.verifySignature('C:\\tmp\\Jarvis-Setup.exe')).resolves.toBe(MISSING_PUBLISHER_REASON);
    expect(original).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('rejects an empty publisherName', async () => {
    expect(await checkPublisherPresent({ configOnDisk: { value: Promise.resolve({ publisherName: '' }) } }))
      .toBe(MISSING_PUBLISHER_REASON);
    expect(await checkPublisherPresent({ configOnDisk: { value: Promise.resolve({ publisherName: [] }) } }))
      .toBe(MISSING_PUBLISHER_REASON);
  });

  it('rejects when app-update.yml cannot be read, even with the attestation fallback', async () => {
    const { updater, original, asUpdater } = fakeUpdater(
      Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' })),
    );
    const fetchMock = vi.fn();
    enforceSignatureVerification(asUpdater, {
      log: { warn: vi.fn() },
      attestation: { policy: () => POLICY, getExpectedVersion: () => '0.2.1', deps: { fetch: fetchMock } },
    });

    const result = await updater.verifySignature('x.exe');
    expect(result).toContain('could not be read');
    expect(original).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defers to the real Authenticode check when a publisherName exists', async () => {
    const original = vi.fn(async (_file: string): Promise<string | null> => 'signature mismatch');
    const { updater, asUpdater } = fakeUpdater(Promise.resolve({ publisherName: ['Jarvis Publisher'] }), original);
    enforceSignatureVerification(asUpdater, { log: { warn: vi.fn() } });

    await expect(updater.verifySignature('x.exe')).resolves.toBe('signature mismatch');
    expect(original).toHaveBeenCalledWith('x.exe');
  });

  it('passes through a successful verification', async () => {
    const { updater, asUpdater } = fakeUpdater(Promise.resolve({ publisherName: 'Jarvis Publisher' }));
    enforceSignatureVerification(asUpdater, { log: { warn: vi.fn() } });
    await expect(updater.verifySignature('x.exe')).resolves.toBeNull();
  });

  it('does nothing for updaters without a signature step', () => {
    expect(enforceSignatureVerification({} as unknown as AppUpdater)).toBe(false);
  });
});

describe('build provenance attestation fallback for unsigned builds', () => {
  it('accepts the real v0.2.1 attestation for its own tag and digest', async () => {
    await expect(verifyAttestationBundles(REAL_ATTESTATIONS.attestations, REAL_DIGEST, '0.2.1', POLICY, { loadTrustedRoot }))
      .resolves.toBeNull();
  });

  it('still verifies when crypto.verify rejects an undefined digest, as BoringSSL in Electron does', async () => {
    const original = crypto.verify;
    crypto.verify = ((algorithm: string | null | undefined, ...rest: unknown[]) => {
      if (algorithm == null) throw new Error('NO_DEFAULT_DIGEST');
      return (original as (...args: unknown[]) => boolean)(algorithm, ...rest);
    }) as typeof crypto.verify;
    try {
      await expect(verifyAttestationBundles(REAL_ATTESTATIONS.attestations, REAL_DIGEST, '0.2.1', POLICY, { loadTrustedRoot }))
        .resolves.toBeNull();
    } finally {
      crypto.verify = original;
    }
  });

  it('rejects the real attestation when the updater announced a different version (downgrade/replay)', async () => {
    const result = await verifyAttestationBundles(REAL_ATTESTATIONS.attestations, REAL_DIGEST, '0.2.2', POLICY, { loadTrustedRoot });
    expect(result).toContain('did not verify');
    expect(result).toContain('refs/tags/v0.2.2');
  });

  it('rejects the real attestation for a file with a different digest', async () => {
    const otherDigest = 'f'.repeat(64);
    const result = await verifyAttestationBundles(REAL_ATTESTATIONS.attestations, otherDigest, '0.2.1', POLICY, { loadTrustedRoot });
    expect(result).toContain('does not cover this file');
  });

  it('rejects an attestation signed by a different workflow', async () => {
    const result = await verifyAttestationBundles(
      REAL_ATTESTATIONS.attestations, REAL_DIGEST, '0.2.1',
      { ...POLICY, workflowPath: '.github/workflows/ci.yml' }, { loadTrustedRoot },
    );
    expect(result).toContain('did not verify');
  });

  it('rejects a tampered bundle', async () => {
    const bundle = structuredClone(REAL_ATTESTATIONS.attestations[0]!.bundle) as { dsseEnvelope: { payload: string } };
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')) as {
      subject: Array<{ digest: { sha256: string } }>;
    };
    statement.subject[0]!.digest.sha256 = 'e'.repeat(64);
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');

    const result = await verifyAttestationBundles([{ bundle }], 'e'.repeat(64), '0.2.1', POLICY, { loadTrustedRoot });
    expect(result).toContain('did not verify');
  });

  it('rejects when GitHub has no attestation for the download', async () => {
    const file = tempFile('not a real installer');
    const digest = await sha256File(file);
    const fetchMock = vi.fn(async () => jsonResponse(404, { message: 'Not Found' }));

    const result = await verifyReleaseAttestation(file, '0.2.1', POLICY, { fetch: fetchMock as unknown as typeof fetch, loadTrustedRoot });
    expect(result).toContain('no build provenance attestation exists');
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/rajbos/Jarvis/attestations/sha256:${digest}`,
      expect.anything(),
    );
  });

  it('rejects when GitHub cannot be reached', async () => {
    const file = tempFile('x');
    const fetchMock = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); });
    const result = await verifyReleaseAttestation(file, '0.2.1', POLICY, { fetch: fetchMock as unknown as typeof fetch });
    expect(result).toContain('could not be fetched');
  });

  it('wires the fallback into verifySignature and rejects when the expected version is unknown', async () => {
    const { updater, original, asUpdater } = fakeUpdater(Promise.resolve({}));
    enforceSignatureVerification(asUpdater, {
      log: { warn: vi.fn() },
      attestation: { policy: () => POLICY, getExpectedVersion: () => null },
    });
    await expect(updater.verifySignature('x.exe')).resolves.toContain('version of the downloaded update is unknown');
    expect(original).not.toHaveBeenCalled();
  });

  it('runs the attestation check from verifySignature for unsigned downloads', async () => {
    const file = tempFile('installer bytes');
    const digest = await sha256File(file);
    // Fake a GitHub response whose bundle is the real one; the digest won't match
    // the statement, so this proves the subject check runs end to end.
    const fetchMock = vi.fn(async () => jsonResponse(200, REAL_ATTESTATIONS));
    const { updater, asUpdater } = fakeUpdater(Promise.resolve({}));
    enforceSignatureVerification(asUpdater, {
      log: { warn: vi.fn(), info: vi.fn() },
      attestation: {
        policy: () => POLICY,
        getExpectedVersion: () => '0.2.1',
        deps: { fetch: fetchMock as unknown as typeof fetch, loadTrustedRoot },
      },
    });

    await expect(updater.verifySignature(file)).resolves.toContain('does not cover this file');
    expect(digest).not.toBe(REAL_DIGEST);
  });
});

describe('withDefaultEcDigest', () => {
  it('defaults the digest to sha256 only while running, then restores crypto.verify', async () => {
    const original = crypto.verify;
    const spy = vi.fn(() => true);
    crypto.verify = spy as unknown as typeof crypto.verify;
    try {
      await withDefaultEcDigest(async () => {
        (crypto.verify as (...args: unknown[]) => boolean)(undefined, Buffer.alloc(0), 'key', Buffer.alloc(0));
        (crypto.verify as (...args: unknown[]) => boolean)('sha512', Buffer.alloc(0), 'key', Buffer.alloc(0));
      });
      expect(spy.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['sha256', 'sha512']);
      expect(crypto.verify).toBe(spy);
    } finally {
      crypto.verify = original;
    }
  });

  it('restores crypto.verify when the callback throws', async () => {
    const original = crypto.verify;
    await expect(withDefaultEcDigest(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(crypto.verify).toBe(original);
  });
});
