import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createHarness, timestamp } from "./fixtures/dispatch";

test.each([
  ["CSHARED", "어제 로그인 오류를 조사해 줘"],
  ["CWEB", "project:api 배포 확인"],
  ["CWEB", "project:unknown 요청 확인"],
  ["CWEB", "/outside/unregistered 에서 작업해 줘"],
])("new %s request '%s' gives main the candidates and can finish without a repository", async (channel, text) => {
  const h = createHarness(async () => ({ kind: "reply", text: "프로젝트 작업 없이 답합니다." }));
  try {
    const root = h.send(text, { channel });
    await h.dispatcher.idle();
    expect(h.calls).toHaveLength(1);
    const [turn] = h.calls;
    expect(turn?.role).toBe("main");
    expect(turn?.session.cwd.startsWith(`${h.neutralDirectory}/`)).toBe(true);
    expect(turn?.projects.toSorted()).toEqual(["api", "web"]);
    expect(turn?.input).toContain(text);
    expect(h.settle()).toMatchObject([{ channel, threadTs: root, text: "프로젝트 작업 없이 답합니다." }]);
  } finally {
    await h.close();
  }
});

test("a busy shared main serializes its decisions and leaves three independent worker slots available", async () => {
  const mainRelease = Promise.withResolvers<void>();
  const workerRelease = Promise.withResolvers<void>();
  const h = createHarness(async turn => {
    await (turn.role === "main" ? mainRelease.promise : workerRelease.promise);
    return { kind: "reply", text: "완료" };
  });
  try {
    h.send("로그인 실패를 조사해 줘");
    h.send("어제 빌드를 검토해 줘");
    for (let i = 0; i < 4; i++) h.send(`작업 ${i}`, { channel: "CWEB" });
    await Bun.sleep(0);
    expect(h.calls.filter(turn => turn.role === "main")).toHaveLength(1);
    expect(h.calls.filter(turn => turn.role !== "main")).toHaveLength(3);
    workerRelease.resolve();
    await Bun.sleep(0);
    expect(h.settle().filter(delivery => delivery.channel === "CWEB")).toHaveLength(4);
    expect(h.calls.filter(turn => turn.role === "main")).toHaveLength(1);
    mainRelease.resolve();
    await h.dispatcher.idle();
    const decisions = h.calls.filter(turn => turn.role === "main");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.session.id).toBe(decisions[1]?.session.id);
    expect(decisions[0]?.jobId).not.toBe(decisions[1]?.jobId);
    expect(h.settle()).toHaveLength(2);
  } finally {
    mainRelease.resolve();
    workerRelease.resolve();
    await h.close();
  }
});

test("after a repo-free main reply subsequent messages reuse a neutral conversation without routing again", async () => {
  const h = createHarness(async turn => ({ kind: "reply", text: `답변 ${turn.jobId}` }));
  try {
    const root = h.send("이 용어의 뜻이 뭐야?");
    await h.dispatcher.idle();
    h.settle();
    h.send("예시도 알려줘", { root });
    h.send("한 문장으로 요약해 줘", { root });
    await h.dispatcher.idle();
    expect(h.calls.map(turn => turn.role)).toEqual(["main", "conversation", "conversation"]);
    expect(h.calls.every(turn => turn.session.id.startsWith("ein-"))).toBe(true);
    expect(h.calls[1]?.session.id).toBe(h.calls[2]?.session.id);
    expect(h.calls[1]?.session.id).not.toBe(h.calls[0]?.session.id);
    expect(h.calls.every(turn => turn.session.cwd.startsWith(`${h.neutralDirectory}/`))).toBe(true);
    expect(h.calls[1]?.input).toContain("이 용어의 뜻이 뭐야?");
    expect(h.settle()).toMatchObject([{ threadTs: root }, { threadTs: root }]);
  } finally {
    await h.close();
  }
});

test("a persisted legacy conversation keeps its exact reservation", async () => {
  const h = createHarness(async () => ({ kind: "reply", text: "기존 대화를 이어갑니다." }));
  try {
    const root = h.send("이전 작업을 계속해 줘", { channel: "CWEB" });
    const conversation = JSON.stringify(["TTEST", "CWEB", root]);
    const parts = ["TTEST", "UBOT", "conversation", conversation];
    const suffix = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
    const legacyId = "hogu-" + suffix;
    h.state.jobs.reserveSession({ id: legacyId, runner: "omo", cwd: "/repo/web" });
    h.state.jobs.bindProject(conversation, "web");

    await h.dispatcher.idle();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.session).toMatchObject({ id: legacyId, cwd: "/repo/web" });
  } finally {
    await h.close();
  }
});

