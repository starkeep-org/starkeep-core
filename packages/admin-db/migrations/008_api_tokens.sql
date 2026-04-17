-- Add token_hash column for API token authentication (used by desktop cloud connect)
ALTER TABLE auth_sessions ADD COLUMN token_hash TEXT;
CREATE UNIQUE INDEX idx_auth_sessions_token_hash ON auth_sessions(token_hash) WHERE token_hash IS NOT NULL;
