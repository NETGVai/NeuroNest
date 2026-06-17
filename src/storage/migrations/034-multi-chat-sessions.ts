import type Database from 'better-sqlite3';

export const version = 34;
export const description = 'Multi-chat sessions per project';

export function up(db: Database.Database): void {
  db.exec(`
    -- Chat sessions: multiple independent conversations within a project
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_message_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      message_count INTEGER NOT NULL DEFAULT 0,
      preview TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (project_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_project ON chat_sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_message ON chat_sessions(last_message_at);

    -- Chat messages: messages belonging to a specific chat session
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      tool_calls TEXT,
      token_usage TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(chat_session_id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(chat_session_id, created_at);
  `);
}
