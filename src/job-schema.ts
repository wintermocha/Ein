export type JobInput = {
  key: string;
  conversation: string;
  channel: string;
  threadTs: string | null;
  ts: string;
  source: string;
  user: string;
  text: string;
};

export type Job = JobInput & {
  id: number;
  status: "queued" | "active" | "held" | "waiting" | "done";
  stage: string;
  attempt: number;
  project: string | null;
  sessionId: string | null;
  context: string | null;
  clarification: string | null;
  question: string | null;
  reason: string | null;
};

export const jobsSchema = `
  CREATE TABLE IF NOT EXISTS installation (id INTEGER PRIMARY KEY CHECK (id = 1), uuid TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE,
    conversation TEXT NOT NULL, channel TEXT NOT NULL, threadTs TEXT,
    ts TEXT NOT NULL, source TEXT NOT NULL, user TEXT NOT NULL, text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'active', 'held', 'waiting', 'done')),
    stage TEXT NOT NULL DEFAULT 'new', attempt INTEGER NOT NULL DEFAULT 0,
    project TEXT, sessionId TEXT, context TEXT, clarification TEXT, question TEXT, reason TEXT,
    answer TEXT, questionDelivery TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS jobs_question ON jobs(questionDelivery) WHERE questionDelivery IS NOT NULL;
  CREATE INDEX IF NOT EXISTS jobs_open ON jobs(conversation, id) WHERE status != 'done';
  CREATE INDEX IF NOT EXISTS jobs_mentioned_thread ON jobs(channel, threadTs) WHERE source IN ('mention', 'thread-mention');
  CREATE INDEX IF NOT EXISTS jobs_history ON jobs(conversation, id) WHERE answer IS NOT NULL;
  CREATE TABLE IF NOT EXISTS job_sessions (
    id TEXT PRIMARY KEY, runner TEXT NOT NULL, cwd TEXT NOT NULL, paneId TEXT, nativeId TEXT
  );
  CREATE TABLE IF NOT EXISTS conversation_projects (
    conversation TEXT PRIMARY KEY, project TEXT NOT NULL
  );
`;
