/**
 * Unit tests for services/url-shortcut.ts
 *
 * readUrlShortcut parses Windows .url Internet Shortcut files (INI format)
 * and returns the target URL with metadata about whether it is a OneNote
 * or SharePoint link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');

import fs from 'fs';
import { readUrlShortcut } from '../../src/services/url-shortcut';

const mockReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readUrlShortcut', () => {
  it('throws when the file contains no URL= entry', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nIconIndex=0\n');
    expect(() => readUrlShortcut('C:/test.url')).toThrow('No URL= entry found');
  });

  it('returns the URL for a plain HTTPS link', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=https://example.com\n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.url).toBe('https://example.com');
    expect(result.isOneNote).toBe(false);
    expect(result.isSharePoint).toBe(false);
  });

  it('detects a onenote: protocol URL as OneNote', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=onenote:https://d.docs.live.net/notebook\n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.isOneNote).toBe(true);
    expect(result.isSharePoint).toBe(false);
  });

  it('detects a skysyncredir URL as OneNote', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=https://contoso.sharepoint.com/sites/team/_layouts/15/skysyncredir.aspx\n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.isOneNote).toBe(true);
    expect(result.isSharePoint).toBe(true);
  });

  it('detects a URL containing "onenote" in the path as OneNote', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=https://contoso.sharepoint.com/personal/user/OneNote/Notebook\n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.isOneNote).toBe(true);
  });

  it('detects a URL with callerscenarioid=onenote query param as OneNote', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=https://contoso.sharepoint.com/sites/team?callerscenarioid=onenote\n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.isOneNote).toBe(true);
    expect(result.isSharePoint).toBe(true);
  });

  it('detects a sharepoint.com root domain as SharePoint', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=https://sharepoint.com/sites/mysite\n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.isSharePoint).toBe(true);
  });

  it('detects a *.sharepoint.com subdomain as SharePoint', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=https://contoso.sharepoint.com/sites/project\n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.isSharePoint).toBe(true);
    expect(result.isOneNote).toBe(false);
  });

  it('returns isSharePoint false for a malformed URL that cannot be parsed', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=not-a-valid-url\n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.url).toBe('not-a-valid-url');
    expect(result.isSharePoint).toBe(false);
  });

  it('is case-insensitive when detecting OneNote and SharePoint indicators', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=ONENOTE:https://example.com/\n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.isOneNote).toBe(true);
  });

  it('trims whitespace from the extracted URL', () => {
    mockReadFileSync.mockReturnValue('[InternetShortcut]\nURL=  https://example.com  \n');
    const result = readUrlShortcut('C:/test.url');
    expect(result.url).toBe('https://example.com');
  });
});
