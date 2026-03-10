import crypto from 'crypto';

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
 * Gets the encryption key from the environment variable or generates a default one.
 * In production, this should use Windows Credential Manager via keytar.
 */
export function getEncryptionKey(): Buffer {
  const envKey = process.env.JARVIS_ENCRYPTION_KEY;
  if (envKey) {
    return deriveKey(envKey);
  }
  // Fallback: derive from a machine-specific value
  // TODO: Replace with Windows Credential Manager (keytar) integration
  const machineId = process.env.COMPUTERNAME || 'jarvis-default';
  return deriveKey(`jarvis-local-${machineId}`);
}
