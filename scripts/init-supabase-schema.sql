-- Resume Rater: Postgres schema (idempotent; safe to run repeatedly).
--
-- The app stores evaluation METADATA only for signed-in users: filename,
-- detected category, score and keyword gaps. Resume text and parsed sections
-- are never written.
--
-- If an older version of the app stored resume text, purge it once with:
--   UPDATE resumes SET raw_text = NULL, cleaned_text = NULL, parsed_sections = NULL;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                 -- Supabase auth user id
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    avatar TEXT,
    role TEXT DEFAULT 'user',
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;

CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    filename TEXT,
    file_size_bytes INTEGER,
    page_count INTEGER DEFAULT 1,
    word_count INTEGER DEFAULT 0,
    raw_text TEXT,                       -- legacy, unused
    cleaned_text TEXT,                   -- legacy, unused
    parsed_sections JSONB,               -- legacy, unused
    detected_category TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE resumes ADD COLUMN IF NOT EXISTS word_count INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_resumes_user_id ON resumes(user_id);

CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    resume_id TEXT REFERENCES resumes(id) ON DELETE CASCADE,
    target_job_title TEXT,
    similarity_score NUMERIC(5, 2),
    match_rating TEXT,
    dimensions JSONB,
    keyword_gaps JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_evaluations_user_id ON evaluations(user_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_resume_id ON evaluations(resume_id);

-- The app connects with a server-side Postgres role. Enabling RLS with no
-- policies blocks access through the public anon/authenticated API keys.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluations ENABLE ROW LEVEL SECURITY;
