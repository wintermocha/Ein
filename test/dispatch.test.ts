import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import { createRunTurn } from "../src/agent-turn";
import type { TurnResult } from "../src/turn-contract";
import { createHarness } from "./fixtures/dispatch";

test("the agent prompt follows the assigned memory scope across projects, review and neutral turns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ein-scope-"));
  const savedHome = process.env.EIN_HOME;
  const savedConfig = process.env.EIN_CONFIG;
  const env = { EIN_HOME: join(directory, "home with spaces"), EIN_CONFIG: join(directory, "slack.json") };
  process.env.EIN_HOME = relative(process.cwd(), env.EIN_HOME);
  process.env.EIN_CONFIG = relative(process.cwd(), env.EIN_CONFIG);
  const frames: unknown[] = [];
  const h = createHarness(createRunTurn({
    async ensure(ref) { return ref; },
    async prompt(_ref, prompt) {
      const header = /^EIN_TURN (.+)$/mu.exec(prompt)?.[1];
      if (!header) throw new Error("Missing turn header");
      const frame = z.object({ jobId: z.number(), attempt: z.number(), resultFile: z.string(),
        role: z.string(), memoryScope: z.unknown() }).parse(JSON.parse(header));
      frames.push(frame.memoryScope);
      const result = frame.role === "project" && frames.length === 2
        ? { kind: "escalate", reason: "review this handoff" } : { kind: "reply", text: "done" };
      writeFileSync(frame.resultFile, JSON.stringify({ jobId: frame.jobId, attempt: frame.attempt, result }));
    },
  }, directory));
  try {
    const scope = (projectId: string) => ({ kind: "project", projectId,
      projectRoot: "/repo/" + projectId, workingDirectory: "/repo/" + projectId,
      command: { executable: join(env.EIN_HOME, "bin", "sniffer"), env: { ...env, EIN_SNIFFER_EXPECT_PROJECT: projectId } } });
    const web = scope("web");
    const api = scope("api");
    const root = h.send("work here", { channel: "CWEB" });
    await h.dispatcher.idle();
    h.settle();
    h.send("project:api check this too", { channel: "CWEB", root });
    await h.dispatcher.idle();
    expect(frames).toEqual([web, api, null, api, web]);
    h.settle();
    h.send("continue here", { channel: "CWEB", root, user: "UOTHER" });
    await h.dispatcher.idle();
    expect(frames).toHaveLength(5);
    h.settle();
    const neutral = h.send("general question");
    await h.dispatcher.idle();
    h.settle();
    h.send("continue", { root: neutral });
    await h.dispatcher.idle();
    expect(frames.slice(5)).toEqual([null, { kind: "workspace" }]);
  } finally {
    if (savedHome === undefined) delete process.env.EIN_HOME;
    else process.env.EIN_HOME = savedHome;
    if (savedConfig === undefined) delete process.env.EIN_CONFIG;
    else process.env.EIN_CONFIG = savedConfig;
    await h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit projects and dedicated channels route directly; each DM thread and the top-level DM have separate owners", async () => {
  const h = createHarness(async req => ({ kind: "reply", text: String(req.jobId) }));
  try {
    const root = h.send("project:web implement search", { channel: "DCHAT" });
    h.send("project:api check status", { channel: "DCHAT", root });
    h.send("investigate logs", { channel: "CAPI" });
    await h.dispatcher.idle();

    const deliveries = h.settle();
    expect(deliveries).toHaveLength(3);
    expect(deliveries.filter(row => row.channel === "DCHAT").map(row => row.threadTs))
      .toEqual(expect.arrayContaining([null, root]));
    expect(h.calls.map(req => req.role)).toEqual(["conversation", "conversation", "conversation"]);
    expect(h.calls.map(req => req.session.cwd).sort()).toEqual(["/repo/api", "/repo/api", "/repo/web"]);
    expect(new Set(h.calls.map(req => req.session.id)).size).toBe(3);

    h.send("continue", { channel: "DCHAT" });
    await h.dispatcher.idle();
    expect(h.calls[3]?.session.id).toBe(h.calls.find(req => req.session.cwd === "/repo/web")?.session.id);
  } finally {
    await h.close();
  }
});

test("a busy thread keeps FIFO and one logical session while three distinct workers run concurrently", async () => {
  const release = Promise.withResolvers<void>();
  const busy = Promise.withResolvers<void>();
  let peak = 0;
  let active = 0;
  const h = createHarness(async req => {
    active++;
    peak = Math.max(peak, active);
    if (active === 3) busy.resolve();
    await release.promise;
    active--;
    return { kind: "reply", text: String(req.jobId) };
  });
  try {
    const root = h.send("project:web first");
    h.send("second", { root });
    h.send("third", { root });
    for (let i = 0; i < 4; i++) h.send(`project:api independent ${i}`);
    await busy.promise;
    expect(h.calls).toHaveLength(3);
    expect(h.calls.some(req => req.input.includes("second") || req.input.includes("third"))).toBe(false);
    release.resolve();
    await h.dispatcher.idle();
    expect(peak).toBe(3);
    const thread = h.calls.filter(req => req.session.cwd === "/repo/web");
    expect(thread.map(req => req.jobId)).toEqual([1, 2, 3]);
    expect(new Set(thread.map(req => req.session.id)).size).toBe(1);
  } finally {
    release.resolve();
    await h.close();
  }
});

