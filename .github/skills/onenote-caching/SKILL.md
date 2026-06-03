---
name: onenote-caching
description: Cache live OneNote notebook pages from SharePoint via COM API with automatic fallback to local backup files. Use this when adding OneNote pages to groups, debugging cache misses, or handling large notebook hierarchies that exceed buffer limits.
argument-hint: "[optional: describe the issue (cache missing, truncated, stale, or need full hierarchy)]"
---

# OneNote Caching for Jarvis Groups

This skill documents how Jarvis discovers and caches OneNote notebook pages from the Windows OneNote COM API, with architectural lessons learned during implementation.

## Quick Start

To cache a group's OneNote pages:

1. Ensure OneNote is running with target notebook(s) open
2. In the Jarvis UI, navigate to a group with `.url` OneNote shortcuts
3. Click the **"📓 Cache"** button in GroupsPanel
4. Monitor the result:
   - ✅ `"Cached N page(s) from M file(s)"` — success
   - ⚠️ `"Skipped K file(s)"` with error details — check the error message

## Architecture Overview

### Two-Tier Caching Strategy

OneNote notebooks are **SharePoint-hosted** (cloud storage), not local. Jarvis accesses them via two methods:

#### Tier 1: Live COM API (Primary)
- Access method: PowerShell invokes `OneNote.Application` COM object
- Requires: OneNote running with target notebook open
- Data freshness: **Live** (current content)
- Constraints:
  - Single-Threaded Apartment (STA) mode required (`-Sta` flag)
  - Large hierarchies may exceed stdout buffer limits (see "Buffer Truncation Problem" below)
  - Timeout: 30 seconds (`NOTEBOOK_COM_TIMEOUT_MS` in `onenote-reader.ts`)

#### Tier 2: Local Backup Files (Fallback)
- Access method: Scan `%LOCALAPPDATA%\Microsoft\OneNote\16.0\Backup\`
- Requires: OneNote to have synced at least once locally
- Data freshness: **Stale** (typically days or weeks old)
- Advantage: Works even if OneNote is closed or notebook is offline

### File Detection

Groups store OneNote shortcuts as `.url` files in their OneDrive folders. The caching system:
1. Queries the group's folder structure via `getOneNoteUrlFilesForGroup()`
2. For each `.url` shortcut: extracts the notebook name (filename stem)
3. Attempts COM read; on failure, falls back to backup search
4. Stores cached pages in `onedrive_onenote_cache` table with:
   - `group_id`, `section_name`, `page_index`, `page_level`
   - `title`, `date`, `last_modified`, `content`

## When to Use This Skill

| Situation | Check | Fix |
|-----------|-------|-----|
| "No pages cached yet" — need OneNote in cache | Is OneNote running? Is notebook open? | Check OneNote window; click "📓 Cache" again |
| Cache shows "Skipped K file(s)" with errors | What's the error message? | See "Troubleshooting" section below |
| Cache shows stale dates (weeks old) | Is COM reader failing silently? | Check if OneNote is actually open; view fallback logic |
| Large notebook hangs or truncates | How many pages? Any JSON parse errors? | See "Buffer Truncation Problem" below |
| Want to add OneNote to a new group | Do `.url` shortcuts already exist? | Manually create `.url` shortcuts pointing to OneNote; or add via OneNote's Share feature |

## Key Implementation Details

### Buffer Truncation Problem (Solved)

**Problem**: PowerShell COM script successfully queries live notebook content, but Node.js `spawn()` truncates stdout mid-JSON when dealing with large hierarchies (9+ pages with ~1000 bytes each).

**Cause**: Default Node.js stdout buffer is ~200KB; large JSON output exceeds this limit.

**Solution**: Write PowerShell output to a **temp file** instead of accumulating stdout.

```
User's OneNote (Royal London Notes)
    ↓ (lives on SharePoint)
    └── COM Query via PowerShell
        ├── Tier 1: Write JSON to temp file (✅ no buffer limit)
        └── Tier 2: Read file in Node.js
                    ↓
                    Parse JSON
                    ↓
                    Cache to DB
```

**Code locations**:
- PowerShell writes to file: `scripts/read-onenote-notebook.ps1` lines 127–136 (handles `-OutputPath` parameter)
- Node reads from file: `src/services/onenote-reader.ts` `readOneNoteNotebookByCom()` function (lines 467–555)

### Power Shell Script Interface

**File**: `scripts/read-onenote-notebook.ps1`

**Parameters**:
- `-NotebookName` (required): Display name of notebook (case-insensitive match)
- `-OutputPath` (optional): Path to write JSON output (if provided, writes to file; else stdout)

**Return Format**:
```json
{
  "ok": true,
  "notebookName": "Royal London Notes",
  "sections": [
    {
      "sectionName": "Meetings",
      "pages": [
        {
          "pageIndex": 1,
          "pageLevel": 1,
          "title": "20250923 Rob & Max",
          "date": "2025-09-23T10:00:00Z",
          "lastModified": "2025-09-23T12:30:00Z",
          "content": "Discussed GitHub migration plans..."
        }
      ]
    }
  ]
}
```

Or on error:
```json
{
  "ok": false,
  "error": "OneNote.Application COM object failed: [reason]"
}
```

### Local Backup File Structure

OneNote backup files are stored at:
```
%LOCALAPPDATA%\Microsoft\OneNote\16.0\Backup\
└── {NotebookName} notes\
    ├── {SectionName} (On DD-MM-YYYY).one
    ├── {SectionName} (On DD-MM-YYYY).one  [earlier backup]
    └── {OtherSection} (On DD-MM-YYYY).one
