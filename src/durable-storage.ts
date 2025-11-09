// src/durable-storage.ts - Durable Object Storage Management
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { AgentState, Message } from './types';

interface SqlStorage {
  exec(query: string, ...params: any[]): {
    one(): any;
    toArray(): any[];
    [Symbol.iterator](): Iterator<any>;
  };
}

/**
 * Manages persistent storage for Durable Objects
 * Handles SQLite operations and state management
 */
export class DurableStorage {
  private state: DurableObjectState;
  private sql: SqlStorage | null;
  private maxHistoryMessages: number;

  constructor(state: DurableObjectState, maxHistoryMessages = 200) {
    this.state = state;
    this.maxHistoryMessages = maxHistoryMessages;
    this.sql = (state.storage as unknown as { sql?: SqlStorage }).sql ?? null;
    this.initialize();
  }

  // ===== Initialization =====

  private initialize(): void {
    try {
      if (this.sql) {
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
    } catch (e) {
      console.error('[DurableStorage] SQLite init failed:', e);
    }
  }

  // ===== Message Operations =====

  async saveMessage(role: 'user' | 'model', parts: Array<{ text: string }>): Promise<void> {
    if (!this.sql) {
      console.warn('[DurableStorage] SQLite not available');
      return;
    }

    try {
      this.sql.exec(
        `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
        role,
        JSON.stringify(parts),
        Date.now()
      );
    } catch (e) {
      console.error('[DurableStorage] Failed to save message:', e);
      throw e;
    }
  }

  getMessages(limit?: number): Message[] {
    if (!this.sql) return [];

    const actualLimit = Math.min(limit ?? this.maxHistoryMessages, this.maxHistoryMessages);
    const rows = this.sql
      .exec(`SELECT role, parts, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?`, actualLimit)
      .toArray();

    const messages: Message[] = [];

    for (const r of rows.reverse()) {
      try {
        const parts = JSON.parse(r.parts as string);
        if (parts) {
          messages.push({
            role: r.role as 'user' | 'model',
            parts,
            timestamp: r.timestamp as number,
          });
        }
      } catch (e) {
        console.warn('[DurableStorage] Failed to parse message:', e);
      }
    }

    // Remove consecutive duplicate user messages
    let i = messages.length - 1;
    while (i > 0) {
      if (messages[i].role === 'user' && messages[i - 1].role === 'user') {
        messages.splice(i, 1);
      }
      i--;
    }

    return messages;
  }

  async clearMessages(): Promise<void> {
    if (!this.sql) return;

    try {
      this.sql.exec('DELETE FROM messages');
      this.sql.exec('DELETE FROM sqlite_sequence WHERE name = "messages"');
    } catch (e) {
      console.error('[DurableStorage] Failed to clear messages:', e);
      throw e;
    }
  }

  // ===== State Operations =====

  async loadState(): Promise<AgentState> {
    let state: AgentState | null = null;

    try {
      if (this.sql) {
        const row = this.sql.exec(`SELECT value FROM kv WHERE key = ?`, 'state').one();
        if (row && typeof row.value === 'string') {
          state = JSON.parse(row.value);
        }
      }
    } catch (e) {
      console.error('[DurableStorage] Failed to load state:', e);
    }

    // Create default state if none exists
    if (!state || !state.sessionId) {
      state = {
        conversationHistory: [],
        context: { files: [], searchResults: [] },
        sessionId: this.state.id?.toString?.() ?? Date.now().toString(),
        lastActivityAt: Date.now(),
      } as AgentState;
    }

    return state;
  }

  async saveState(state: AgentState): Promise<void> {
    if (!this.sql) {
      console.warn('[DurableStorage] SQLite not available');
      return;
    }

    try {
      const stateStr = JSON.stringify(state);
      this.sql.exec(
        `INSERT INTO kv (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        'state',
        stateStr
      );
    } catch (e) {
      console.error('[DurableStorage] Failed to save state:', e);
      throw e;
    }
  }

  async clearState(): Promise<void> {
    if (!this.sql) return;

    try {
      this.sql.exec('DELETE FROM kv WHERE key = ?', 'state');
    } catch (e) {
      console.error('[DurableStorage] Failed to clear state:', e);
      throw e;
    }
  }

  // ===== Transaction Management =====

  async withTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.state.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  // ===== Utility Methods =====

  async clearAll(): Promise<void> {
    if (!this.sql) return;

    try {
      this.sql.exec('DELETE FROM messages');
      this.sql.exec('DELETE FROM kv');
      this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
    } catch (e) {
      console.error('[DurableStorage] Failed to clear all:', e);
      throw e;
    }
  }

  getStatus(): { 
    sessionId: string | null; 
    lastActivity: number | null;
    messageCount: number;
  } {
    let sessionId: string | null = null;
    let lastActivity: number | null = null;
    let messageCount = 0;

    try {
      if (this.sql) {
        // Get state
        const stateRow = this.sql.exec(`SELECT value FROM kv WHERE key = ?`, 'state').one();
        if (stateRow) {
          const state = JSON.parse(stateRow.value as string);
          sessionId = state?.sessionId ?? null;
          lastActivity = state?.lastActivityAt ?? null;
        }

        // Get message count
        const countRow = this.sql.exec(`SELECT COUNT(*) as count FROM messages`).one();
        messageCount = countRow?.count ?? 0;
      }
    } catch (e) {
      console.error('[DurableStorage] Failed to get status:', e);
    }

    return { sessionId, lastActivity, messageCount };
  }

  // Allow external access to the Durable Object state for advanced use cases
  getDurableObjectState(): DurableObjectState {
    return this.state;
  }
}
