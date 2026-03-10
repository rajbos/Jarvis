import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, deriveKey, generateKey } from '../../src/storage/encryption';

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
});
