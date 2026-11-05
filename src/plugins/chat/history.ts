import type { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from '../../storage/database';

/** Messages kept for the current conversation; older ones are dropped on save. */
export const MAX_STORED_CHAT_MESSAGES = 100;

export interface StoredChatMessage {
  role: 'user' | 'assistant';
  content: string;
  display?: string;
}

function isStoredMessage(m: unknown): m is StoredChatMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as Record<string, unknown>;
  return (v.role === 'user' || v.role === 'assistant')
    && typeof v.content === 'string'
    && (v.display === undefined || typeof v.display === 'string');
}

/** Replace the stored conversation with the newest MAX_STORED_CHAT_MESSAGES valid messages. */
export function saveChatHistory(db: SqlJsDatabase, messages: unknown): void {
  const valid = Array.isArray(messages) ? messages.filter(isStoredMessage).slice(-MAX_STORED_CHAT_MESSAGES) : [];
  db.run('BEGIN');
  try {
    db.run('DELETE FROM chat_messages');
    valid.forEach((m, i) => {
      db.run('INSERT INTO chat_messages (position, role, content, display) VALUES (?, ?, ?, ?)', [i, m.role, m.content, m.display ?? null]);
    });
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
  saveDatabase();
}

export function loadChatHistory(db: SqlJsDatabase): StoredChatMessage[] {
  const result = db.exec('SELECT role, content, display FROM chat_messages ORDER BY position');
  if (result.length === 0) return [];
  return result[0].values.map((row) => ({
    role: row[0] as 'user' | 'assistant',
    content: row[1] as string,
    ...(row[2] != null ? { display: row[2] as string } : {}),
  }));
}

export function clearChatHistory(db: SqlJsDatabase): void {
  db.run('DELETE FROM chat_messages');
  saveDatabase();
}
