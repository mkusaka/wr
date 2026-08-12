CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  linear_issue_id  TEXT UNIQUE,
  title            TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','done','cancelled')),
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cli_sessions (
  id                   TEXT PRIMARY KEY,
  cli                  TEXT NOT NULL CHECK (cli IN ('codex','claude')),
  external_session_id  TEXT NOT NULL,
  parent_session_id    TEXT REFERENCES cli_sessions(id),
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(cli, external_session_id)
);

CREATE TABLE session_runs (
  id                TEXT PRIMARY KEY,
  cli_session_id    TEXT NOT NULL REFERENCES cli_sessions(id),
  iterm_session_id  TEXT,
  started_cwd       TEXT,
  source            TEXT,
  started_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at          TEXT,
  end_reason        TEXT CHECK (end_reason IS NULL OR end_reason IN ('session_end','superseded'))
);

CREATE TABLE git_checkouts (
  id             TEXT PRIMARY KEY,
  repo_root      TEXT NOT NULL,
  worktree_path  TEXT NOT NULL,
  branch         TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_root, worktree_path)
);

CREATE TABLE session_run_checkouts (
  session_run_id  TEXT NOT NULL REFERENCES session_runs(id),
  checkout_id     TEXT NOT NULL REFERENCES git_checkouts(id),
  last_seen_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_run_id, checkout_id)
);

CREATE TABLE executions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  cli_session_id  TEXT NOT NULL REFERENCES cli_sessions(id),
  session_run_id  TEXT REFERENCES session_runs(id),
  checkout_id     TEXT REFERENCES git_checkouts(id),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','finished','abandoned')),
  started_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at     TEXT
);

CREATE TABLE pull_requests (
  id            TEXT PRIMARY KEY,
  repo          TEXT NOT NULL,
  number        INTEGER NOT NULL,
  url           TEXT,
  head_branch   TEXT,
  base_branch   TEXT,
  parent_pr_id  TEXT REFERENCES pull_requests(id),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo, number)
);

CREATE TABLE task_pull_requests (
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  pull_request_id  TEXT NOT NULL REFERENCES pull_requests(id),
  PRIMARY KEY (task_id, pull_request_id)
);

CREATE TABLE task_links (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  kind           TEXT NOT NULL,
  ref            TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, kind, ref)
);

CREATE INDEX idx_runs_active_terminal
  ON session_runs(iterm_session_id, last_seen_at)
  WHERE ended_at IS NULL;

CREATE INDEX idx_exec_active_task
  ON executions(task_id) WHERE status = 'active';

CREATE INDEX idx_exec_active_checkout
  ON executions(checkout_id) WHERE status = 'active';

CREATE INDEX idx_checkouts_repo
  ON git_checkouts(repo_root);

CREATE INDEX idx_run_checkouts_checkout
  ON session_run_checkouts(checkout_id, last_seen_at);
