import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, deriveKey, generateKey, getEncryptionKey } from '../../src/storage/encryption';

const nodeRequire = createRequire(import.meta.url);

function withMockedElectron<T>(exportsObj: unknown, run: () => T): T {
  const moduleId = nodeRequire.resolve('electron');
  const originalEntry = nodeRequire.cache[moduleId];
  nodeRequire.cache[moduleId] = {
    id: moduleId,
    filename: moduleId,
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: [],
    isPreloading: false,
    parent: undefined,
    path: path.dirname(moduleId),
    require: nodeRequire,
  } as unknown as NodeJS.Module;
  try {
    return run();
  } finally {
    if (originalEntry) nodeRequire.cache[moduleId] = originalEntry;
    else delete nodeRequire.cache[moduleId];
  }
}

describe('Encryption', () => {
  it('should encrypt and decrypt a string correctly', () => {
    const key = generateKey();
    const plaintext = 'ghp_test_token_12345';

    const encrypted = encrypt(plaintext, key);
    expect(encrypted).not.toBe(plaintext);

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertexts for the same plaintext (random IV)', () => {
    const key = generateKey();
    const plaintext = 'same_input';

    const encrypted1 = encrypt(plaintext, key);
    const encrypted2 = encrypt(plaintext, key);

    expect(encrypted1).not.toBe(encrypted2);

    // Both should decrypt to the same value
    expect(decrypt(encrypted1, key)).toBe(plaintext);
    expect(decrypt(encrypted2, key)).toBe(plaintext);
  });

  it('should fail to decrypt with wrong key', () => {
    const key1 = generateKey();
    const key2 = generateKey();
    const plaintext = 'secret_data';

    const encrypted = encrypt(plaintext, key1);

    expect(() => decrypt(encrypted, key2)).toThrow();
  });

  it('should derive consistent keys from the same passphrase', () => {
    const key1 = deriveKey('my-secret');
    const key2 = deriveKey('my-secret');

    expect(key1.toString('hex')).toBe(key2.toString('hex'));
  });

  it('should derive different keys from different passphrases', () => {
    const key1 = deriveKey('passphrase-a');
    const key2 = deriveKey('passphrase-b');

    expect(key1.toString('hex')).not.toBe(key2.toString('hex'));
  });

  it('should generate a 32-byte key', () => {
    const key = generateKey();
    expect(key.length).toBe(32);
  });

  it('should use JARVIS_ENCRYPTION_KEY when provided', () => {
    const originalEnvKey = process.env.JARVIS_ENCRYPTION_KEY;
    process.env.JARVIS_ENCRYPTION_KEY = 'deterministic-test-secret';
    try {
      expect(getEncryptionKey().toString('hex')).toBe(
        deriveKey('deterministic-test-secret').toString('hex'),
      );
    } finally {
      if (originalEnvKey === undefined) delete process.env.JARVIS_ENCRYPTION_KEY;
      else process.env.JARVIS_ENCRYPTION_KEY = originalEnvKey;
    }
  });

  it('should fall back to a persisted random key when env key is absent', () => {
    const originalEnvKey = process.env.JARVIS_ENCRYPTION_KEY;
    const originalConfigDir = process.env.JARVIS_CONFIG_DIR;
    const originalComputerName = process.env.COMPUTERNAME;
    delete process.env.JARVIS_ENCRYPTION_KEY;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-encryption-fallback-'));
    process.env.JARVIS_CONFIG_DIR = configDir;
    process.env.COMPUTERNAME = 'CI-MACHINE';
    try {
      const key1 = getEncryptionKey();
      const key2 = getEncryptionKey();
      expect(key1.length).toBe(32);
      expect(key2.toString('hex')).toBe(key1.toString('hex'));
      expect(fs.existsSync(path.join(configDir, 'keystore.fallback.bin'))).toBe(true);
    } finally {
      if (originalEnvKey === undefined) delete process.env.JARVIS_ENCRYPTION_KEY;
      else process.env.JARVIS_ENCRYPTION_KEY = originalEnvKey;
      if (originalConfigDir === undefined) delete process.env.JARVIS_CONFIG_DIR;
      else process.env.JARVIS_CONFIG_DIR = originalConfigDir;
      if (originalComputerName === undefined) delete process.env.COMPUTERNAME;
      else process.env.COMPUTERNAME = originalComputerName;
    }
  });

  it('should not derive fallback key from COMPUTERNAME', () => {
    const originalEnvKey = process.env.JARVIS_ENCRYPTION_KEY;
    const originalConfigDir = process.env.JARVIS_CONFIG_DIR;
    const originalComputerName = process.env.COMPUTERNAME;
    delete process.env.JARVIS_ENCRYPTION_KEY;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-encryption-fallback-'));
    process.env.JARVIS_CONFIG_DIR = configDir;
    process.env.COMPUTERNAME = 'FIRST-HOST';
    try {
      const key1 = getEncryptionKey();
      process.env.COMPUTERNAME = 'SECOND-HOST';
      const key2 = getEncryptionKey();
      expect(key2.toString('hex')).toBe(key1.toString('hex'));
    } finally {
      if (originalEnvKey === undefined) delete process.env.JARVIS_ENCRYPTION_KEY;
      else process.env.JARVIS_ENCRYPTION_KEY = originalEnvKey;
      if (originalConfigDir === undefined) delete process.env.JARVIS_CONFIG_DIR;
      else process.env.JARVIS_CONFIG_DIR = originalConfigDir;
      if (originalComputerName === undefined) delete process.env.COMPUTERNAME;
      else process.env.COMPUTERNAME = originalComputerName;
    }
  });

  it('should use mocked safeStorage when available and persist the key', () => {
    const originalEnvKey = process.env.JARVIS_ENCRYPTION_KEY;
    const originalConfigDir = process.env.JARVIS_CONFIG_DIR;
    delete process.env.JARVIS_ENCRYPTION_KEY;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-encryption-'));
    process.env.JARVIS_CONFIG_DIR = configDir;
    try {
      const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
        decryptString: (value: Buffer) => value.toString('utf8').replace(/^enc:/, ''),
      };
      const key1 = withMockedElectron({ safeStorage }, () => getEncryptionKey());
      const key2 = withMockedElectron({ safeStorage }, () => getEncryptionKey());
      expect(key1.length).toBe(32);
      expect(key2.toString('hex')).toBe(key1.toString('hex'));
      expect(fs.existsSync(path.join(configDir, 'keystore.bin'))).toBe(true);
    } finally {
      if (originalEnvKey === undefined) delete process.env.JARVIS_ENCRYPTION_KEY;
      else process.env.JARVIS_ENCRYPTION_KEY = originalEnvKey;
      if (originalConfigDir === undefined) delete process.env.JARVIS_CONFIG_DIR;
      else process.env.JARVIS_CONFIG_DIR = originalConfigDir;
    }
  });

  it('should fall back when mocked safeStorage reports unavailable encryption', () => {
    const originalEnvKey = process.env.JARVIS_ENCRYPTION_KEY;
    const originalConfigDir = process.env.JARVIS_CONFIG_DIR;
    const originalComputerName = process.env.COMPUTERNAME;
    delete process.env.JARVIS_ENCRYPTION_KEY;
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-encryption-fallback-'));
    process.env.JARVIS_CONFIG_DIR = configDir;
    process.env.COMPUTERNAME = 'FALLBACK-PC';
    try {
      const key1 = withMockedElectron({
        safeStorage: { isEncryptionAvailable: () => false },
      }, () => getEncryptionKey());
      const key2 = withMockedElectron({
        safeStorage: { isEncryptionAvailable: () => false },
      }, () => getEncryptionKey());
      expect(key1.length).toBe(32);
      expect(key2.toString('hex')).toBe(key1.toString('hex'));
      expect(fs.existsSync(path.join(configDir, 'keystore.fallback.bin'))).toBe(true);
    } finally {
      if (originalEnvKey === undefined) delete process.env.JARVIS_ENCRYPTION_KEY;
      else process.env.JARVIS_ENCRYPTION_KEY = originalEnvKey;
      if (originalConfigDir === undefined) delete process.env.JARVIS_CONFIG_DIR;
      else process.env.JARVIS_CONFIG_DIR = originalConfigDir;
      if (originalComputerName === undefined) delete process.env.COMPUTERNAME;
      else process.env.COMPUTERNAME = originalComputerName;
    }
  });
});
