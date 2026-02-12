// src/db.js
import Database from "better-sqlite3";

const db = new Database("data.db");

// Create table (safe if exists)
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    file_id TEXT NOT NULL,
    file_unique_id TEXT,
    file_name TEXT,
    mime_type TEXT,
    file_size INTEGER,
    created_at TEXT DEFAULT (datetime('now')),

    owner_user_id TEXT,
    max_downloads INTEGER,
    download_count INTEGER DEFAULT 0,
    expires_at TEXT,
    is_revoked INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_files_owner_created
  ON files(owner_user_id, created_at DESC);
`);

// ✅ IMPORTANT: do NOT require created_at param
export const insertFile = db.prepare(`
  INSERT INTO files (
    id,
    chat_id,
    message_id,
    file_id,
    file_unique_id,
    file_name,
    mime_type,
    file_size,
    owner_user_id,
    max_downloads,
    download_count,
    expires_at,
    is_revoked
  ) VALUES (
    @id,
    @chat_id,
    @message_id,
    @file_id,
    @file_unique_id,
    @file_name,
    @mime_type,
    @file_size,
    @owner_user_id,
    @max_downloads,
    COALESCE(@download_count, 0),
    @expires_at,
    COALESCE(@is_revoked, 0)
  )
`);

export const getFileById = db.prepare(`
  SELECT *
  FROM files
  WHERE id = ?
`);

export const incrementDownload = db.prepare(`
  UPDATE files
  SET download_count = COALESCE(download_count, 0) + 1
  WHERE id = ?
`);

export const listFilesByOwner = db.prepare(`
  SELECT id, file_name, file_size, download_count, max_downloads, expires_at, is_revoked, created_at
  FROM files
  WHERE owner_user_id = ?
  ORDER BY datetime(created_at) DESC
  LIMIT ?
`);

export const setMaxDownloads = db.prepare(`
  UPDATE files
  SET max_downloads = ?
  WHERE id = ? AND owner_user_id = ?
`);

export const revokeFile = db.prepare(`
  UPDATE files
  SET is_revoked = 1
  WHERE id = ? AND owner_user_id = ?
`);
