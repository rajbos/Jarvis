/**
 * IPC push-channel completeness test.
 *
 * Verifies that every push channel emitted from the main process
 * (via webContents.send() or event.sender.send()) has a corresponding
 * ipcRenderer.on() listener in preload.ts.
 *
 * This catches regressions where someone adds a new push channel but
 * forgets to expose it in the preload script.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../../src');

/**
 * Extract all channel names from webContents.send() and event.sender.send() calls
 * in the main process source files.
 */
function extractEmittedChannels(): string[] {
  const channels = new Set<string>();
  
  // Read all TypeScript files in src/ (excluding tests and node_modules)
  const { globSync } = require('glob');
  const files = globSync('**/*.ts', { 
    cwd: root,
    ignore: ['**/tests/**', '**/node_modules/**'],
  });
  
  for (const file of files) {
    const content = readFileSync(resolve(root, file), 'utf8');
    
    // Match webContents.send('channel', ...) and event.sender.send('channel', ...)
    const sendPattern = /(webContents|event\.sender)\.send\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = sendPattern.exec(content)) !== null) {
      channels.add(match[2]);
    }
  }
  
  return Array.from(channels).sort();
}

/**
 * Extract all channel names from ipcRenderer.on() calls in preload.ts
 */
function extractPreloadListeners(): string[] {
  const preloadPath = resolve(root, 'main/preload.ts');
  const content = readFileSync(preloadPath, 'utf8');
  
  const channels = new Set<string>();
  
  // Match ipcRenderer.on('channel', ...)
  const onPattern = /ipcRenderer\.on\s*\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = onPattern.exec(content)) !== null) {
    channels.add(match[1]);
  }
  
  return Array.from(channels).sort();
}

describe('IPC push-channel completeness', () => {
  const emittedChannels = extractEmittedChannels();
  const preloadListeners = extractPreloadListeners();

  it('has at least one emitted channel and preload listener (sanity check)', () => {
    expect(emittedChannels.length).toBeGreaterThan(0);
    expect(preloadListeners.length).toBeGreaterThan(0);
  });

  it('every emitted push channel has a corresponding preload listener', () => {
    const missing = emittedChannels.filter(channel => !preloadListeners.includes(channel));
    expect(
      missing,
      `Emitted push channels missing from preload.ts: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });

  it('logs all emitted channels for debugging', () => {
    console.log('Emitted push channels:', emittedChannels);
    console.log('Preload listeners:', preloadListeners);
  });
});
