import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

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
 * Loads or creates the encryption key using Electron's safeStorage API.
 * safeStorage encrypts the key material with OS-level credential protection
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
 *
 * On first call (no keystore.bin): generates a random 32-byte key, encrypts it
 * with safeStorage, and persists the encrypted blob to keystore.bin.
 *
 * On subsequent calls: reads keystore.bin, decrypts with safeStorage, and
 * returns the key. If the file is unreadable or corrupted, generates a new key.
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
      // Key length mismatch — fall through to regenerate
    } catch {
      // Corrupted or stale file — fall through to regenerate
      console.warn('[Encryption] Failed to decrypt keystore.bin — regenerating key');
    }
  }

  // Generate and persist a new key
  const key = crypto.randomBytes(32);
  try {
    const encrypted = safeStorage.encryptString(key.toString('hex'));
    const dir = path.dirname(keyFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, encrypted, { mode: 0o600 });
    console.log('[Encryption] New key generated and persisted to keystore.bin');
  } catch (err) {
    console.error('[Encryption] Failed to persist keystore.bin:', err);
    // Return the in-memory key anyway — it will be regenerated next session
  }
  return key;
}

/**
 * Gets the encryption key used to protect sensitive data at rest.
 *
 * Priority:
 * 1. JARVIS_ENCRYPTION_KEY env var — used in tests and CI to provide a
 *    deterministic key without touching the OS credential store.
 * 2. Electron safeStorage — generates/loads a random key protected by the OS
 *    credential store (DPAPI on Windows). Requires the Electron main process.
 * 3. Machine-ID fallback — derives a key from COMPUTERNAME. Used when running
 *    outside Electron (should not occur in production).
 */
export function getEncryptionKey(): Buffer {
  const envKey = process.env.JARVIS_ENCRYPTION_KEY;
  if (envKey) {
    return deriveKey(envKey);
  }

  // Try Electron safeStorage (only available in the main process)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { safeStorage } = require('electron') as typeof import('electron');
    if (safeStorage.isEncryptionAvailable()) {
      return getOrCreateKeyWithSafeStorage(safeStorage);
    }
    console.warn(
      '[Encryption] Electron safeStorage is available but isEncryptionAvailable() ' +
      'returned false. Falling back to machine-id key derivation. ' +
      'Set JARVIS_ENCRYPTION_KEY to avoid this weaker fallback.',
    );
  } catch {
    // Not in an Electron context (e.g. unit tests running in plain Node.js)
  }

  // Fallback: derive from a machine-specific value
  const machineId = process.env.COMPUTERNAME || 'jarvis-default';
  return deriveKey(`jarvis-local-${machineId}`);
}