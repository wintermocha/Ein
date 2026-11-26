type Gap = { readonly oldest: string; readonly latest: string };

type CheckpointOptions = {
  readonly read: () => string | undefined;
  readonly save: (ts: string) => void;
  readonly readLimitEnd: () => number | undefined;
  readonly saveRateLimit: (oldest: string, end: number) => void;
  readonly clearLimit: () => void;
  readonly recover: (window: Gap, signal: AbortSignal) => Promise<boolean>;
  readonly now: () => string;
  readonly onFatal: (error: unknown) => void;
};

type Connection = {
  readonly controller: AbortController;
  gap: Gap | undefined;
  retryAt: number;
};

const heartbeatIntervalSeconds = 30;
const recoveryRetrySeconds = 300;

export class Checkpoints {
  readonly #options: CheckpointOptions;
  #cursor: string | undefined;
  #limitEnd: number | undefined;
  #connection: Connection | undefined;
  #active: Promise<void> | undefined;
  #stopped = false;

  constructor(options: CheckpointOptions) {
    this.#options = options;
    this.#cursor = options.read();
    this.#limitEnd = options.readLimitEnd();
  }

  ready(): void {
    if (this.#stopped || this.#connection) return;
    const latest = this.#options.now();
    const oldest = this.#cursor;
    this.#connection = {
      controller: new AbortController(),
      gap: this.#limitEnd === undefined && oldest && Number(oldest) < Number(latest)
        ? { oldest, latest } : undefined,
      retryAt: 0,
    };
    if (oldest === undefined) this.#persist(latest);
    this.#schedule();
  }

  disconnected(): void {
    const previous = this.#connection;
    this.#connection = undefined;
    previous?.controller.abort();
  }

  rateLimited(minute: number): void {
    if (this.#stopped) return;
    const oldest = this.#cursor !== undefined && Number(this.#cursor) <= minute
      ? this.#cursor : minute.toFixed(6);
    const end = Math.max(this.#limitEnd ?? 0, minute + 60);
    if (oldest === this.#cursor && end === this.#limitEnd) return;
    // The transport ACKs only after this synchronous transaction succeeds.
    this.#options.saveRateLimit(oldest, end);
    this.#cursor = oldest;
    this.#limitEnd = end;
    if (this.#connection) {
      this.disconnected();
      this.ready();
    }
  }

  tick(): void {
    if (!this.#connection) return;
    if (this.#connection.gap || this.#limitEnd !== undefined) {
      this.#schedule();
      return;
    }
    const latest = this.#options.now();
    if (Number(latest) - Number(this.#cursor) >= heartbeatIntervalSeconds) {
      this.#persist(latest);
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.disconnected();
    await this.#active;
  }

  #schedule(): void {
    const connection = this.#connection;
    if (!connection || this.#active) return;
    const latest = this.#options.now();
    if (Number(latest) < Math.max(connection.retryAt, this.#limitEnd ?? 0)) return;
    if (!connection.gap && this.#limitEnd !== undefined && this.#cursor !== undefined) {
      if (Number(this.#cursor) > Number(latest)) return;
      connection.gap = { oldest: this.#cursor, latest };
    }
    const gap = connection.gap;
    if (!gap) return;
    this.#active = this.#fill(connection, gap).finally(() => {
      this.#active = undefined;
      // A new hello may have arrived while an aborted request was winding down.
      if (this.#connection !== connection) this.#schedule();
    });
  }

  async #fill(connection: Connection, gap: Gap): Promise<void> {
    try {
      const complete = await this.#options.recover(gap, connection.controller.signal);
      if (this.#connection !== connection) return;
      if (complete) {
        if (!this.#persist(gap.latest)) return;
        if (this.#limitEnd !== undefined) {
          this.#options.clearLimit();
          this.#limitEnd = undefined;
        }
        connection.gap = undefined;
      } else {
        connection.retryAt = Number(this.#options.now()) + recoveryRetrySeconds;
      }
    } catch (error) {
      if (connection.controller.signal.aborted && error instanceof Error && error.name === "AbortError") return;
      this.#fail(error);
    }
  }

  #persist(ts: string): boolean {
    try {
      this.#options.save(ts);
      this.#cursor = ts;
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  #fail(error: unknown): void {
    this.#stopped = true;
    this.disconnected();
    this.#options.onFatal(error);
  }
}
