-- 009_create_jobs_workflows.sql
-- Expand phase: Create jobs, workflows, and subagent delegation records.
-- Requirements: 5.1–5.7, 6.1–6.6, 20.1–20.8

CREATE TABLE IF NOT EXISTS harness_jobs (
  jobId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  owner TEXT NOT NULL, -- JSON ActorRef
  parentJobId TEXT,
  jobType TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|failed|cancelled
  goal TEXT, -- JSON goal descriptor
  budget TEXT NOT NULL DEFAULT '{}', -- JSON: token, cost, time, continuation bounds
  result TEXT, -- JSON terminal result
  idempotencyKey TEXT UNIQUE,
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completedAt TEXT,
  FOREIGN KEY (parentJobId) REFERENCES harness_jobs(jobId)
);

CREATE TABLE IF NOT EXISTS harness_workflows (
  workflowId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  jobId TEXT NOT NULL,
  definition TEXT NOT NULL, -- JSON: validated DAG
  state TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|failed|cancelled
  currentStep TEXT, -- current step identifier
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (jobId) REFERENCES harness_jobs(jobId)
);

CREATE TABLE IF NOT EXISTS harness_subagents (
  subagentId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  parentSessionId TEXT,
  parentSequence INTEGER,
  delegationType TEXT NOT NULL, -- in_process|forked|isolated
  goal TEXT NOT NULL,
  scope TEXT NOT NULL, -- JSON ScopeDescriptor
  budget TEXT NOT NULL DEFAULT '{}', -- JSON budget
  state TEXT NOT NULL DEFAULT 'pending',
  resultInjectionPolicy TEXT NOT NULL DEFAULT 'explicit',
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_harness_jobs_session
  ON harness_jobs(sessionId, state);

CREATE INDEX IF NOT EXISTS idx_harness_jobs_parent
  ON harness_jobs(parentJobId);

CREATE INDEX IF NOT EXISTS idx_harness_workflows_job
  ON harness_workflows(jobId);

CREATE INDEX IF NOT EXISTS idx_harness_subagents_session
  ON harness_subagents(sessionId, state);
