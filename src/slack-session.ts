import { realpathSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import type { AttachedMessage } from "./attached-inbox";
import { resolveAttachedPane, type AttachedPane } from "./attached-pane";
import { agentEinCommand, einCommand } from "./cli-invocation";
import { loadConfig, SetupError, type Config } from "./config";
import { listen } from "./live";
import { runSender } from "./sender";
import { sessionRequest, startSessionSocket, type SessionRequest } from "./slack-session-ipc";
import type { ReceiverState } from "./state";
import { snifferEnvironment } from "./sniffer";
import { orchestrationRunner } from "./worker-task";

export type AttachedTarget = { readonly id: string; readonly pane?: AttachedPane };

function turnPrompt(message: AttachedMessage, push: boolean, command: string): string {
  const worker = orchestrationRunner();
  const frame = JSON.stringify({ channel: message.channel, thread: message.threadTs, message: message.text })
    .replace(/[\u007f-\u009f\u2028\u2029]/gu, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return [
    "Ein received this Slack message from the configured owner for this open agent session.",
    "Answer in the original conversation. Keep unrelated private conversations out of the reply.",
    worker ? `If this needs delegation, run ${command} task "task description" in the connected directory and use the returned worker result.`
      : "Handle this request directly. Ein orchestration is off in the connected directory.",
    `Send your answer as literal text on stdin to ${command} slack reply ${message.receipt} --stdin in the connected directory.`,
    ...(push ? [] : ["After replying, repeat your slack next command in this agent session to wait for the next message."]),
    `Slack input: ${frame}`,
  ].join("\n");
}

/** The receiver owns both the durable inbox and Slack credentials. Agents only receive reply receipts. */
export async function serveAttached(target: AttachedTarget, state: ReceiverState, config: Config,
  botToken: string, signal: AbortSignal, onFatal: (error: SetupError) => void) {
  const inbox = state.inbox;
  if (!inbox) throw new SetupError("Slack 세션 수신함을 열 수 없습니다.");
  const command = agentEinCommand(snifferEnvironment());
  const lifetime = new AbortController();
  const active = AbortSignal.any([signal, lifetime.signal]);
  const events = new EventEmitter();
  const wake = () => { events.emit("change"); };
  let pulling = false;
  const handle = async (request: SessionRequest, clientSignal: AbortSignal) => {
    if (request.kind === "read") return turnPrompt(inbox.read(request.receipt), true, command);
    if (request.kind === "reply") {
      inbox.reply(request.receipt, request.text);
      wake();
      return "Slack 답변을 전송 대기열에 넣었습니다.";
    }
    if (request.client !== target.id) throw new SetupError("연결할 때 지정한 에이전트 세션에서 slack next를 실행하세요.");
    if (pulling) throw new SetupError("이 에이전트는 이미 다음 Slack 메시지를 기다리고 있습니다.");
    const waiting = AbortSignal.any([active, clientSignal]);
    pulling = true;
    try {
      for (;;) {
        waiting.throwIfAborted();
        const message = inbox.claim(true);
        if (message) return turnPrompt(message, Boolean(target.pane), command);
        await once(events, "change", { signal: waiting });
      }
    } finally { pulling = false; }
  };
  const ipc = await startSessionSocket(config.stateFile, process.cwd(), handle, active);
  const push = async (pane: AttachedPane) => {
    while (!active.aborted) {
      const message = inbox.claim(false);
      // If the foreground agent exits during submission, this line is a shell no-op.
      // The actual Slack input only travels over the private socket.
      if (message) await pane.prompt(`: Ein received a Slack message. Read it using this shell command and follow its reply instructions. ${command} slack read ${message.receipt}`, active);
      else await once(events, "change", { signal: active });
    }
  };
  function failed(error: unknown) {
    if (!active.aborted) onFatal(error instanceof SetupError ? error :
      new SetupError("Slack 세션 연결이 중단됐습니다. 같은 에이전트를 다시 연결해서 slack next로 보류된 요청을 확인하세요."));
  }
  const sender = runSender({ queue: state.jobs, botUser: config.botUser, botToken, signal: active,
    onIssue: reason => console.error("Ein: " + reason) }).catch(failed);
  const pushing = target.pane && push(target.pane).catch(failed);
  console.error(target.pane ? "Ein: 열려 있는 에이전트에 Slack을 연결했습니다." :
    "Ein: Slack을 연결했습니다. 같은 에이전트에서 slack next를 실행하세요.");
  return { wake, async stop() {
    lifetime.abort();
    await Promise.all([ipc.close(), sender, pushing]);
  } };
}

async function targetFor(args: string[], signal: AbortSignal): Promise<AttachedTarget> {
  if (args.length && !(args.length === 2 && ["--pane", "--session"].includes(args[0] ?? "") && args[1])) {
    throw new SetupError("slack connect/next [--pane PANE_ID | --session NAME]");
  }
  const paneId = args.length ? (args[0] === "--pane" ? args[1] : undefined) : process.env.HERDR_PANE_ID;
  if (paneId) {
    const pane = await resolveAttachedPane(paneId, signal);
    if (realpathSync(pane.cwd) !== realpathSync(".")) throw new SetupError("에이전트와 같은 작업 폴더에서 연결하세요.");
    return { id: pane.id, pane };
  }
  const name = args[1] ?? process.env.EIN_AGENT_SESSION ?? process.env.CODEX_THREAD_ID ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!name || !/^[\w.-]{1,128}$/u.test(name)) {
    throw new SetupError("에이전트 세션을 식별할 수 없습니다. connect와 next에 같은 --session NAME을 지정하세요.");
  }
  return { id: "session:" + name };
}

export async function slackSessionCommand(configPath: string, args: string[], controller: AbortController) {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    console.log([
      `${einCommand} slack connect [--pane PANE_ID | --session NAME]  현재 에이전트에 Slack 연결`,
      `${einCommand} slack next [--pane PANE_ID | --session NAME]     같은 세션에서 요청 기다리기`,
      `${einCommand} slack read RECEIPT                              에이전트에 도착한 요청 읽기`,
      `${einCommand} slack reply RECEIPT TEXT|--stdin                 원래 DM 또는 스레드에 답장`,
      "connect를 실행한 폴더에서 next와 reply를 사용하세요. herdr pane에는 메시지가 자동 전달됩니다.",
    ].join("\n"));
    return;
  }
  const config = loadConfig(configPath);
  if (action === "read" && rest.length === 1 && rest[0]) {
    console.log(await sessionRequest(config.stateFile, process.cwd(), { kind: "read", receipt: rest[0] }, controller.signal));
    return;
  }
  if (action === "connect" || action === "next") {
    const target = await targetFor(rest, controller.signal);
    if (action === "connect") return listen(config, controller, target);
    console.log(await sessionRequest(config.stateFile, process.cwd(), { kind: "next", client: target.id }, controller.signal));
    return;
  }
  if (action === "reply" && rest.length === 2 && rest[0] && rest[1]) {
    const text = rest[1] === "--stdin" ? await Bun.stdin.text() : rest[1];
    console.log(await sessionRequest(config.stateFile, process.cwd(), { kind: "reply", receipt: rest[0], text }, controller.signal));
    return;
  }
  throw new SetupError("slack connect/next [--pane PANE_ID | --session NAME] 또는 slack reply RECEIPT TEXT|--stdin을 사용하세요.");
}