test("an additional project works in its own session and its result stays in the original Slack thread", async () => {
  const h = createHarness(async req => {
    if (req.role === "conversation" && req.input.includes("also inspect backend") && !req.input.includes("BACKEND_RESULT")) {
      return { kind: "assign", project: "api" };
    }
    if (req.role === "project") return { kind: "reply", text: "BACKEND_RESULT" };
    return { kind: "reply", text: req.input.includes("BACKEND_RESULT") ? "BACKEND_RESULT reviewed" : "web ready" };
  });
  try {
    const root = h.send("project:web inspect front end");
    await h.dispatcher.idle();
    h.settle();
    h.send("also inspect backend", { root });
    await h.dispatcher.idle();
    const replies = h.settle();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ channel: "CSHARED", threadTs: root });
    expect(replies[0]?.text).toContain("BACKEND_RESULT");
    expect(h.calls.filter(req => req.role === "project").map(req => req.session.cwd)).toEqual(["/repo/api"]);
    h.send("continue here", { root });
    await h.dispatcher.idle();
    expect(h.calls.at(-1)?.session).toEqual(h.calls[0]?.session);
    expect(h.calls.filter(req => req.role === "main")).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("restart reuses an interrupted turn's reservation and its saved native runner identity after config changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ein-dispatch-"));
  const file = join(dir, "state.sqlite");
  const entered = Promise.withResolvers<void>();
  const first = createHarness(async (req, signal, update) => {
    update({ ...req.session, nativeId: "session-before-restart", paneId: "pane-before-restart" });
    entered.resolve();
    return new Promise<TurnResult>(resolve => signal.addEventListener("abort", () => {
      resolve({ kind: "reply", text: "obsolete late result" });
    }, { once: true }));
  }, { file, runner: "omo" });
  try {
    first.send("project:web keep this context");
    await entered.promise;
    await first.close();
    const reopened = createHarness(async () => ({ kind: "reply", text: "recovered" }), { file, runner: "codex" });
    try {
      reopened.dispatcher.wake();
      await reopened.dispatcher.idle();
      expect(reopened.calls).toHaveLength(1);
      const original = first.calls[0];
      expect(reopened.calls[0]).toMatchObject({
        jobId: original?.jobId, attempt: original?.attempt,
        session: { id: original?.session.id, runner: "omo", nativeId: "session-before-restart" },
      });
      expect(reopened.settle().map(row => row.text)).toEqual(["recovered"]);
      reopened.send("project:api new deployment");
      await reopened.dispatcher.idle();
      expect(reopened.calls.at(-1)?.session.runner).toBe("codex");
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator holds identify missing runner and timeout without persisting untrusted error text", async () => {
  const { RunnerError } = await import("../src/runners");
  const { TurnError } = await import("../src/turn-files");
  const issues = [
    new RunnerError("Missing executable on PATH: omo."),
    new TurnError("Turn result timed out; prompt delivery may already have occurred."),
    new Error("caller pasted SECRET-BEARER-DATA"),
    new RunnerError("private history SECRET-BEARER-DATA"),
  ];
  const h = createHarness(async req => { throw issues[req.jobId - 1]; });
  try {
    for (const _ of issues) h.send("project:web request");
    await h.dispatcher.idle();
    const reasons = issues.map((_, index) => h.state.jobs.get(index + 1)?.reason);
    expect(reasons[0]).toContain("omo");
    expect(reasons[0]).toContain("PATH");
    expect(reasons[1]).toContain("timed out");
    expect(reasons.every(reason => reason && !reason.includes("SECRET"))).toBe(true);
    expect(h.settle()).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("after restart the shared main finishes its interrupted turn before an older newly clarified request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ein-main-resume-"));
  const file = join(dir, "state.sqlite");
  const busy = Promise.withResolvers<void>();
  const first = createHarness(async (req, signal) => {
    if (req.jobId === 1) return { kind: "ask", question: "어느 프로젝트인가요?" };
    busy.resolve();
    return new Promise<TurnResult>(resolve => signal.addEventListener("abort", () => {
      resolve({ kind: "reply", text: "after stop" });
    }, { once: true }));
  }, { file });
  try {
    const root = first.send("로그인 실패 확인");
    await first.dispatcher.idle();
    expect(first.settle().map(d => d.threadTs)).toEqual([root]);
    first.send("이전 배포 확인");
    await busy.promise;
    first.send("웹 프로젝트", { root });
    await first.close();
    const resumed = createHarness(async () => ({ kind: "reply", text: "처리 완료" }), { file });
    try {
      await resumed.dispatcher.idle();
      expect(resumed.calls.map(req => req.jobId)).toEqual([2, 1]);
      expect(resumed.calls[0]?.attempt).toBe(first.calls[1]?.attempt);
      expect(resumed.calls[1]?.input).toContain("웹 프로젝트");
      expect(resumed.settle()).toHaveLength(2);
    } finally {
      await resumed.close();
    }
  } finally {
    await first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
