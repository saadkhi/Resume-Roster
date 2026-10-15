// Idempotent schema, applied on first database connection.
// Embedded as a string so it is always bundled with the serverless function.
export const SCHEMA_SQL = `
-- Resume Rater: Postgres schema (idempotent; applied automatically on first connect).
--
-- Only account details and evaluation METADATA are stored. Resume text and
-- parsed sections are never written.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,          -- stored lower-case
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,         -- scrypt$N$r$p$salt$hash
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT,
    file_size_bytes INTEGER,
    page_count INTEGER DEFAULT 1,
    word_count INTEGER DEFAULT 0,
    detected_category TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resumes_user_id ON resumes(user_id);

CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resume_id TEXT REFERENCES resumes(id) ON DELETE CASCADE,
    target_job_title TEXT,
    similarity_score NUMERIC(5, 2),
    match_rating TEXT,
    dimensions JSONB,
    keyword_gaps JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evaluations_user_created ON evaluations(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    subject TEXT,
    message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
