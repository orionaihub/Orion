// src/durable-storage.ts
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
 * Durable Object storage wrapper for SQLite + DO ephemeral state.
 * Compatible with D1-in-DO SQL binding.
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

  // --------------------------------------
  // Initialization
  // --------------------------------------

  private initialize(): void {
    try {
      if (!this.sql) return;

      // MUST be 1 statement per exec() — D1 inside DO does not allow multi-statement exec.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          parts TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp)
      `);

    } catch (e) {
      console.error('[DurableStorage] SQLite init failed:', e);
    }
  }

  // --------------------------------------
  // Message Operations
  // --------------------------------------

  async saveMessage(role: 'user' | 'model', parts: Array<{ text: string }>): Promise<void> {
    if (!this.sql) return;

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

    try {
      const actualLimit = Math.min(limit ?? this.maxHistoryMessages, this.maxHistoryMessages);

      const rows = this.sql
        .exec(
          `SELECT role, parts, timestamp
           FROM messages
           ORDER BY timestamp DESC
           LIMIT ?`,
          actualLimit
        )
        .toArray();

      const messages: Message[] = [];

      for (const r of rows.reverse()) {
        try {
          const parts = JSON.parse(r.parts as string);
          messages.push({
            role: r.role as 'user' | 'model',
            parts,
            timestamp: r.timestamp as number,
          });
        } catch (e) {
          console.warn('[DurableStorage] Failed to parse message:', e);
        }
      }

      // Deduplicate consecutive user messages
      let i = messages.length - 1;
      while (i > 0) {
        if (messages[i].role === 'user' && messages[i - 1].role === 'user') {
          messages.splice(i, 1);
        }
        i--;
      }

      return messages;
    } catch (e) {
      console.error('[DurableStorage] Failed to get messages:', e);
      return [];
    }
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

  // --------------------------------------
  // State (Session) Operations
  // --------------------------------------

  async loadState(): Promise<AgentState> {
    let state: AgentState | null = null;

    try {
      if (this.sql) {
        const rows = this.sql
          .exec(`SELECT value FROM kv WHERE key = ?`, 'state')
          .toArray();

        if (rows.length === 1) {
          state = JSON.parse(rows[0].value as string);
        }
      }
    } catch (e) {
      console.log('[DurableStorage] No existing state found (creating new)');
    }

    // Create a default state if none exists
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
    if (!this.sql) return;

    try {
      this.sql.exec(
        `INSERT INTO kv (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        'state',
        JSON.stringify(state)
      );
    } catch (e) {
      console.error('[DurableStorage] Failed to save state:', e);
      throw e;
    }
  }

  async clearState(): Promise<void> {
    if (!this.sql) return;

    try {
      this.sql.exec(`DELETE FROM kv WHERE key = ?`, 'state');
    } catch (e) {
      console.error('[DurableStorage] Failed to clear state:', e);
      throw e;
    }
  }

  // --------------------------------------
  // Transaction Management
  // --------------------------------------

  async withTransaction<T>(fn: (state: AgentState) => Promise<T>): Promise<T> {
    return this.state.blockConcurrencyWhile(async () => {
      const state = await this.loadState();
      const result = await fn(state);
      await this.saveState(state);
      return result;
    });
  }

  // --------------------------------------
  // Utility Methods
  // --------------------------------------

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
        // Load state safely
        const rows = this.sql
          .exec(`SELECT value FROM kv WHERE key = ?`, 'state')
          .toArray();

        if (rows.length === 1) {
          const state = JSON.parse(rows[0].value as string);
          sessionId = state?.sessionId ?? null;
          lastActivity = state?.lastActivityAt ?? null;
        }

        // Count messages
        const countRows = this.sql
          .exec(`SELECT COUNT(*) AS count FROM messages`)
          .toArray();

        if (countRows.length === 1) {
          messageCount = countRows[0].count ?? 0;
        }
      }
    } catch (e) {
      console.error('[DurableStorage] Failed to get status:', e);
    }

    return { sessionId, lastActivity, messageCount };
  }

  getDurableObjectState(): DurableObjectState {
    return this.state;
  }
}

export default DurableStorage;
