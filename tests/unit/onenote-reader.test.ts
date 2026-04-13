import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractStrings,
  readOneNoteSection,
  type OneNoteSection,
} from '../../src/services/onenote-reader';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Resolve the path to a test `.one` fixture shipped inside the Joplin
 *  onenote-converter package so we don't need to commit binary blobs. */
function fixtureFile(relativePath: string): string {
  return path.join(
    __dirname,
    '../../node_modules/@joplin/onenote-converter/test-data',
    relativePath,
  );
}

// ── extractStrings() ──────────────────────────────────────────────────────────

describe('extractStrings()', () => {
  it('returns an empty array for an empty buffer', () => {
    const result = extractStrings(Buffer.alloc(0));
    expect(result).toEqual([]);
  });

  it('extracts ASCII runs of printable characters', () => {
    // Build a buffer: some binary noise then "Hello World" then more noise
    const text = 'Hello World';
    const buf = Buffer.from([0x00, 0x01, ...Buffer.from(text, 'ascii'), 0x00]);
    const result = extractStrings(buf);
    const texts = result.map(s => s.text);
    expect(texts).toContain('Hello World');
  });

  it('extracts UTF-16BE printable strings', () => {
    // Encode "Test" as UTF-16BE bytes: 00 54 00 65 00 73 00 74
    const utf16Bytes = Buffer.from([0x00, 0x54, 0x00, 0x65, 0x00, 0x73, 0x00, 0x74]);
    const buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), utf16Bytes]);
    const result = extractStrings(buf);
    const texts = result.map(s => s.text);
    expect(texts).toContain('Test');
  });

  it('deduplicates identical strings', () => {
    const text = 'Repeated';
    const chunk = Buffer.from(text, 'ascii');
    const buf = Buffer.concat([chunk, Buffer.from([0x00, 0x00]), chunk]);
    const result = extractStrings(buf);
    const count = result.filter(s => s.text === 'Repeated').length;
    expect(count).toBe(1);
  });

  it('returns results sorted by file offset', () => {
    const buf = Buffer.from('AAABBB', 'ascii');
    const result = extractStrings(buf);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].offset).toBeGreaterThanOrEqual(result[i - 1].offset);
    }
  });
});

// ── readOneNoteSection() with real fixture files ──────────────────────────────

describe('readOneNoteSection() — single-page fixture', () => {
  const fixturePath = fixtureFile('single-page/Untitled Section.one');

  it('fixture file exists', () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
  });

  it('returns a OneNoteSection with the correct sectionName', () => {
    const section = readOneNoteSection(fixturePath);
    expect(section.sectionName).toBe('Untitled Section');
  });

  it('reports filePath matching the input', () => {
    const section = readOneNoteSection(fixturePath);
    expect(section.filePath).toBe(fixturePath);
  });

  it('detects at least one page', () => {
    const section = readOneNoteSection(fixturePath);
    expect(section.pageCount).toBeGreaterThanOrEqual(1);
    expect(section.pages.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts the word "test" from the note body', () => {
    const section = readOneNoteSection(fixturePath);
    const combined = section.textContent.toLowerCase();
    expect(combined).toContain('test');
  });

  it('textContent is non-empty', () => {
    const section = readOneNoteSection(fixturePath);
    expect(section.textContent.trim().length).toBeGreaterThan(0);
  });

  it('each page has a pageIndex >= 1', () => {
    const section = readOneNoteSection(fixturePath);
    for (const page of section.pages) {
      expect(page.pageIndex).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('readOneNoteSection() — onenote-2016 fixture', () => {
  const fixturePath = fixtureFile('onenote-2016/OneWithFileData.one');

  it('fixture file exists', () => {
    expect(fs.existsSync(fixturePath)).toBe(true);
  });

  it('returns a OneNoteSection with string sectionName', () => {
    const section = readOneNoteSection(fixturePath);
    expect(typeof section.sectionName).toBe('string');
    expect(section.sectionName.length).toBeGreaterThan(0);
  });

  it('detects at least one page', () => {
    const section = readOneNoteSection(fixturePath);
    expect(section.pageCount).toBeGreaterThanOrEqual(1);
  });

  it('textContent contains the attached filename', () => {
    // The test file has a "testing.docx" attachment reference
    const section = readOneNoteSection(fixturePath);
    expect(section.textContent).toContain('testing.docx');
  });
});

// ── readOneNoteSection() — edge cases ─────────────────────────────────────────

describe('readOneNoteSection() — edge cases', () => {
  it('throws if the file does not exist', () => {
    expect(() => readOneNoteSection('/nonexistent/path/file.one')).toThrow();
  });

  it('handles an empty file gracefully (returns one page with empty content)', () => {
    const tmp = path.join(os.tmpdir(), 'jarvis-test-empty.one');
    fs.writeFileSync(tmp, Buffer.alloc(0));
    try {
      const section = readOneNoteSection(tmp);
      expect(section.pageCount).toBeGreaterThanOrEqual(1);
      expect(typeof section.textContent).toBe('string');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('handles a file containing only ASCII text (no page sentinels)', () => {
    const tmp = path.join(os.tmpdir(), 'jarvis-test-ascii.one');
    fs.writeFileSync(tmp, Buffer.from('Hello from a note with no structure'));
    try {
      const section = readOneNoteSection(tmp);
      expect(section.textContent).toContain('Hello from a note with no structure');
      expect(section.pageCount).toBe(1);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
