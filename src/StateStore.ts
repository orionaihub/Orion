import type { DurableObjectState } from '@cloudflare/workers-types';
import type { AgentState } from '../../types/agent';

export class StateStore {
  private sql: DurableObjectStorage['sql']; // exact typed alias

  constructor(private state: DurableObjectState) {
    this.sql = (this.state.storage as any).sql;
    this.initSchema();
  }

  /* ----------  private  ---------- */

  private initSchema(): void {
    try {
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
      this.sql.exec(
        `INSERT OR IGNORE INTO kv(key,value) VALUES('schema_version','1')`
      );
    } catch (e) {
      console.error('[StateStore] initSchema error:', e);
    }
  }

  /* ----------  public CRUD  ---------- */

  async load(): Promise<AgentState> {
    let st: AgentState | null = null;
    try {
      const row = this.sql.exec(`SELECT value FROM kv WHERE key=?`, 'state').one();
      if (row?.value) st = JSON.parse(row.value);
    } catch (e) {
      console.error('[StateStore] load error:', e);
    }

    if (!st?.sessionId) {
      st = {
        conversationHistory: [],
        context: { files: [], searchResults: [] },
        sessionId: this.state.id.toString(),
        lastActivityAt: Date.now(),
      };
    }
    return st;
  }

  async save(st: AgentState): Promise<void> {
    try {
      const val = JSON.stringify(st);
      this.sql.exec(
        `INSERT INTO kv(key,value) VALUES(?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        'state',
        val
      );
    } catch (e) {
      console.error('[StateStore] save error:', e);
    }
  }

  async transact<T>(fn: (st: AgentState) => Promise<T>): Promise<T> {
    return this.state.blockConcurrencyWhile(async () => {
      const st = await this.load();
      const res = await fn(st);
      await this.save(st);
      return res;
    });
  }

  appendMessage(role: 'user' | 'model', parts: string, ts: number): void {
    this.sql.exec(
      `INSERT INTO messages(role,parts,timestamp) VALUES (?,?,?)`,
      role,
      parts,
      ts
    );
  }

  getMessages(limit = 50): Array<{ role: string; parts: string; timestamp: number }> {
    return this.sql
      .exec(`SELECT role,parts,timestamp FROM messages ORDER BY timestamp DESC LIMIT ?`, limit)
      .toArray()
      .reverse();
  }

  clearMessages(): void {
    this.sql.exec(`DELETE FROM messages`);
    this.sql.exec(`DELETE FROM kv WHERE key='state'`);
    this.sql.exec(`DELETE FROM sqlite_sequence WHERE name='messages'`);
  }
}

export { StateStore };
