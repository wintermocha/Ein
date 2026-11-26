import type { Config, Runner } from "./config";
import type { Job, JobQueue } from "./job-queue";
import { DispatchHold, SessionRouting, nonOwnerReply, role, savedTarget, type Target } from "./session-routing";
import { RunnerError, type SessionRef } from "./runners";
import { turnResultSchema, type RunTurn } from "./turn-contract";
import { TurnError } from "./turn-files";

function holdReason(error: unknown, runner: Runner): string {
  if (error instanceof DispatchHold) return error.message;
  if (error instanceof RunnerError) {
    for (const executable of [runner, "herdr"]) {
      if (error.message === `Missing executable on PATH: ${executable}.`) {
        return `Missing executable on PATH: ${executable}. Install it before resuming this session.`;
      }
    }
    if (error.message.startsWith("herdr ")) return "Check that the Ein herdr server is running and its pane is available.";
    if (/identity|native session|missing.*pane|ambiguous pane|moved/iu.test(error.message)) {
      return `Verify the saved ${runner} session identity and herdr pane before resuming.`;
    }
    return `Check the ${runner} session's readiness in its reserved pane.`;
  }
  if (error instanceof TurnError) {
    if (error.message.includes("timed out")) return "Turn result timed out. Check whether the original prompt completed.";
    if (error.message.includes("reservation")) return "Check the saved turn reservation before resuming.";
    return "Check the result file's format, job, attempt, and permitted decision.";
  }
  return "Agent turn requires review.";
}

type DispatchOptions = {
  readonly queue: JobQueue;
  readonly config: Config;
  readonly runner: Runner;
  readonly neutralDirectory: string;
  readonly runTurn: RunTurn;
  readonly onChange?: () => void;
  readonly onIssue?: (message: string) => void;
  readonly onFatal?: (error: Error) => void;
};

export class Dispatcher {
  private readonly routing: SessionRouting;
  private readonly lifetime = new AbortController();
  private readonly running = new Map<number, { readonly main: boolean; readonly task: Promise<void> }>();
  private scanTask: Promise<void> | undefined;
  private failure: Error | undefined;

  constructor(private readonly options: DispatchOptions) {
    this.routing = new SessionRouting(options.queue, options.config, options.runner, options.neutralDirectory);
  }

  wake(): void {
    if (this.lifetime.signal.aborted || this.scanTask) return;
    this.scanTask = Promise.resolve().then(() => {
      this.scanTask = undefined;
      if (!this.lifetime.signal.aborted) this.scan();
    }).catch(error => this.fail(error));
  }

  async idle(): Promise<void> {
    this.wake();
    while (this.scanTask || this.running.size) {
      await Promise.race([
        ...(this.scanTask ? [this.scanTask] : []),
        ...Array.from(this.running.values(), lane => lane.task),
      ]);
    }
    if (this.failure) throw this.failure;
  }

  async stop(): Promise<void> {
    this.lifetime.abort();
    await Promise.all([this.scanTask, ...Array.from(this.running.values(), lane => lane.task)]);
  }

  private fail(error: unknown): void {
    if (this.failure) return;
    // Never expose SQLite paths, prompt text or provider output through status logs.
    this.failure = new Error("Could not persist or schedule orchestration work.", { cause: error });
    this.lifetime.abort();
    this.options.onFatal?.(this.failure);
  }

  private changed(): void {
    this.options.onChange?.();
    this.wake();
  }

  private hold(job: Job, reason: string): void {
    this.options.queue.hold(job.id, job.attempt, reason);
    this.options.onIssue?.(`Job ${job.id} is held. ${reason}`);
    this.changed();
  }

  private scan(): void {
    const queue = this.options.queue;
    // On restart a previously submitted main turn owns its session ahead of newly eligible requests.
    const jobs = queue.ready().sort((a, b) =>
      Number(b.stage.startsWith("running/")) - Number(a.stage.startsWith("running/")) || a.id - b.id);
    for (const job of jobs) {
      if (this.lifetime.signal.aborted || this.running.has(job.id)) continue;
      if (job.user !== this.options.config.ownerUser) {
        queue.answer(job.id, job.attempt, nonOwnerReply);
        this.changed();
        continue;
      }
      try {
        const target = job.stage === "new" ? this.routing.initial(job) : savedTarget(job);
        const main = role(target.stage) === "main";
        const used = Array.from(this.running.values()).filter(lane => lane.main === main).length;
        if (used >= (main ? 1 : 3)) continue;
        const session = this.routing.reserve(job, target);
        let active = job;
        if (!job.stage.startsWith("running/")) {
          const claimed = queue.advance(job.id, job.attempt, {
            stage: `running/${target.stage}`, project: target.project, sessionId: session.id,
          });
          if (!claimed) continue;
          active = claimed;
        } else if (job.sessionId !== session.id) {
          throw new DispatchHold("The interrupted turn has a different session reservation.");
        }
        this.start(active, target, session, main);
      } catch (error) {
        if (!(error instanceof DispatchHold)) throw error;
        this.hold(job, error.message);
      }
    }
  }

  private start(job: Job, target: Target, session: SessionRef, main: boolean): void {
    const task = Promise.resolve()
      .then(() => this.execute(job, target, session))
      .catch(error => this.fail(error))
      .finally(() => {
        this.running.delete(job.id);
        this.wake();
      });
    this.running.set(job.id, { main, task });
  }

  private async execute(job: Job, target: Target, session: SessionRef): Promise<void> {
    const { queue, runTurn } = this.options;
    const signal = this.lifetime.signal;
    if (signal.aborted) return;
    const request = this.routing.request(job, target, session);
    let threadDelivered = true;
    let raw: unknown;
    try {
      raw = await runTurn(request, signal, ref => {
        if (signal.aborted) return;
        if (ref.id !== session.id || ref.runner !== session.runner || ref.cwd !== session.cwd) {
          throw new DispatchHold("Runner returned an inconsistent session identity.");
        }
        try {
          queue.updateSession(ref);
        } catch (error) {
          this.fail(error);
          throw error;
        }
      }, () => { threadDelivered = false; });
    } catch (error) {
      if (!signal.aborted) this.hold(job, holdReason(error, session.runner));
      return;
    }
    if (signal.aborted) return;
    const current = queue.get(job.id);
    if (current?.status !== "active" || current.attempt !== job.attempt || current.sessionId !== session.id) return;
    const result = turnResultSchema.safeParse(raw);
    if (!result.success) {
      this.hold(job, "Agent returned an invalid decision.");
      return;
    }
    try {
      const apply = () => this.routing.apply(job, target, request, result.data);
      if (request.threadWindow && threadDelivered) {
        queue.withThreadCursor(job.conversation, session.id, request.threadWindow.before, apply);
      } else {
        apply();
      }
      this.changed();
    } catch (error) {
      if (!(error instanceof DispatchHold)) throw error;
      this.hold(job, error.message);
    }
  }
}
