-- PDF Review schema for Cloudflare D1
-- Run with: wrangler d1 execute pdf-review-comments --file=schema.sql

-- Each doc is registered with the Worker via POST /docs (called once by the
-- add-pdf script). This is what makes admin tokens enforceable server-side
-- rather than trusting the client.
CREATE TABLE IF NOT EXISTS documents (
    doc_id            TEXT PRIMARY KEY,
    admin_token_hash  TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS annotations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id        TEXT    NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
    page          INTEGER NOT NULL,
    x_pct         REAL    NOT NULL,
    y_pct         REAL    NOT NULL,
    resolved      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_annotations_doc ON annotations(doc_id);

CREATE TABLE IF NOT EXISTS comments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    annotation_id   INTEGER NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
    author_name     TEXT    NOT NULL,
    body            TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_anno ON comments(annotation_id);
