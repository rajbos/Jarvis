/**
 * Parity test: every key exposed in preload.ts must have a matching entry
 * in the JarvisApi interface (src/plugins/types.ts).
 *
 * This is enforced by parsing the source files at test time with a simple
 * regex, so it works without importing Electron or any browser APIs.
 *
 * Add new methods to both files — this test will catch gaps immediately.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../../src');

function extractPreloadKeys(src: string): string[] {
  // Match the contextBridge.exposeInMainWorld object literal keys
  const objectBody = src.match(/contextBridge\.exposeInMainWorld\('jarvis',\s*\{([\s\S]*)\}\s*\);/)?.[1] ?? '';
  const keys: string[] = [];
  for (const m of objectBody.matchAll(/^\s{2}(\w+)\s*:/gm)) {
    keys.push(m[1]);
  }
  return keys;
}

function extractJarvisApiKeys(src: string): string[] {
  const interfaceBody = src.match(/export interface JarvisApi \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const keys: string[] = [];
  for (const m of interfaceBody.matchAll(/^\s+(\w+)\s*[(:]/gm)) {
    keys.push(m[1]);
  }
  return keys;
}

describe('preload ↔ JarvisApi parity', () => {
  const preloadSrc = readFileSync(resolve(root, 'main/preload.ts'), 'utf8');
  const typesSrc = readFileSync(resolve(root, 'plugins/types.ts'), 'utf8');

  const preloadKeys = extractPreloadKeys(preloadSrc);
  const apiKeys = extractJarvisApiKeys(typesSrc);

  it('has at least one key in preload and JarvisApi (sanity check)', () => {
    expect(preloadKeys.length).toBeGreaterThan(10);
    expect(apiKeys.length).toBeGreaterThan(10);
  });

  it('every preload key is declared in JarvisApi', () => {
    const missing = preloadKeys.filter(k => !apiKeys.includes(k));
    expect(
      missing,
      `Preload keys missing from JarvisApi: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });

  it('every JarvisApi key is exposed in preload', () => {
    const missing = apiKeys.filter(k => !preloadKeys.includes(k));
    expect(
      missing,
      `JarvisApi keys not exposed in preload: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });
});