test.each(["before", "after"])("an owner's reply arriving %s the Slack POST receipt resumes its decision", async timing => {
  const asking = Promise.withResolvers<void>();
  const h = createHarness(async turn => {
    if (turn.role === "main") {
      if (turn.input.includes("OWNER-CONFIRMS-WEB")) return { kind: "assign", project: "web" };
      await asking.promise;
      return { kind: "ask", question: "웹 프로젝트인가요?" };
    }
    return { kind: "reply", text: "선택한 프로젝트를 확인했습니다." };
  });
  try {
    const root = h.send("어제 발생한 오류를 살펴봐 줘");
    await Bun.sleep(0);
    h.send("EARLIER-INDEPENDENT-REQUEST", { root });
    const unrelated = h.send("project:api 진행 상황 알려줘");
    await Bun.sleep(0);
    expect(h.calls.filter(turn => turn.role === "main")).toHaveLength(1);
    expect(h.settle().some(delivery => delivery.threadTs === unrelated)).toBe(true);
    asking.resolve();
    await h.dispatcher.idle();
    const postedAt = timestamp();
    if (timing === "after") {
      expect(h.settle(postedAt)).toMatchObject([{ threadTs: root, text: "웹 프로젝트인가요?" }]);
    }
    h.send("OUTSIDER-APPROVAL", { root, user: "UOTHER" });
    await h.dispatcher.idle();
    expect(h.calls.filter(turn => turn.role === "main")).toHaveLength(1);
    h.send("OWNER-CONFIRMS-WEB", { root });
    if (timing === "before") {
      await h.dispatcher.idle();
      expect(h.calls.filter(turn => turn.role === "main")).toHaveLength(1);
      expect(h.settle(postedAt)).toMatchObject([{ threadTs: root, text: "웹 프로젝트인가요?" }]);
    }
    await h.dispatcher.idle();
    const decisions = h.calls.filter(turn => turn.role === "main");
    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.jobId).toBe(decisions[0]?.jobId);
    expect(decisions[1]?.attempt).toBeGreaterThan(decisions[0]?.attempt ?? 0);
    expect(decisions[1]?.input).toContain("웹 프로젝트인가요?");
    expect(decisions[1]?.input).toContain("OWNER-CONFIRMS-WEB");
    expect(decisions[1]?.input).not.toContain("OUTSIDER-APPROVAL");
    expect(decisions[1]?.input).not.toContain("EARLIER-INDEPENDENT-REQUEST");
    expect(h.calls.some(turn => turn.jobId !== decisions[0]?.jobId && turn.input.includes("EARLIER-INDEPENDENT-REQUEST"))).toBe(true);
    expect(h.calls.some(turn => turn.jobId === decisions[0]?.jobId && turn.session.cwd === "/repo/web")).toBe(true);
    expect(h.settle().some(delivery => delivery.threadTs === root && delivery.text === "선택한 프로젝트를 확인했습니다.")).toBe(true);
  } finally {
    asking.resolve();
    await h.close();
  }
});

test.each(["/outside/unregistered", "constructor"])("a main result naming unregistered '%s' holds that job", async project => {
  const h = createHarness(async () => ({ kind: "assign", project }));
  try {
    h.send("프로젝트를 찾아줘");
    await h.dispatcher.idle();
    expect(h.calls.map(turn => turn.role)).toEqual(["main"]);
    const [turn] = h.calls;
    if (!turn) throw new Error("missing routing turn");
    expect(h.state.jobs.get(turn.jobId)?.status).toBe("held");
    expect(h.settle()).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test("an outsider cannot reuse an owner's repository-capable conversation or authorize its work", async () => {
  const h = createHarness(async () => ({ kind: "reply", text: "owner reply" }));
  try {
    const root = h.send("project:web 작업 상태");
    await h.dispatcher.idle();
    expect(h.calls.map(turn => turn.session.cwd)).toEqual(["/repo/web"]);
    h.settle();
    const before = h.calls.length;
    h.send("project:web 새 작업을 시작해", { root, user: "UOTHER" });
    await h.dispatcher.idle();
    const incoming = h.calls.slice(before);
    expect(incoming.every(turn => turn.session.cwd.startsWith(`${h.neutralDirectory}/`) && !turn.canAssign)).toBe(true);
    expect(h.settle()).toMatchObject([{ threadTs: root }]);
  } finally {
    await h.close();
  }
});

test("a conversation can escalate a decision and resume the same worker after owner clarification", async () => {
  const reason = "두 저장소의 배포 순서를 결정해야 합니다.";
  const question = "웹부터 배포할까요?";
  const decision = "사용자가 웹 우선 처리를 선택했습니다.";
  const h = createHarness(async turn => {
    if (turn.role === "main") return turn.input.includes("웹 우선 동의")
      ? { kind: "reply", text: decision }
      : { kind: "ask", question };
    if (turn.input.includes(decision)) return { kind: "reply", text: "웹부터 진행합니다." };
    return { kind: "escalate", reason };
  });
  try {
    const root = h.send("project:web 배포 검토");
    await h.dispatcher.idle();
    expect(h.calls.map(turn => turn.role)).toEqual(["conversation", "main"]);
    expect(h.calls[1]?.input).toContain(reason);
    expect(h.settle()).toMatchObject([{ threadTs: root, text: question }]);
    h.send("웹 우선 동의", { root });
    await h.dispatcher.idle();
    expect(h.calls.map(turn => turn.role)).toEqual(["conversation", "main", "main", "conversation"]);
    expect(new Set(h.calls.map(turn => turn.jobId)).size).toBe(1);
    expect(h.calls[0]?.session.id).toBe(h.calls[3]?.session.id);
    expect(h.calls[3]?.canEscalate).toBe(false);
    expect(h.settle()).toMatchObject([{ threadTs: root, text: "웹부터 진행합니다." }]);
  } finally {
    await h.close();
  }
});

test("a decision arriving after stop cannot launch another turn or send a reply", async () => {
  const release = Promise.withResolvers<void>();
  const h = createHarness(async () => {
    await release.promise;
    return { kind: "assign", project: "api" };
  });
  try {
    h.send("오류를 확인해 줘");
    await Bun.sleep(0);
    expect(h.calls.map(turn => turn.role)).toEqual(["main"]);
    const stopped = h.dispatcher.stop();
    release.resolve();
    await stopped;
    expect(h.calls.map(turn => turn.role)).toEqual(["main"]);
    expect(h.settle()).toHaveLength(0);
    const [turn] = h.calls;
    if (!turn) throw new Error("missing routing turn");
    expect(h.state.jobs.get(turn.jobId)?.attempt).toBe(turn.attempt);
  } finally {
    release.resolve();
    await h.close();
  }
});
