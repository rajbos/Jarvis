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
  // A generous timeout so a genuine hang fails fast with a clear error instead of running
  // until vitest's own test timeout kills the whole process ambiguously.
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 15_000 })
  );
}

function asarUnpackPatterns(): string[] {
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const block = yml.split(/^asarUnpack:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  return [...block.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1]);
}

describe('packaged MCP server dependencies', () => {
  // loadedPackages() shells out to a brand-new `node` process, which has to resolve and
  // require @modelcontextprotocol/sdk, zod and sql.js from node_modules cold. Warm re-runs
  // finish in ~0.6-0.9s, but the *first* time a fresh OS process touches those files (e.g.
  // right after `npm ci`, or when Windows Defender's real-time scanner has to inspect the
  // files on first read) that same require chain measured up to ~8.6s locally. Running the
  // full suite in parallel makes that first touch more likely to land on this test, so give
  // it real headroom above vitest's 5s default instead of racing the cold-start cost.
  it('unpacks every node module the server loads at runtime', () => {
    const patterns = asarUnpackPatterns();
    const isUnpacked = (pkg: string) =>
      patterns.some((p) => p === `node_modules/${pkg}/**` || p === `node_modules/${pkg.split('/')[0]}/**`);

    const packages = loadedPackages();
    expect(packages).toContain('@modelcontextprotocol/sdk');
    expect(packages.filter((pkg) => !isUnpacked(pkg))).toEqual([]);
  }, 20_000);
});
