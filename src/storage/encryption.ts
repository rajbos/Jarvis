import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { logger } from '../services/logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

// The key is loaded once per key file, so a running instance keeps working
// even if another process rewrites the file underneath it.
let currentKeyCache: { file: string; key: Buffer } | null = null;
let retiredKeysCache: { dir: string; keys: Buffer[] } | null = null;

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string containing IV + ciphertext + auth tag.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // IV (16) + encrypted data + auth tag (16)
  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

/**
 * Decrypts a base64-encoded AES-256-GCM encrypted string.
 */
export function decrypt(encryptedBase64: string, key: Buffer): string {
  const data = Buffer.from(encryptedBase64, 'base64');
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/**
 * Derives a 256-bit encryption key from a passphrase or generates a random one.
 */
export function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, 'jarvis-salt', 32);
}

/**
 * Generates a random 256-bit key.
 */
export function generateKey(): Buffer {
  return crypto.randomBytes(32);
}

/**
 * Resolves the Jarvis config directory, mirroring the same fallback chain
 * as getDefaultDbPath() in storage/database.ts.
 */
function getConfigDirPath(): string {
  if (process.env.JARVIS_CONFIG_DIR) {
    return process.env.JARVIS_CONFIG_DIR;
  }
  const roamingDir =
    process.env.APPDATA ??
    (process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming')
      : '.');
  return path.join(roamingDir, 'Jarvis');
}

/**
 * Returns the path to the persisted key file in the Jarvis config directory.
 */
function getKeyFilePath(): string {
  return path.join(getConfigDirPath(), 'keystore.bin');
}

/**
 * Moves an unreadable key file aside as `<name>.<timestamp>.bak` instead of
 * overwriting it, so the secrets it protects can still be recovered once
 * whatever broke it (e.g. another instance with a different OS key) is gone.
 */
