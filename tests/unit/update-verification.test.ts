import { describe, expect, it, vi } from 'vitest';
import type { AppUpdater } from 'electron-updater';
import {
  MISSING_PUBLISHER_REASON,
  checkPublisherPresent,
  enforceSignatureVerification,
} from '../../src/main/update-verification';

function fakeUpdater(config: Promise<{ publisherName?: string | string[] | null }>, original = vi.fn(async (_file: string): Promise<string | null> => null)) {
  const updater = { verifySignature: original, configOnDisk: { value: config } };
  return { updater, original, asUpdater: updater as unknown as AppUpdater };
}

describe('update signature verification fails closed', () => {
  it('rejects an update when app-update.yml has no publisherName', async () => {
    const { updater, original, asUpdater } = fakeUpdater(Promise.resolve({}));
    const log = { warn: vi.fn() };
    expect(enforceSignatureVerification(asUpdater, log)).toBe(true);

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

  it('rejects when app-update.yml cannot be read (upstream would treat ENOENT as verified)', async () => {
    const { updater, original, asUpdater } = fakeUpdater(
      Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' })),
    );
    enforceSignatureVerification(asUpdater, { warn: vi.fn() });

    const result = await updater.verifySignature('x.exe');
    expect(result).toContain('could not be read');
    expect(original).not.toHaveBeenCalled();
  });

  it('defers to the real Authenticode check when a publisherName exists', async () => {
    const original = vi.fn(async (_file: string): Promise<string | null> => 'signature mismatch');
    const { updater, asUpdater } = fakeUpdater(Promise.resolve({ publisherName: ['Jarvis Publisher'] }), original);
    enforceSignatureVerification(asUpdater, { warn: vi.fn() });

    await expect(updater.verifySignature('x.exe')).resolves.toBe('signature mismatch');
    expect(original).toHaveBeenCalledWith('x.exe');
  });

  it('passes through a successful verification', async () => {
    const { updater, asUpdater } = fakeUpdater(Promise.resolve({ publisherName: 'Jarvis Publisher' }));
    enforceSignatureVerification(asUpdater, { warn: vi.fn() });
    await expect(updater.verifySignature('x.exe')).resolves.toBeNull();
  });

  it('does nothing for updaters without a signature step', () => {
    expect(enforceSignatureVerification({} as unknown as AppUpdater)).toBe(false);
  });
});
