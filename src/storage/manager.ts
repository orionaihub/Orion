// src/storage/manager.ts
import type { AgentState, Message } from '../types';
import { parseJSON, stringifyJSON } from '../utils/helpers';

/**
 * Storage manager for Durable Object SQL storage
 */
export class StorageManager {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.initializeSchema();
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        parts TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp);
    `);
  }

  /**
   * Load agent state
   */
  async loadState(): Promise<AgentState> {
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key = 'state'`).one();
      if (row && typeof row.value === 'string') {
        const state = parseJSON<AgentState>(row.value, null);
        if (state && state.sessionId) {
          return state;
        }
      }
    } catch (e) {
      console.error('Failed to load state:', e);
    }

    // Return default state
    return {
      conversationHistory: [],
      context: { files: [], searchResults: [] },
      sessionId: crypto.randomUUID(),
      lastActivityAt: Date.now(),
      currentPlan: undefined,
    };
  }

  /**
   * Save agent state
   */
  async saveState(state: AgentState): Promise<void> {
    try {
      this.sql.exec(
        `INSERT INTO kv (key, value) VALUES ('state', ?) 
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        stringifyJSON(state)
      );
    } catch (e) {
      console.error('Failed to save state:', e);
      throw e;
    }
  }

  /**
   * Save a message
   */
  saveMessage(role: 'user' | 'model', parts: Array<{ text: string }>, timestamp: number): void {
    try {
      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
        role,
        stringifyJSON(parts),
        timestamp
      );
    } catch (e) {
      console.error('Failed to save message:', e);
      throw e;
    }
  }

  /**
   * Get conversation history
   */
  getHistory(limit?: number): Message[] {
    try {
      const query = limit
        ? `SELECT role, parts, timestamp FROM messages ORDER BY timestamp DESC LIMIT ${limit}`
        : `SELECT role, parts, timestamp FROM messages ORDER BY timestamp ASC`;
      
      const rows = this.sql.exec(query);
      const messages: Message[] = [];

      const orderedRows = limit ? Array.from(rows).reverse() : Array.from(rows);

      for (const row of orderedRows) {
        const parts = parseJSON<Array<{ text: string }>>(row.parts as string, []);
        if (parts.length > 0) {
          messages.push({
            role: row.role as 'user' | 'model',
            parts,
            timestamp: row.timestamp as number,
          });
        }
      }

      return messages;
    } catch (e) {
      console.error('Failed to get history:', e);
      return [];
    }
  }

  /**
   * Build conversation history for Gemini (with deduplication)
   */
  buildGeminiHistory(maxMessages = 20): Array<{ role: string; parts: Array<{ text: string }> }> {
    const messages = this.getHistory(maxMessages);
    const history: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
      history.push({
        role: msg.role === 'model' ? 'model' : 'user',
        parts: msg.parts,
      });
    }

    // Remove the last message if it's a user message
    // (to prevent duplicate when adding new user message)
    if (history.length > 0 && history[history.length - 1].role === 'user') {
      history.pop();
    }

    return history;
  }

  /**
   * Get the last user message
   */
  getLastUserMessage(): string {
    try {
      const row = this.sql.exec(
        `SELECT parts FROM messages WHERE role='user' ORDER BY timestamp DESC LIMIT 1`
      ).one();

      if (row) {
        const parts = parseJSON<Array<{ text: string }>>(row.parts as string, []);
        return parts[0]?.text || '';
      }
    } catch (e) {
      console.error('Failed to get last user message:', e);
    }
    return '';
  }

  /**
   * Clear all history
   */
  clearHistory(): void {
    try {
      this.sql.exec('DELETE FROM messages');
      this.sql.exec('DELETE FROM kv');
      this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
    } catch (e) {
      console.error('Failed to clear history:', e);
      throw e;
    }
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    try {
      const row = this.sql.exec('SELECT COUNT(*) as count FROM messages').one();
      return (row?.count as number) || 0;
    } catch (e) {
      console.error('Failed to get message count:', e);
      return 0;
    }
  }
}
