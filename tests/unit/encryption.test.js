"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const encryption_1 = require("../../src/storage/encryption");
(0, vitest_1.describe)('Encryption', () => {
    (0, vitest_1.it)('should encrypt and decrypt a string correctly', () => {
        const key = (0, encryption_1.generateKey)();
        const plaintext = 'ghp_test_token_12345';
        const encrypted = (0, encryption_1.encrypt)(plaintext, key);
        (0, vitest_1.expect)(encrypted).not.toBe(plaintext);
        const decrypted = (0, encryption_1.decrypt)(encrypted, key);
        (0, vitest_1.expect)(decrypted).toBe(plaintext);
    });
    (0, vitest_1.it)('should produce different ciphertexts for the same plaintext (random IV)', () => {
        const key = (0, encryption_1.generateKey)();
        const plaintext = 'same_input';
        const encrypted1 = (0, encryption_1.encrypt)(plaintext, key);
        const encrypted2 = (0, encryption_1.encrypt)(plaintext, key);
        (0, vitest_1.expect)(encrypted1).not.toBe(encrypted2);
        // Both should decrypt to the same value
        (0, vitest_1.expect)((0, encryption_1.decrypt)(encrypted1, key)).toBe(plaintext);
        (0, vitest_1.expect)((0, encryption_1.decrypt)(encrypted2, key)).toBe(plaintext);
    });
    (0, vitest_1.it)('should fail to decrypt with wrong key', () => {
        const key1 = (0, encryption_1.generateKey)();
        const key2 = (0, encryption_1.generateKey)();
        const plaintext = 'secret_data';
        const encrypted = (0, encryption_1.encrypt)(plaintext, key1);
        (0, vitest_1.expect)(() => (0, encryption_1.decrypt)(encrypted, key2)).toThrow();
    });
    (0, vitest_1.it)('should derive consistent keys from the same passphrase', () => {
        const key1 = (0, encryption_1.deriveKey)('my-secret');
        const key2 = (0, encryption_1.deriveKey)('my-secret');
        (0, vitest_1.expect)(key1.toString('hex')).toBe(key2.toString('hex'));
    });
    (0, vitest_1.it)('should derive different keys from different passphrases', () => {
        const key1 = (0, encryption_1.deriveKey)('passphrase-a');
        const key2 = (0, encryption_1.deriveKey)('passphrase-b');
        (0, vitest_1.expect)(key1.toString('hex')).not.toBe(key2.toString('hex'));
    });
    (0, vitest_1.it)('should generate a 32-byte key', () => {
        const key = (0, encryption_1.generateKey)();
        (0, vitest_1.expect)(key.length).toBe(32);
    });
});
//# sourceMappingURL=encryption.test.js.map