function archiveKeyFile(keyFile: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${keyFile}.${stamp}.bak`;
  try {
    fs.renameSync(keyFile, target);
    logger.warn(`[Encryption] Moved unreadable ${path.basename(keyFile)} to ${path.basename(target)}`);
  } catch (err) {
    logger.error(`[Encryption] Failed to archive ${path.basename(keyFile)}:`, err);
  }
  retiredKeysCache = null;
}

/**
 * Loads or creates the encryption key using Electron's safeStorage API.
 * safeStorage encrypts the key material with OS-level credential protection
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
 *
 * On first call (no keystore.bin): generates a random 32-byte key, encrypts it
 * with safeStorage, and persists the encrypted blob to keystore.bin.
 *
 * On subsequent calls: reads keystore.bin, decrypts with safeStorage, and
 * returns the key. If the file is unreadable or corrupted, it is archived (see
 * {@link archiveKeyFile}) and a new key is generated.
 */
function getOrCreateKeyWithSafeStorage(
  safeStorage: Electron.SafeStorage,
): Buffer {
  const keyFile = getKeyFilePath();

  if (fs.existsSync(keyFile)) {
    try {
      const encrypted = fs.readFileSync(keyFile);
      const hexKey = safeStorage.decryptString(encrypted);
      const key = Buffer.from(hexKey, 'hex');
      if (key.length === 32) return key;
      logger.warn('[Encryption] keystore.bin has unexpected length — regenerating key');
    } catch {
      logger.warn('[Encryption] Failed to decrypt keystore.bin — regenerating key');
    }
    archiveKeyFile(keyFile);
  }

  // Generate and persist a new key
  const key = crypto.randomBytes(32);
  try {
    const encrypted = safeStorage.encryptString(key.toString('hex'));
    const dir = path.dirname(keyFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, encrypted, { mode: 0o600 });
    logger.debug('[Encryption] New key generated and persisted to keystore.bin');
  } catch (err) {
    logger.error('[Encryption] Failed to persist keystore.bin:', err);
    // Return the in-memory key anyway — it will be regenerated next session
  }
  return key;
}

/** Returns the path to the fallback key file (persisted random key). */
function getFallbackKeyFilePath(): string {
  return path.join(getConfigDirPath(), 'keystore.fallback.bin');
}

/**
 * Generates or loads a persistent random key stored in keystore.fallback.bin.
 * This is strictly more secure than the previous COMPUTERNAME-derived key
 * because the key material is a CSPRNG-generated 32-byte value that requires
 * file-system access to read (file permissions 0o600).
 *
 * If the file doesn't exist, a new key is generated and persisted.
 * If the file is unreadable/corrupted, it is archived and a new key is
 * generated; secrets under the old key stay recoverable via {@link decryptSecret}.
 */
function getOrCreateFallbackKey(): Buffer {
  const keyFile = getFallbackKeyFilePath();

  if (fs.existsSync(keyFile)) {
    try {
      const data = fs.readFileSync(keyFile);
      if (data.length === 32) return data;
      logger.warn('[Encryption] keystore.fallback.bin has unexpected length — regenerating');
    } catch {
      logger.warn('[Encryption] Failed to read keystore.fallback.bin — regenerating');
    }
    archiveKeyFile(keyFile);
  }

  const key = crypto.randomBytes(32);
  try {
    const dir = path.dirname(keyFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    logger.debug('[Encryption] New fallback key generated and persisted to keystore.fallback.bin');
  } catch (err) {
    logger.error('[Encryption] Failed to persist keystore.fallback.bin:', err);
  }
  return key;
}

/** Electron's safeStorage when it can encrypt here, otherwise null. */
function loadSafeStorage(): Electron.SafeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as typeof import('electron');
    if (safeStorage.isEncryptionAvailable()) return safeStorage;
    logger.warn(
      '[Encryption] Electron safeStorage is available but isEncryptionAvailable() ' +
      'returned false. Falling back to file-based key store. ' +
      'Set JARVIS_ENCRYPTION_KEY to avoid this weaker fallback.',
    );
  } catch {
    // Not in an Electron context (e.g. unit tests running in plain Node.js)
  }
  return null;
}

/** Forget cached keys (tests switch JARVIS_CONFIG_DIR between cases). */
export function resetEncryptionKeyCache(): void {
  currentKeyCache = null;
  retiredKeysCache = null;
}

/**
 * Gets the encryption key used to protect sensitive data at rest.
 *
 * Priority:
 * 1. JARVIS_ENCRYPTION_KEY env var — used in tests and CI to provide a
 *    deterministic key without touching the OS credential store.
 * 2. Electron safeStorage — generates/loads a random key protected by the OS
 *    credential store (DPAPI on Windows, Keychain on macOS). Uses keystore.bin.
 * 3. File-based fallback — a CSPRNG 32-byte key persisted to keystore.fallback.bin
 *    with 0o600 permissions. Used outside Electron (e.g. dev, CI).
 */
export function getEncryptionKey(): Buffer {
  const envKey = process.env.JARVIS_ENCRYPTION_KEY;
  if (envKey) {
    return deriveKey(envKey);
  }

  const safeStorage = loadSafeStorage();
  const file = safeStorage ? getKeyFilePath() : getFallbackKeyFilePath();
  if (currentKeyCache?.file === file) return currentKeyCache.key;
  const key = safeStorage ? getOrCreateKeyWithSafeStorage(safeStorage) : getOrCreateFallbackKey();
  currentKeyCache = { file, key };
  return key;
}

/**
 * Keys from archived key files (see {@link archiveKeyFile}) that can still be
 * unlocked here, newest first.
 */
function getRetiredKeys(): Buffer[] {
  if (process.env.JARVIS_ENCRYPTION_KEY) return [];
  const dir = getConfigDirPath();
  if (retiredKeysCache?.dir === dir) return retiredKeysCache.keys;

  const keys: Buffer[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^keystore(\.fallback)?\.bin\..+\.bak$/.test(n)).sort().reverse();
  } catch {
    // No config dir yet — nothing archived
  }
  const safeStorage = names.some((n) => n.startsWith('keystore.bin.')) ? loadSafeStorage() : null;
  for (const name of names) {
    try {
      const data = fs.readFileSync(path.join(dir, name));
      const key = name.startsWith('keystore.fallback.bin.')
        ? data
        : safeStorage
          ? Buffer.from(safeStorage.decryptString(data), 'hex')
          : null;
      if (key?.length === 32) keys.push(key);
    } catch {
      // Protected by an OS key this process can't use — skip it
    }
  }
  retiredKeysCache = { dir, keys };
  return keys;
}

/**
 * Decrypts a secret with the current key, falling back to archived keys.
 * `stale` is true when an archived key was needed: the caller should store
 * `encrypt(value, getEncryptionKey())` so the secret moves to the current key.
 * Throws when no available key can decrypt it.
 */
export function decryptSecret(encryptedBase64: string): { value: string; stale: boolean } {
  try {
    return { value: decrypt(encryptedBase64, getEncryptionKey()), stale: false };
  } catch (err) {
    for (const key of getRetiredKeys()) {
      try {
        return { value: decrypt(encryptedBase64, key), stale: true };
      } catch {
        // Try the next archived key
      }
    }
    throw err;
  }
}
