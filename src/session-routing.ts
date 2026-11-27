import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config, Runner } from "./config";
import { jobClarifications, threadCutoff, type Job, type JobQueue } from "./job-queue";
import { ensurePrivateDirectory } from "./private-directory";
import type { SessionRef } from "./runners";
import { snifferEnvironment } from "./sniffer";
import { compareSlackTs } from "./thread-history";
import type { MemoryScope, TurnRequest, TurnResult } from "./turn-contract";

export class DispatchHold extends Error {}
export type Stage = "main" | "conversation" | "project" | "summary" | "review-conversation" |
  "review-project" | "resolved-conversation" | "resolved-project";
export type Target = { readonly stage: Stage; readonly project: string | null; readonly context?: string | null };

export function role(stage: Stage): TurnRequest["role"] {
  switch (stage) {
    case "main": case "review-conversation": case "review-project": return "main";
    case "project": case "resolved-project": return "project";
    case "conversation": case "summary": case "resolved-conversation": return "conversation";
    default: return stage satisfies never;
  }
}

export function savedTarget(job: Job): Target {
  const stage = job.stage.replace(/^running\//u, "");
  switch (stage) {
    case "main": case "conversation": case "project": case "summary":
    case "review-conversation": case "review-project": case "resolved-conversation": case "resolved-project":
      return { stage, project: job.project };
    default: throw new DispatchHold("Unrecognized stored orchestration stage.");
  }
}

export const nonOwnerReply = "메시지를 받았습니다. 아인은 Slack 스레드에서 프로젝트 작업을 이어갈 수 있습니다. 작업이나 에이전트 답변이 필요하면 워크스페이스의 아인 소유자에게 요청해 주세요. 소유자는 project:<id>로 프로젝트를 지정할 수 있습니다.";

export class SessionRouting {
  constructor(
    private readonly queue: JobQueue,
    private readonly config: Config,
    private readonly runner: Runner,
    private readonly neutralDirectory: string,
  ) {}

  private sessionIds(job: Job, kind: TurnRequest["role"], project?: string | null) {
    const parts = [this.config.team, this.config.botUser, kind];
    if (kind !== "main") parts.push(job.conversation);
    if (kind === "project" && project) parts.push(project);
    const suffix = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
    return { current: "ein-" + suffix, legacy: "hogu-" + suffix };
  }

  private primary(job: Job): SessionRef | undefined {
    const ids = this.sessionIds(job, "conversation");
    return this.queue.session(ids.current) ?? this.queue.session(ids.legacy);
  }

  private registered(id: string): boolean {
    return Object.hasOwn(this.config.projects, id);
  }

  private forProject(job: Job, project: string, resolved = false): Target {
    if (!this.registered(project)) throw new DispatchHold("The selected project is not registered.");
    const existing = this.primary(job);
    const primaryProject = this.queue.projectFor(job.conversation);
    const secondary = (existing !== undefined || primaryProject !== undefined) && primaryProject !== project;
    if (secondary) return { stage: resolved ? "resolved-project" : "project", project };
    return { stage: resolved ? "resolved-conversation" : "conversation", project };
  }

  initial(job: Job): Target {
    // Treat unknown/malformed explicit selectors and free-form filesystem paths as ambiguous.
    const tags = Array.from(job.text.matchAll(/(?:^|[\s(`])project:([^\s)`]*)/giu),
      match => (match[1] ?? "").replace(/[.,;!?]+$/u, ""));
    const ids = [...new Set(tags)];
    const explicit = ids[0];
    const directoryHint = /(?:^|[\s(`"'=<])(?:~\/|\.{1,2}\/|\/(?!\/)|[a-z]:[\\/])/iu.test(job.text);
    if (directoryHint || ids.length > 1 || (explicit !== undefined && !this.registered(explicit))) {
      return { stage: "main", project: null };
    }
    const existing = this.primary(job);
    if (existing) {
      return explicit ? this.forProject(job, explicit)
        : { stage: "conversation", project: this.queue.projectFor(job.conversation) ?? null };
    }
    const channel = Object.entries(this.config.projects).find(([, p]) => p.channels.includes(job.channel))?.[0];
    if (explicit && channel && explicit !== channel) return { stage: "main", project: null };
    const project = explicit ?? channel;
    if (project) return this.forProject(job, project);
    return { stage: Object.keys(this.config.projects).length ? "main" : "conversation", project: null };
  }

  reserve(job: Job, target: Target): SessionRef {
    const kind = role(target.stage);
    const ids = this.sessionIds(job, kind, target.project);
    const resumed = job.sessionId === ids.current || job.sessionId === ids.legacy
      ? this.queue.session(job.sessionId) : undefined;
    const existing = resumed ?? this.queue.session(ids.current) ?? this.queue.session(ids.legacy);
    const id = existing?.id ?? ids.current;
    let cwd: string;
    if (kind !== "main" && target.project !== null) {
      const project = this.registered(target.project) ? this.config.projects[target.project] : undefined;
      if (!project) throw new DispatchHold("The recorded project is no longer registered.");
      cwd = project.path;
      if (kind === "conversation") this.queue.bindProject(job.conversation, target.project);
    } else {
      cwd = ensurePrivateDirectory(join(this.neutralDirectory, id));
    }
    const session = existing ?? this.queue.reserveSession({ id, runner: this.runner, cwd });
    if (session.cwd !== cwd) throw new DispatchHold("The configured directory differs from the session reservation.");
    return session;
  }

  request(job: Job, target: Target, session: SessionRef): TurnRequest {
    const projects = Object.entries(this.config.projects).map(([id, project]) => ({ id, channels: project.channels }));
    const fields = {
      text: job.text, sender: job.user, channel: job.channel, thread: job.threadTs,
      context: job.context, project: job.project, registeredProjects: projects,
    };
    const answers = jobClarifications(job);
    const legacyInput = () => JSON.stringify({
      ...fields, history: this.queue.history(job.conversation, job.id, this.config.ownerUser),
      clarifications: answers.map(({ question, answer }) => ({ question, answer })),
    });
    const threadWindow = job.threadTs === null ? undefined : {
      channel: job.channel, threadTs: job.threadTs,
      after: this.queue.threadCursor(job.conversation, session.id), before: threadCutoff(job, answers),
    };
    const after = threadWindow?.after;
    const clarifications = after ? answers.filter(entry => entry.ts && compareSlackTs(entry.ts, after) > 0) : answers;
    const input = threadWindow ? JSON.stringify({ ...fields, clarifications }) : legacyInput();
    const stage = target.stage;
    const kind = role(stage);
    const memoryScope = this.memoryScope(job, kind, target.project, session);
    return { jobId: job.id, attempt: job.attempt, role: kind, input, session, memoryScope,
      ...(threadWindow ? { threadWindow, legacyInput } : {}),
      projects: projects.map(p => p.id), canAssign: kind === "main" || stage === "conversation",
      canEscalate: stage === "conversation" || stage === "project" };
  }

  private memoryScope(job: Job, kind: TurnRequest["role"], projectId: string | null, session: SessionRef): MemoryScope | null {
    if (kind === "main" || job.user !== this.config.ownerUser) return null;
    if (projectId === null) return { kind: "workspace" };
    const { EIN_HOME, EIN_CONFIG } = snifferEnvironment();
    // reserve() pinned this session to the selected registration before the turn was claimed.
    return { kind: "project", projectId, projectRoot: session.cwd, workingDirectory: session.cwd,
      command: { executable: join(EIN_HOME, "bin", "sniffer"),
        env: { EIN_HOME, EIN_CONFIG, EIN_SNIFFER_EXPECT_PROJECT: projectId, EIN_SNIFFER_DELEGATION: "assigned" } } };
  }

  apply(job: Job, target: Target, request: TurnRequest, result: TurnResult): void {
    const next = (t: Target) => this.queue.advance(job.id, job.attempt, { ...t, sessionId: null });
    switch (result.kind) {
      case "assign": {
        if (!request.canAssign) throw new DispatchHold("Assignment is not available for this turn.");
        const resolved = target.stage.startsWith("review-");
        const route = this.forProject(job, result.project, resolved);
        if (request.role === "conversation" && role(route.stage) !== "project") {
          throw new DispatchHold("The conversation session requested its own project again.");
        }
        next({ ...route, context: job.context });
        return;
      }
      case "escalate":
        if (!request.canEscalate) throw new DispatchHold("Main review is not available for this turn.");
        next({ stage: request.role === "project" ? "review-project" : "review-conversation",
          project: target.project, context: result.reason });
        return;
      case "ask":
        this.queue.ask(job.id, job.attempt, result.question);
        return;
      case "reply":
        if (target.stage === "review-project" || target.stage === "review-conversation") {
          next({ stage: target.stage === "review-project" ? "resolved-project" : "resolved-conversation",
            project: target.project, context: JSON.stringify({ review: job.context, decision: result.text }) });
        } else if (request.role === "project") {
          next({ stage: "summary", project: this.queue.projectFor(job.conversation) ?? null,
            context: JSON.stringify({ project: target.project, result: result.text }) });
        } else {
          if (target.stage === "main" && !this.primary(job)) {
            this.reserve(job, { stage: "conversation", project: null });
          }
          this.queue.answer(job.id, job.attempt, result.text);
        }
        return;
      default: return result satisfies never;
    }
  }
}
