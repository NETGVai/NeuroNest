-- 014_create_goals_feedback.sql
-- Expand phase: Create goals, goal revisions, schedules, reminders, and feedback records.
-- Requirements: 20.4, 20.6–20.7, 29.1, 29.3–29.4, 42.1–42.3

-- Goals: owner-scoped, same-session durable goals with state lifecycle
CREATE TABLE IF NOT EXISTS harness_goals (
  goalId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  ownerId TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active', -- active|completed|abandoned
  revision INTEGER NOT NULL DEFAULT 1,
  dependencies TEXT NOT NULL DEFAULT '[]', -- JSON array of goalId references
  metadata TEXT NOT NULL DEFAULT '{}', -- JSON extensible metadata
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Goal revisions: complete change history for every goal mutation
CREATE TABLE IF NOT EXISTS harness_goal_revisions (
  revisionId TEXT NOT NULL PRIMARY KEY,
  goalId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  previousRevision INTEGER,
  changeType TEXT NOT NULL, -- created|title_changed|description_changed|state_changed|dependencies_changed|metadata_changed
  changeDelta TEXT NOT NULL DEFAULT '{}', -- JSON describing what changed
  actor TEXT NOT NULL, -- JSON ActorRef
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (goalId) REFERENCES harness_goals(goalId)
);

-- Schedules: bounded catch-up session-local schedules
CREATE TABLE IF NOT EXISTS harness_schedules (
  scheduleId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  goalId TEXT, -- optional association with a goal
  ownerId TEXT NOT NULL,
  cronExpression TEXT, -- optional cron-like pattern
  intervalMs INTEGER, -- optional fixed interval
  nextOccurrenceAt TEXT NOT NULL,
  lastTriggeredAt TEXT,
  missedCount INTEGER NOT NULL DEFAULT 0,
  maxCatchUp INTEGER NOT NULL DEFAULT 1, -- bounded catch-up: max missed triggers to replay on resume
  state TEXT NOT NULL DEFAULT 'active', -- active|paused|completed|cancelled
  payload TEXT NOT NULL DEFAULT '{}', -- JSON: what to do on trigger
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (goalId) REFERENCES harness_goals(goalId)
);

-- Reminders: session-local reminder state (no external notification guarantee)
CREATE TABLE IF NOT EXISTS harness_reminders (
  reminderId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  scheduleId TEXT NOT NULL,
  goalId TEXT,
  message TEXT NOT NULL,
  dueAt TEXT NOT NULL,
  acknowledgedAt TEXT,
  state TEXT NOT NULL DEFAULT 'pending', -- pending|surfaced|acknowledged|dismissed
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (scheduleId) REFERENCES harness_schedules(scheduleId),
  FOREIGN KEY (goalId) REFERENCES harness_goals(goalId)
);

-- Feedback: separated from model context, stored locally
CREATE TABLE IF NOT EXISTS harness_feedback (
  feedbackId TEXT NOT NULL PRIMARY KEY,
  sessionId TEXT NOT NULL,
  ownerId TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general', -- general|thumbs_up|thumbs_down|correction|suggestion
  content TEXT NOT NULL DEFAULT '',
  targetEventId TEXT, -- optional: the event this feedback references
  targetSequence INTEGER, -- optional: the sequence number this feedback references
  injected INTEGER NOT NULL DEFAULT 0, -- whether this has been injected into model context
  injectionEventId TEXT, -- event ID of the injection event if injected
  revision INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}', -- JSON extensible metadata
  schemaVersion INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_harness_goals_session_owner
  ON harness_goals(sessionId, ownerId, state);

CREATE INDEX IF NOT EXISTS idx_harness_goal_revisions_goal
  ON harness_goal_revisions(goalId, revision);

CREATE INDEX IF NOT EXISTS idx_harness_schedules_session
  ON harness_schedules(sessionId, state);

CREATE INDEX IF NOT EXISTS idx_harness_schedules_next
  ON harness_schedules(nextOccurrenceAt, state);

CREATE INDEX IF NOT EXISTS idx_harness_reminders_session
  ON harness_reminders(sessionId, state);

CREATE INDEX IF NOT EXISTS idx_harness_reminders_due
  ON harness_reminders(dueAt, state);

CREATE INDEX IF NOT EXISTS idx_harness_feedback_session
  ON harness_feedback(sessionId, ownerId);

CREATE INDEX IF NOT EXISTS idx_harness_feedback_target
  ON harness_feedback(targetEventId);
