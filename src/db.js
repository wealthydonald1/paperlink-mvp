import Database from "better-sqlite3";

export const db = new Database("data.db");

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
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- migrations (safe to run; ignores "duplicate column" errors) ---
function tryExec(sql) {
  try {
    db.exec(sql);
  } catch (e) {
    // ignore duplicate column errors
    if (String(e?.message || "").includes("duplicate column name")) return;
    throw e;
  }
}

tryExec(`ALTER TABLE files ADD COLUMN owner_user_id TEXT;`);
tryExec(`ALTER TABLE files ADD COLUMN max_downloads INTEGER;`);
tryExec(`ALTER TABLE files ADD COLUMN download_count INTEGER DEFAULT 0;`);
tryExec(`ALTER TABLE files ADD COLUMN expires_at TEXT;`);
tryExec(`ALTER TABLE files ADD COLUMN is_revoked INTEGER DEFAULT 0;`);


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
  SELECT * FROM files WHERE id = ?
`);

export const listFilesByOwner = db.prepare(`
  SELECT id, file_name, file_size, download_count, max_downloads, created_at, expires_at, is_revoked
  FROM files
  WHERE owner_user_id = ? AND is_revoked = 0
  ORDER BY created_at DESC
  LIMIT ?
`);

export const getActiveBytesByOwner = db.prepare(`
  SELECT COALESCE(SUM(file_size), 0) AS total
  FROM files
  WHERE owner_user_id = ?
    AND is_revoked = 0
    AND (expires_at IS NULL OR expires_at > datetime('now'))
`);

export const incrementDownload = db.prepare(`
  UPDATE files SET download_count = download_count + 1 WHERE id = ?
`);

export const setMaxDownloads = db.prepare(`
  UPDATE files SET max_downloads = ? WHERE id = ? AND owner_user_id = ?
`);

export const revokeFile = db.prepare(`
  UPDATE files SET is_revoked = 1 WHERE id = ? AND owner_user_id = ?
`);
