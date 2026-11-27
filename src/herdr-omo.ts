import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { redactCredentials } from "./redaction";

const nativeState = z.object({
  sessionId: z.string().uuid(), sessionFile: z.string(), isStreaming: z.boolean(),
  isCompacting: z.boolean(), paused: z.boolean().optional(),
  pendingMessageCount: z.number().optional(), pendingDialogs: z.array(z.unknown()).optional(), pendingQuestions: z.array(z.unknown()).optional(),
});
const request = z.discriminatedUnion("command", [
  z.object({ command: z.literal("state") }),
  z.object({ command: z.literal("prompt"), nativeId: z.string().uuid(), text: z.string().min(1) }),
]);
export const omoIdentity = z.object({ nativeId: z.string().uuid(), ready: z.boolean(), blocked: z.boolean() });

const toolName = z.string().regex(/^[\w.-]{1,128}$/);
const paneEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start") }),
  z.object({ type: z.literal("agent_settled") }),
  z.object({ type: z.literal("message_update"), assistantMessageEvent: z.object({
    type: z.literal("text_delta"), delta: z.string(),
  }) }),
  z.object({ type: z.literal("message_end") }),
  z.object({ type: z.literal("tool_execution_start"), toolName }),
  z.object({ type: z.literal("tool_execution_end"), toolName, isError: z.boolean() }),
]);

function createPaneObserver() {
  let unfinishedLine = "";
  function show(line: string) {
    console.log(redactCredentials(stripVTControlCharacters(line).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")));
  }
  return (event: unknown) => {
    const parsed = paneEvent.safeParse(event);
    if (!parsed.success) return;
    const data = parsed.data;
    switch (data.type) {
      case "agent_start": show("OMO · 작업 시작"); break;
      case "agent_settled": show("OMO · 작업 종료"); break;
      case "tool_execution_start": show(`OMO · ${data.toolName} 실행`); break;
      case "tool_execution_end": show(`OMO · ${data.toolName} ${data.isError ? "실패" : "완료"}`); break;
      case "message_update": {
        // Redact a whole line because a credential can span multiple deltas.
        const lines = (unfinishedLine + data.assistantMessageEvent.delta).split("\n");
        unfinishedLine = lines.pop() ?? "";
        for (const line of lines) show(line);
        break;
      }
      case "message_end":
        if (unfinishedLine) show(unfinishedLine);
        unfinishedLine = "";
        break;
    }
  };
}

// A pane hosts one RPC process. The private socket persists across orchestrator restarts.
// Its API deliberately exposes only readiness and prompt admission, never a terminal or shell.
async function serve(executable: string, sessionFile: string, socketPath: string) {
  process.umask(0o077);
  const { EIN_BOT_TOKEN, EIN_APP_TOKEN, HOGU_BOT_TOKEN, HOGU_APP_TOKEN, ...env } = process.env;
  const child = Bun.spawn([executable, "--mode", "rpc", "--session", sessionFile], {
    env, stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  type Reply = { success: boolean; data?: unknown };
  const pending = new Map<string, PromiseWithResolvers<Reply>>();
  async function rpc(payload: { type: string; message?: string }) {
    const id = crypto.randomUUID();
    const reply = Promise.withResolvers<Reply>();
    const timer = setTimeout(() => reply.reject(new Error("OMO RPC timed out.")), 25_000);
    pending.set(id, reply);
    try {
      child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
      await child.stdin.flush();
      const result = await reply.promise;
      if (!result.success) throw new Error("OMO refused RPC command.");
      return result.data;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      try {
        const input = request.parse(await req.json());
        const state = nativeState.parse(await rpc({ type: "get_state" }));
        if (state.sessionFile !== sessionFile) return new Response(null, { status: 409 });
        const blocked = !!(state.paused || state.pendingDialogs?.length || state.pendingQuestions?.length);
        const ready = !blocked && !state.isStreaming && !state.isCompacting && !state.pendingMessageCount;
        if (input.command === "state") return Response.json({ nativeId: state.sessionId, ready, blocked });
        if (!ready || input.nativeId !== state.sessionId) return new Response(null, { status: 409 });
        await rpc({ type: "prompt", message: input.text });
        return Response.json({ accepted: true });
      } catch {
        return new Response(null, { status: 503 });
      }
    },
  });
  const response = z.object({ type: z.literal("response"), id: z.string(), success: z.boolean(), data: z.unknown().optional() });
  const observe = createPaneObserver();
  console.log("OMO · Ein 세션 모니터");
  try {
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let partial = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const lines = (partial + chunk.value).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; } // Non-protocol startup notices.
        const result = response.safeParse(parsed);
        if (result.success) pending.get(result.data.id)?.resolve(result.data);
        else observe(parsed);
      }
    }
  } finally {
    for (const call of pending.values()) call.reject(new Error("OMO process exited."));
    child.kill();
    await server.stop(true);
  }
}

export async function runOmoBridge(args: string[]) {
  const [executable, file, socket] = args;
  if (!executable || !file || !socket || args.length !== 3) throw new Error("Invalid OMO bridge arguments.");
  await serve(executable, file, socket);
}

if (import.meta.main) await runOmoBridge(process.argv.slice(2));
