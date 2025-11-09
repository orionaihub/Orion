// src/persistence.ts

import type { AgentState, Message, SqlStorage } from './types';
import type { DurableObjectState } from '@cloudflare/workers-types';

/**
 * Creates the necessary tables if they don't exist.
 * @param sql The SQL storage interface.
 */
export function createTables(sql: SqlStorage): void {
  try {
    sql.exec(`
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
  } catch (e) {
    console.error('SQLite init failed:', e);
  }
}

/**
 * Loads the core persistent state from the 'kv' table.
 * @param sql The SQL storage interface.
 * @param doState The Durable Object state object to get the ID from.
 * @returns The loaded or initialized AgentState.
 */
export async function loadState(sql: SqlStorage, doState: DurableObjectState): Promise<AgentState> {
  let state: AgentState | null = null;
  
  try {
    const row = sql.exec(`SELECT value FROM kv WHERE key = ?`, 'state').one();
    if (row && typeof row.value === 'string') {
      state = JSON.parse(row.value);
    }
  } catch (e) {
    console.error('SQLite read failed (loadState):', e);
  }

  if (!state || !state.sessionId) {
    state = {
      conversationHistory: [],
      context: { files: [], searchResults: [], urls: [] },
      sessionId: doState.id?.toString ? doState.id.toString() : Date.now().toString(),
      lastActivityAt: Date.now(),
    } as AgentState;
  }

  return state;
}

/**
 * Saves the core persistent state to the 'kv' table.
 * @param sql The SQL storage interface.
 * @param state The AgentState to save.
 */
export async function saveState(sql: SqlStorage, state: AgentState): Promise<void> {
  try {
    const stateStr = JSON.stringify(state);
    sql.exec(
      `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      'state',
      stateStr
    );
  } catch (e) {
    console.error('SQLite write failed (saveState):', e);
  }
}

/**
 * Loads the conversation history from the 'messages' table.
 * @param sql The SQL storage interface.
 * @param limit The maximum number of messages to retrieve.
 * @returns An array of Message objects.
 */
export function loadHistory(sql: SqlStorage, limit: number): Message[] {
  const rows = sql.exec(
      `SELECT role, parts, timestamp FROM messages ORDER BY timestamp DESC LIMIT ?`,
      Math.min(limit, 50)
    ).toArray();
    
  const hist: Message[] = [];

  for (const r of rows.reverse()) {
    try {
      const parts = JSON.parse(r.parts as string);
      if (parts) {
        hist.push({
          role: r.role === 'model' ? 'model' : 'user',
          parts,
          timestamp: r.timestamp as number,
        });
      }
    } catch (e) {
      console.warn('Failed to parse message from DB:', e);
    }
  }

  // Deduplicate consecutive user messages (a common cleanup)
  let i = hist.length - 1;
  while (i > 0) {
    if (hist[i].role === 'user' && hist[i - 1].role === 'user') {
      hist.splice(i, 1);
    }
    i--;
  }

  return hist;
}

/**
 * Saves a single message to the 'messages' table.
 * @param sql The SQL storage interface.
 * @param role The role of the message ('user' or 'model').
 * @param parts The message content parts.
 * @param timestamp The message timestamp.
 */
export function saveMessage(sql: SqlStorage, role: 'user' | 'model', parts: any, timestamp: number): void {
  try {
    sql.exec(
      `INSERT INTO messages (role, parts, timestamp) VALUES (?, ?, ?)`,
      role,
      JSON.stringify(parts),
      timestamp
    );
  } catch (e) {
    console.error(`Failed to save ${role} message:`, e);
  }
}

/**
 * Clears all conversation history and state data.
 * @param sql The SQL storage interface.
 */
export function clearAll(sql: SqlStorage): void {
  try {
    sql.exec('DELETE FROM messages');
    sql.exec('DELETE FROM kv');
    // Also reset the sequence counter for AUTOINCREMENT columns
    sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages")');
  } catch (e) {
    console.error('Clear DB failed:', e);
    throw new Error('Database clear operation failed.');
  }
}
