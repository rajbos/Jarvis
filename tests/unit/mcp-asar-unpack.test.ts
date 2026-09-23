import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// MCP clients run the packaged server as a plain Node script from app.asar.unpacked,
// where it cannot resolve anything left inside app.asar. Every package the server
// loads at runtime therefore has to be listed under asarUnpack in electron-builder.yml.

const ROOT = path.resolve(__dirname, '..', '..');

/** The bare-module imports of src/mcp-server, loaded the same way the built server does. */
const SERVER_ENTRY_MODULES = [
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  'zod',
  'sql.js',
];

function loadedPackages(): string[] {
  // A fresh Node process gives a clean require cache, unaffected by Vitest's own loader.
  const script = `
    for (const m of ${JSON.stringify(SERVER_ENTRY_MODULES)}) require(m);
    const pkgs = new Set();
    for (const file of Object.keys(require.cache)) {
      const parts = file.split(/[\\\\/]node_modules[\\\\/]/);
      if (parts.length < 2) continue;
      const segs = parts[parts.length - 1].split(/[\\\\/]/);
      pkgs.add(segs[0].startsWith('@') ? segs[0] + '/' + segs[1] : segs[0]);
    }
    process.stdout.write(JSON.stringify([...pkgs].sort()));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' }));
}

function asarUnpackPatterns(): string[] {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const block = yml.split(/^asarUnpack:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  return [...block.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1]);
}

describe('packaged MCP server dependencies', () => {
  it('unpacks every node module the server loads at runtime', () => {
    const patterns = asarUnpackPatterns();
    const isUnpacked = (pkg: string) =>
      patterns.some((p) => p === `node_modules/${pkg}/**` || p === `node_modules/${pkg.split('/')[0]}/**`);

    const packages = loadedPackages();
    expect(packages).toContain('@modelcontextprotocol/sdk');
    expect(packages.filter((pkg) => !isUnpacked(pkg))).toEqual([]);
  });
});
