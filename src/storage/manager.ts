// src/storage/manager.ts
import type { AgentState, Message, FileMetadata, AgentMemory } from '../types';
import { parseJSON, stringifyJSON } from '../utils/helpers';

/**
 * Storage manager for Durable Object SQL storage with Suna-Lite enhancements
 */
export class StorageManager {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    this.initializeSchema();
  }

  /**
   * Initialize database schema with file support
   */
  private initializeSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        parts TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_uri TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        uploaded_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        expires_at INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_file_state ON files(state);
      CREATE INDEX IF NOT EXISTS idx_file_uploaded ON files(uploaded_at);
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
          // Ensure all required fields exist
          state.uploadedFiles = state.uploadedFiles || [];
          state.memory = state.memory || {
            userPreferences: {},
            recentTopics: [],
            successfulPatterns: [],
          };
          return state;
        }
      }
    } catch (e) {
      console.error('Failed to load state:', e);
    }

    // Return default state
    return {
      conversationHistory: [],
      context: {
        files: [],
        searchResults: [],
        codeExecutions: [],
        images: [],
      },
      sessionId: crypto.randomUUID(),
      lastActivityAt: Date.now(),
      currentPlan: undefined,
      uploadedFiles: [],
      memory: {
        userPreferences: {},
        recentTopics: [],
        successfulPatterns: [],
      },
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
  saveMessage(role: 'user' | 'model', parts: any[], timestamp: number): void {
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
   * Save file metadata
   */
  saveFile(file: FileMetadata): void {
    try {
      this.sql.exec(
        `INSERT INTO files (file_uri, mime_type, name, size_bytes, uploaded_at, state, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_uri) DO UPDATE SET
           state = excluded.state,
           expires_at = excluded.expires_at`,
        file.fileUri,
        file.mimeType,
        file.name,
        file.sizeBytes,
        file.uploadedAt,
        file.state,
        file.expiresAt || null
      );
    } catch (e) {
      console.error('Failed to save file:', e);
      throw e;
    }
  }

  /**
   * Update file state
   */
  updateFileState(fileUri: string, state: string): void {
    try {
      this.sql.exec(
        `UPDATE files SET state = ? WHERE file_uri = ?`,
        state,
        fileUri
      );
    } catch (e) {
      console.error('Failed to update file state:', e);
    }
  }

  /**
   * Get all files
   */
  getFiles(): FileMetadata[] {
    try {
      const rows = this.sql.exec(
        `SELECT file_uri, mime_type, name, size_bytes, uploaded_at, state, expires_at
         FROM files ORDER BY uploaded_at DESC`
      );

      const files: FileMetadata[] = [];
      for (const row of rows) {
        files.push({
          fileUri: row.file_uri as string,
          mimeType: row.mime_type as string,
          name: row.name as string,
          sizeBytes: row.size_bytes as number,
          uploadedAt: row.uploaded_at as number,
          state: row.state as any,
          expiresAt: row.expires_at as number | undefined,
        });
      }
      return files;
    } catch (e) {
      console.error('Failed to get files:', e);
      return [];
    }
  }

  /**
   * Get active files only
   */
  getActiveFiles(): FileMetadata[] {
    return this.getFiles().filter(f => f.state === 'ACTIVE');
  }

  /**
   * Delete file
   */
  deleteFile(fileUri: string): void {
    try {
      this.sql.exec(`DELETE FROM files WHERE file_uri = ?`, fileUri);
    } catch (e) {
      console.error('Failed to delete file:', e);
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
        const parts = parseJSON<any[]>(row.parts as string, []);
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
   * Build conversation history for Gemini
   */
  buildGeminiHistory(maxMessages = 20): Array<{ role: string; parts: any[] }> {
    const messages = this.getHistory(maxMessages);
    const history: Array<{ role: string; parts: any[] }> = [];

    for (const msg of messages) {
      history.push({
        role: msg.role === 'model' ? 'model' : 'user',
        parts: msg.parts,
      });
    }

    // Remove the last message if it's a user message
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
        const parts = parseJSON<any[]>(row.parts as string, []);
        const textPart = parts.find(p => p.text);
        return textPart?.text || '';
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
      this.sql.exec('DELETE FROM files');
      this.sql.exec('DELETE FROM kv');
      this.sql.exec('DELETE FROM sqlite_sequence WHERE name IN ("messages", "files")');
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

  /**
   * Get file count
   */
  getFileCount(): number {
    try {
      const row = this.sql.exec('SELECT COUNT(*) as count FROM files WHERE state = "ACTIVE"').one();
      return (row?.count as number) || 0;
    } catch (e) {
      console.error('Failed to get file count:', e);
      return 0;
    }
  }

  /**
   * Clean expired files
   */
  cleanExpiredFiles(): number {
    try {
      const now = Date.now();
      const result = this.sql.exec(
        `DELETE FROM files WHERE expires_at IS NOT NULL AND expires_at < ?`,
        now
      );
      return result.rowsWritten || 0;
    } catch (e) {
      console.error('Failed to clean expired files:', e);
      return 0;
    }
  }
}
