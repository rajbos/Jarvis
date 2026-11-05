import { describe, it, expect, vi } from 'vitest';
import initSqlJs from 'sql.js';

vi.mock('../../src/storage/database', () => ({ saveDatabase: vi.fn() }));

import { saveChatHistory, loadChatHistory, clearChatHistory, MAX_STORED_CHAT_MESSAGES } from '../../src/plugins/chat/history';
import { CHAT_MESSAGES_TABLE_SQL } from '../../src/storage/schema';

async function makeDb() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(CHAT_MESSAGES_TABLE_SQL);
  return db;
}

describe('chat history', () => {
  it('round-trips save, load and clear', async () => {
    const db = await makeDb();
    saveChatHistory(db, [
      { role: 'user', content: 'hi', display: 'Hi!' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(loadChatHistory(db)).toEqual([
      { role: 'user', content: 'hi', display: 'Hi!' },
      { role: 'assistant', content: 'hello' },
    ]);
    saveChatHistory(db, [{ role: 'user', content: 'replaced' }]);
    expect(loadChatHistory(db)).toEqual([{ role: 'user', content: 'replaced' }]);
    clearChatHistory(db);
    expect(loadChatHistory(db)).toEqual([]);
  });

  it('keeps only the newest messages and drops invalid entries', async () => {
    const db = await makeDb();
    const many = Array.from({ length: MAX_STORED_CHAT_MESSAGES + 5 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    saveChatHistory(db, [{ role: 'diagnostic' }, ...many]);
    const loaded = loadChatHistory(db);
    expect(loaded).toHaveLength(MAX_STORED_CHAT_MESSAGES);
    expect(loaded[0].content).toBe('m5');
    expect(loaded.at(-1)?.content).toBe(`m${MAX_STORED_CHAT_MESSAGES + 4}`);
  });
});