```

The caching system:
1. Searches by notebook name (case-insensitive glob)
2. For each section, selects the **most recent** `.one` file
3. Uses binary parsing (no OneNote installation required) to extract page content
4. Falls back to this tier only when COM read fails

**Backup Gotcha**: If a user deletes a local section from OneNote but the backup still exists, the cache will restore the old section. This is **expected** — backups are point-in-time snapshots.

## Database Schema

Table: `onedrive_onenote_cache`

| Column | Type | Purpose |
|--------|------|---------|
| `group_id` | text | Foreign key to `groups.id` |
| `section_name` | text | OneNote section name |
| `page_index` | integer | Page order within section (1-based) |
| `page_level` | integer | Hierarchy level (1=top, 2=sub-page, etc.) |
| `title` | text | Page title |
| `date` | text | Page creation date (ISO 8601) |
| `page_last_modified` | text | Page last modified date (ISO 8601) |
| `content` | text | Concatenated text content (RAG-friendly) |

**Index**: `(group_id, section_name, page_index)` — enables fast lookup per group/section.

## Troubleshooting

### Error: "COM failed: Notebook COM reader produced non-JSON"

**Cause**: PowerShell script ran but returned unparseable output.

**Check**:
1. Is OneNote running? COM API requires live OneNote process.
2. Is the notebook actually open in OneNote? COM only reads open notebooks.
3. Does the notebook name match? Check the `.url` filename stem.

**Fix**: Close OneNote and reopen the notebook; try caching again.

### Error: "OneNote.Application COM object failed: [reason]"

**Cause**: COM object creation or hierarchy read failed.

**Check**:
1. Is OneNote licensed and functional? Try opening a notebook manually.
2. Are you on Windows? COM API is Windows-only.

**Fix**: Restart OneNote; manually verify notebook access; try caching again.

### Error: "Failed to read OneNote output file"

**Cause**: Temp file was created but couldn't be read afterward.

**Check**:
1. Is `%TEMP%` accessible and has free space?
2. Did PowerShell script crash silently?

**Fix**: Check disk space; restart app; try caching again.

### Cache shows stale dates (weeks old)

**Cause**: COM tier failed silently; fallback to backup tier used instead.

**Check**: Are all pages old? Then COM read likely failed.

**Fix**:
1. Verify OneNote is running and notebook is open.
2. In Jarvis UI, hover over error details to see which tier failed.
3. Try caching again.

### Cache skipped all files with "no matching sections found"

**Cause**: Backup folder exists but doesn't contain any `.one` files for this notebook.

**Check**: Does `%LOCALAPPDATA%\Microsoft\OneNote\16.0\Backup\{NotebookName}*` folder exist?

**Fix**: 
1. Open OneNote and ensure at least one section exists.
2. Wait for OneNote to sync.
3. Close and reopen OneNote (forces backup creation).
4. Try caching again.

## Code Locations (Quick Reference)

| Module | Purpose | Key Function |
|--------|---------|--------------|
| `scripts/read-onenote-notebook.ps1` | COM API entry point | Main script; reads all sections & pages |
| `src/services/onenote-reader.ts` | Orchestration layer | `readOneNoteNotebookByCom()`, `readOneNoteSectionAsync()` |
| `src/services/onedrive-onenote-cache.ts` | Cache logic | `cacheOneNoteFilesForGroup()`, `findBackupSectionsForNotebook()` |
| `src/plugins/groups/handler.ts` | IPC handler | `ipcMain.handle('onedrive:cache-onenote-files-for-group', ...)` |
| `src/plugins/groups/GroupsPanel.tsx` | UI button & display | "📓 Cache" button; result message |
| `src/storage/schema.ts` | Database schema | Table definition v25 migration |

## Lessons Learned (For Future Features)

### 1. **Large Output from Long-Running Scripts**
When a script produces large JSON output (>1 MB), don't rely on stdout accumulation. Use **temp files** instead. This applies to any Node.js `spawn()` call that may exceed buffer limits.

### 2. **Cloud Notebooks Require Live APIs**
Local backup files are always stale. If real-time data is needed, use COM (or equivalent cloud API). Backups are only useful as fallbacks.

### 3. **COM API Requires Running Process**
You can't query OneNote data if OneNote isn't running. This is a hard constraint on Windows; no workaround exists.

### 4. **Single-Threaded Apartment (STA) Mode is Essential**
PowerShell COM scripts must use `-Sta` flag. Without it, COM object creation fails silently or hangs.

### 5. **Temp File Cleanup**
Always wrap `fs.unlinkSync()` in try/catch when cleaning up temp files. The file may already be deleted by Windows or antivirus; don't let that crash the app.

## Future Enhancements

- **Real-time sync**: Watch for OneNote changes and auto-refresh cache on interval
- **Full notebook tree**: Display section hierarchy (parent/child) in cache metadata
- **OCR content**: Extract text from image-based notes (requires Vision API)
- **Search index**: Build FTS index on cached content for fast search
- **Conflict detection**: Warn if local notebook differs from cloud version

---

**Last Updated**: 2026-05-26  
**Status**: Fully Implemented  
**Tested**: OneNote notebooks with 9+ pages, backup fallback validated
