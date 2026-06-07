import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    tmpdir: () => path.join(process.cwd(), '.test-artifacts'),
  };
});

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => {
    this.emit('close');
    return true;
  });
}

describe('OneNote COM readers', () => {
  const artifactsDir = path.join(process.cwd(), '.test-artifacts');

  beforeEach(() => {
    fs.mkdirSync(artifactsDir, { recursive: true });
    spawnMock.mockReset();
  });

  afterEach(() => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('readOneNoteSectionViaCom returns parsed pages and defaults missing pageLevel to 1', async () => {
    const proc = new FakeChildProcess();
    spawnMock.mockReturnValue(proc);
    const { readOneNoteSectionViaCom } = await import('../../src/services/onenote-reader');

    const promise = readOneNoteSectionViaCom('C:\\notes\\Section.one', 'C:\\scripts\\read-onenote-section.ps1');
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      ok: true,
      pages: [
        { pageIndex: 1, title: 'Title', date: '2024-01-01', lastModified: '2024-01-02T00:00:00.000Z', content: 'Body' },
      ],
    })));
    proc.emit('close', 0);

    await expect(promise).resolves.toEqual({
      sectionName: 'Section',
      filePath: 'C:\\notes\\Section.one',
      pageCount: 1,
      pages: [
        {
          pageIndex: 1,
          pageLevel: 1,
          title: 'Title',
          date: '2024-01-01',
          lastModified: '2024-01-02T00:00:00.000Z',
          content: 'Body',
        },
      ],
      textContent: 'Title 2024-01-01 Body',
    });
    expect(spawnMock).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-FilePath', 'C:\\notes\\Section.one']), { windowsHide: true });
  });

  it('readOneNoteSectionViaCom rejects with stderr details when stdout is not JSON', async () => {
    const proc = new FakeChildProcess();
    spawnMock.mockReturnValue(proc);
    const { readOneNoteSectionViaCom } = await import('../../src/services/onenote-reader');

    const promise = readOneNoteSectionViaCom('C:\\notes\\Broken.one', 'C:\\scripts\\read-onenote-section.ps1');
    proc.stdout.emit('data', Buffer.from('not-json'));
    proc.stderr.emit('data', Buffer.from('powershell failure'));
    proc.emit('close', 1);

    await expect(promise).rejects.toThrow('COM reader produced non-JSON output: not-json | stderr: powershell failure');
  });

  it('readOneNoteSectionAsync falls back to binary parsing when COM spawning fails', async () => {
    const proc = new FakeChildProcess();
    spawnMock.mockReturnValue(proc);
    const { readOneNoteSectionAsync } = await import('../../src/services/onenote-reader');
    const filePath = path.join(artifactsDir, 'Fallback.one');
    fs.writeFileSync(filePath, Buffer.from('Fallback binary content'));

    const promise = readOneNoteSectionAsync(filePath, 'C:\\scripts\\read-onenote-section.ps1');
    proc.emit('error', new Error('spawn failed'));

    await expect(promise).resolves.toMatchObject({
      filePath,
      pageCount: 1,
      source: 'binary',
    });
    await expect(promise).resolves.toMatchObject({
      textContent: expect.stringContaining('Fallback binary content'),
    });
  });

  it('readOneNoteNotebookByCom reads JSON from the output file and defaults missing pageLevel to 1', async () => {
    const proc = new FakeChildProcess();
    spawnMock.mockReturnValue(proc);
    const { readOneNoteNotebookByCom } = await import('../../src/services/onenote-reader');

    const promise = readOneNoteNotebookByCom('Client Notebook', 'C:\\scripts\\read-onenote-notebook.ps1');
    const args = spawnMock.mock.calls[0][1] as string[];
    const outputPath = args[args.indexOf('-OutputPath') + 1];
    fs.writeFileSync(outputPath, JSON.stringify({
      ok: true,
      sections: [
        {
          sectionName: 'Weekly Notes',
          pages: [
            { pageIndex: 1, title: 'Kickoff', date: '2024-02-01', lastModified: '', content: 'Agenda' },
          ],
        },
      ],
    }));
    proc.emit('close', 0);

    await expect(promise).resolves.toEqual([
      {
        sectionName: 'Weekly Notes',
        pages: [
          {
            pageIndex: 1,
            pageLevel: 1,
            title: 'Kickoff',
            date: '2024-02-01',
            lastModified: '',
            content: 'Agenda',
          },
        ],
      },
    ]);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('readOneNoteNotebookByCom rejects when the output file is not valid JSON', async () => {
    const proc = new FakeChildProcess();
    spawnMock.mockReturnValue(proc);
    const { readOneNoteNotebookByCom } = await import('../../src/services/onenote-reader');

    const promise = readOneNoteNotebookByCom('Broken Notebook', 'C:\\scripts\\read-onenote-notebook.ps1');
    const args = spawnMock.mock.calls[0][1] as string[];
    const outputPath = args[args.indexOf('-OutputPath') + 1];
    fs.writeFileSync(outputPath, 'not-json');
    proc.stderr.emit('data', Buffer.from('notebook stderr'));
    proc.emit('close', 1);

    await expect(promise).rejects.toThrow('Notebook COM reader produced non-JSON: notebook stderr');
    expect(fs.existsSync(outputPath)).toBe(false);
  });
});
