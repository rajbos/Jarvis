// ── OneNote section file reader ───────────────────────────────────────────────
// Extracts text content from `.one` (MS-ONESTORE) binary files without
// requiring OneNote to be installed or a native parser.
//
// Strategy:
//   1. Extract UTF-16BE readable strings  — covers metadata (page titles,
//      dates, font names) and content in newer OneNote format files.
//   2. Extract ASCII readable strings     — covers content in older format
//      files (pre-~2022) where body text is stored as single-byte characters.
//   3. Use the sentinel string "PageTitle" (always UTF-16BE) to count pages
//      and assign a rough per-page boundary.
//   4. Strip well-known noise tokens (font names, XML fragments, property
//      keys, GUIDs) before returning.
//
// Output is suitable for downstream RAG chunking — no layout is preserved.

import fs from 'fs';
import path from 'path';

// ── Public types ──────────────────────────────────────────────────────────────

export interface OneNotePage {
  /** Index of this page within the section (1-based). */
  pageIndex: number;
  /** Best-effort page title extracted from the binary. May be empty. */
  title: string;
  /** Best-effort page date string, e.g. "Thursday, September 25, 2025". */
  date: string;
  /** All body text found in this page's region of the file, joined with spaces. */
  content: string;
}

export interface OneNoteSection {
  /** Human-readable name derived from the filename (without extension). */
  sectionName: string;
  /** Absolute path of the source file. */
  filePath: string;
  /** Number of pages detected via "PageTitle" sentinels. */
  pageCount: number;
  /** Pages with individual titles and content. */
  pages: OneNotePage[];
  /** Full concatenated text (all pages) — convenient for whole-section RAG. */
  textContent: string;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface ExtractedString {
  offset: number;
  encoding: 'utf16be' | 'ascii';
  text: string;
}

// ── Noise filter ──────────────────────────────────────────────────────────────

// Strings that appear in the binary as structural metadata, not user content.
const NOISE_TOKENS = new Set([
  'PageTitle',
  'PageDateTime',
  'Calibri',
  'Calibri Light',
  'Arial',
  'Times New Roman',
  'Courier New',
  'Consolas',
  'Microsoft YaHei',
  'Verdana',
  'Wingdings',
  'Symbol',
  'Segoe UI',
  'blockquote',
  'cite',
  'code',
  'table',
  'th',
  'td',
  'tr',
]);

function isNoise(s: string): boolean {
  if (NOISE_TOKENS.has(s)) return true;
  // GUID-like strings
  if (/^\{[0-9a-fA-F-]{30,}\}$/.test(s)) return true;
  // XML/HTML fragments
  if (s.startsWith('<') || s.startsWith('resolutionId')) return true;
  // Pure whitespace or very short tokens
  if (s.trim().length < 3) return true;
  // Binary noise: strings with too many special characters
  const printable = s.replace(/[^\x20-\x7E\u00A0-\u02FF]/g, '');
  if (printable.length < s.length * 0.6) return true;
  return false;
}

// ── String extraction ─────────────────────────────────────────────────────────

const MIN_UTF16BE_LEN = 3;
const MIN_ASCII_LEN = 5;

/**
 * Extract all readable string runs from a binary buffer using two strategies:
 * UTF-16BE (high byte first) and ASCII (single byte).
 * Results are sorted by file offset.
 */
export function extractStrings(buf: Buffer): ExtractedString[] {
  const results: ExtractedString[] = [];

  // ── UTF-16BE pass ─────────────────────────────────────────────────────────
  // A UTF-16BE "printable" codepoint has the high byte as 0x00 (ASCII range)
  // or 0x00-0x02 (Latin Extended).
  for (let i = 0; i < buf.length - 1; i++) {
    const chars: string[] = [];
    let j = i;
    while (j < buf.length - 1) {
      const hi = buf[j];
      const lo = buf[j + 1];
      const cp = (hi << 8) | lo;
      // Accept printable ASCII and Latin-Extended codepoints
      if ((cp >= 0x0020 && cp < 0x007F) || (cp >= 0x00A0 && cp <= 0x02FF)) {
        chars.push(String.fromCodePoint(cp));
        j += 2;
      } else {
        break;
      }
    }
    if (chars.length >= MIN_UTF16BE_LEN) {
      const text = chars.join('').trim();
      if (text.length >= MIN_UTF16BE_LEN) {
        results.push({ offset: i, encoding: 'utf16be', text });
        i = j - 1; // advance past this run
      }
    }
  }

  // ── ASCII pass ────────────────────────────────────────────────────────────
  let current = '';
  let startOffset = 0;
  for (let i = 0; i <= buf.length; i++) {
    const b = buf[i];
    if (b !== undefined && b >= 0x20 && b < 0x7F) {
      if (current.length === 0) startOffset = i;
      current += String.fromCharCode(b);
    } else {
      if (current.length >= MIN_ASCII_LEN) {
        results.push({ offset: startOffset, encoding: 'ascii', text: current.trim() });
      }
      current = '';
    }
  }

  // Sort by file offset, then deduplicate by text
  results.sort((a, b) => a.offset - b.offset);
  const seen = new Set<string>();
  return results.filter(s => {
    if (seen.has(s.text)) return false;
    seen.add(s.text);
    return true;
  });
}

// ── Page segmentation ─────────────────────────────────────────────────────────

/**
 * Build a OneNotePage from the strings found between two byte offsets.
 * The first non-noise string after the PageTitle sentinel is used as the
 * page title; the first date-like string is used as the date; everything
 * else becomes body content.
 */
function buildPage(
  pageIndex: number,
  strings: ExtractedString[],
  startOffset: number,
  endOffset: number,
): OneNotePage {
  const pageStrings = strings
    .filter(s => s.offset >= startOffset && s.offset < endOffset && !isNoise(s.text));

  // The "PageDateTime" sentinel is a UTF-16BE anchor. The first non-noise
  // string shortly after it is the date value.
  const pageDateTimeIdx = strings.findIndex(
    s => s.offset >= startOffset && s.offset < endOffset && s.text === 'PageDateTime',
  );

  let title = '';
  let date = '';
  const contentParts: string[] = [];

  // Find a plausible title: first meaningful non-noise string before or after
  // "PageDateTime" that looks like a sentence (has spaces or is long enough).
  // Find a date string: something matching a date-like pattern.
  const DATE_PATTERN = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}:\d{2})\b/i;
  const LONG_DATE_PATTERN = /\b(january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b/i;

  for (const s of pageStrings) {
    const isDateLike = DATE_PATTERN.test(s.text) || LONG_DATE_PATTERN.test(s.text);
    if (isDateLike && !date) {
      date = s.text;
      continue;
    }
    // The first longish non-date string is the title candidate
    if (!title && s.text.length >= 4 && s.offset < startOffset + 2000) {
      title = s.text;
      continue;
    }
    contentParts.push(s.text);
  }

  // Suppress the page-datetime sentinel index (already used for date)
  void pageDateTimeIdx;

  return {
    pageIndex,
    title,
    date,
    content: contentParts.join(' '),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read a OneNote section file (`.one`) and extract all text content.
 * Returns a structured `OneNoteSection` with per-page text and a
 * combined `textContent` field for whole-section RAG indexing.
 *
 * @throws if the file cannot be read.
 */
export function readOneNoteSection(filePath: string): OneNoteSection {
  const buf = fs.readFileSync(filePath);
  const sectionName = path.basename(filePath, '.one');

  const allStrings = extractStrings(buf);

  // Locate "PageTitle" sentinels — each marks one page in the section
  const pageSentinels = allStrings
    .filter(s => s.text === 'PageTitle')
    .map(s => s.offset);

  let pages: OneNotePage[];

  if (pageSentinels.length === 0) {
    // No page structure detected — treat the whole file as one page
    const contentStrings = allStrings.filter(s => !isNoise(s.text));
    const content = contentStrings.map(s => s.text).join(' ');
    pages = [{ pageIndex: 1, title: sectionName, date: '', content }];
  } else {
    pages = pageSentinels.map((sentinelOffset, i) => {
      const nextSentinelOffset = pageSentinels[i + 1] ?? buf.length;
      return buildPage(i + 1, allStrings, sentinelOffset, nextSentinelOffset);
    });

    // Also capture any content that appears BEFORE the first PageTitle sentinel
    // (older format files store body text before metadata).
    const prePageStrings = allStrings
      .filter(s => s.offset < pageSentinels[0] && !isNoise(s.text));
    if (prePageStrings.length > 0) {
      const preContent = prePageStrings.map(s => s.text).join(' ');
      // Append pre-content to the first page
      const first = pages[0];
      pages[0] = {
        ...first,
        content: preContent + (first.content ? ' ' + first.content : ''),
      };
    }
  }

  const textContent = pages
    .map(p => [p.title, p.date, p.content].filter(Boolean).join(' '))
    .join('\n\n');

  return {
    sectionName,
    filePath,
    pageCount: pages.length,
    pages,
    textContent,
  };
}
