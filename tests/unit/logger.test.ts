import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  logger, setLogLevel, getLogLevel, enableFileLogging, disableFileLogging, getLogFilePath,
} from '../../src/services/logger';

describe('logger', () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  beforeEach(() => {
    console.log = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
    setLogLevel('debug');
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    setLogLevel('debug');
  });

  it('defaults to debug level', () => {
    expect(getLogLevel()).toBe('debug');
  });

  it('logs everything at debug level', () => {
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    expect(console.error).toHaveBeenCalledWith('e');
    expect(console.warn).toHaveBeenCalledWith('w');
    expect(console.log).toHaveBeenCalledWith('i');
    expect(console.log).toHaveBeenCalledWith('d');
  });

  it('suppresses info and debug at warn level', () => {
    setLogLevel('warn');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    expect(console.error).toHaveBeenCalledWith('e');
    expect(console.warn).toHaveBeenCalledWith('w');
    expect(console.log).not.toHaveBeenCalled();
  });

  it('only logs errors at error level', () => {
    setLogLevel('error');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');
    expect(console.error).toHaveBeenCalledWith('e');
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('logs info and above but not debug at info level', () => {
    setLogLevel('info');
    logger.info('i');
    logger.debug('d');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith('i');
  });

  describe('file transport', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-logger-'));
    });

    afterEach(() => {
      disableFileLogging();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('writes nothing to disk until enabled', () => {
      logger.error('not persisted');
      expect(getLogFilePath()).toBeNull();
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('appends timestamped, leveled lines including error stacks', () => {
      const file = enableFileLogging(path.join(dir, 'logs'));
      logger.error('[DB] failed:', new Error('boom'));
      logger.warn('careful', 42);
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[ERROR\] \[DB\] failed: Error: boom/);
      expect(content).toContain('    at ');
      expect(content).toMatch(/\[WARN\] careful 42\n$/);
    });

    it('respects the log level for file output', () => {
      const file = enableFileLogging(dir);
      setLogLevel('warn');
      logger.info('skipped');
      logger.debug('skipped');
      logger.warn('kept');
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toContain('skipped');
      expect(content).toContain('kept');
    });

    it('rotates to main.old.log once the size limit is exceeded', () => {
      const file = enableFileLogging(dir, 200);
      for (let i = 0; i < 10; i++) logger.error(`line ${i} `.padEnd(40, 'x'));
      expect(fs.existsSync(path.join(dir, 'main.old.log'))).toBe(true);
      expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
      expect(fs.readFileSync(file, 'utf8')).toContain('line 9');
    });
  });
});
