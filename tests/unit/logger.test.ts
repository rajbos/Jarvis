import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, setLogLevel, getLogLevel } from '../../src/services/logger';

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
});
