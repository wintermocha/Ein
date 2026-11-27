import { createHash, randomBytes } from "node:crypto";
import { loadConfig, SetupError } from "./config";
import { askSetup, hasSetupTerminal } from "./setup-prompt";
import { confirmSetupReply } from "./setup-reply";
import { setupIdentity, waitForSetupDm } from "./setup-slack";
import { SetupStore } from "./setup-store";
import { prepareSetupWorkspace, workspaceGuide } from "./setup-workspace";
import { einCommand } from "./cli-invocation";
import { hasMemoryEngine } from "./setup-folders";
import { snifferEnvironment } from "./sniffer";
import manifestJSON from "../examples/slack-manifest.json";

const command = einCommand + " setup";
const apps = "https://api.slack.com/apps";
const manifest = JSON.stringify(manifestJSON, null, 2) + "\n";
const existing = `설정 파일이 이미 있습니다. 현재 설정은 ${einCommand} check로 검사하세요.`;
const connectGuide = `현재 에이전트에 Slack을 연결하려면 작업 폴더에서 ${einCommand} slack connect --help를 확인하세요.`;
const tokenGuide = {
  app: "Basic Information → App-Level Tokens에서 connections:write 권한의 앱 토큰을 만드세요.",
  bot: "OAuth & Permissions에서 워크스페이스에 앱을 설치한 뒤 Bot User OAuth Token을 복사하세요.",
} as const;
const usage = `${command}
  --slack            현재 에이전트에 사용할 Slack 앱과 소유자 DM만 연결
  --memory [폴더 ...]    도구의 기억과 대화를 검토해 가져오기 (Slack 연결 없이 사용 가능)
  --status         현재 단계와 다음 할 일 확인
  --manifest       새 Slack 앱에 붙여넣을 JSON 출력
  --app <App ID>   Slack 앱 선택
  --tokens         내 터미널에서 토큰 입력 또는 교체
  --pair           DM 연결 코드 발급 및 수신 대기
  --confirm <ID>   표시된 Slack 사용자를 소유자로 확정하고 DM 답장 전송`;

function selectApp(store: SetupStore, appId: string): void {
  if (!/^A[A-Z0-9]+$/.test(appId)) throw new SetupError("Basic Information의 App ID(A로 시작)를 입력하세요.");
  if (store.read().appId !== appId) store.save({ appId });
}

function status(store: SetupStore): string {
  if (store.configExists()) return existing;
  const { appId, owner, reply } = store.read();
  if (!appId) return `1/3 Slack 앱 선택 · ${apps}\n새 앱은 From a manifest에서 ${command} --manifest의 JSON으로 만드세요. 기존 앱도 사용할 수 있습니다.\n다음: ${command} --app <App ID>`;
  const missing = (["app", "bot"] as const).filter(kind => !store.getToken(kind));
  if (missing.length) {
    return `2/3 앱 ${appId} · 토큰 준비\n${missing.map(kind => tokenGuide[kind]).join("\n")}\n다음: 내 터미널에서 ${command} --tokens`;
  }
  if (owner && reply && !reply.retryAt) return `3/3 소유자 ${owner.ownerUser} · 확인 답장의 전송 기록과 설정 저장 상태 확인\n다음: ${command} --confirm ${owner.ownerUser}`;
  if (owner) return `3/3 DM 수신 완료 · 워크스페이스 ${owner.team} · 소유자 후보 ${owner.ownerUser}\n본인 계정이면 ${command} --confirm ${owner.ownerUser}\n다른 계정이면 ${command} --pair`;
  return `3/3 앱 ${appId} · DM 연결 확인\n다음: ${command} --pair`;
}

async function inputTokens(store: SetupStore, signal: AbortSignal, replace: boolean): Promise<void> {
  console.log("2/3 토큰 연결 · 토큰은 내 터미널에만 입력하세요. 입력 내용은 표시되지 않습니다.");
  for (const kind of ["app", "bot"] as const) {
    const env = kind === "app" ? "EIN_APP_TOKEN" : "EIN_BOT_TOKEN";
    const label = kind === "app" ? "앱 토큰(xapp-)" : "봇 토큰(xoxb-)";
    if (process.env[env]?.trim()) {
      store.getToken(kind);
      console.log(`${label}은 ${env}에서 읽습니다.`);
      continue;
    }
    const present = Boolean(store.getToken(kind));
    if (present && !replace) continue;
    console.log(tokenGuide[kind]);
    const value = await askSetup(label + (present ? " [Enter로 기존 값 유지]" : ""), signal, true);
    if (value || !present) {
      store.putToken(kind, value);
      const current = store.read();
      if (current.appId && current.owner) store.save({ appId: current.appId });
    }
  }
}

function tokens(store: SetupStore) {
  const appToken = store.getToken("app");
  const botToken = store.getToken("bot");
  if (!appToken || !botToken) throw new SetupError(`내 터미널에서 ${command} --tokens로 두 토큰을 입력하세요.`);
  return { appToken, botToken };
}

async function pair(store: SetupStore, appId: string, signal: AbortSignal): Promise<void> {
  const { appToken, botToken } = tokens(store);
  // A new pairing attempt invalidates any previously captured candidate.
  store.save({ appId });
  console.log("Slack 앱과 봇을 확인합니다. 같은 앱의 listen, slack connect 또는 orchestrate가 실행 중이면 DM 확인 전에 종료하세요.");
  const identity = await setupIdentity(botToken, signal);
  const code = "ein-" + randomBytes(12).toString("hex");
  const match = await waitForSetupDm({ appId, appToken, ...identity, code, signal,
    onReady() {
      console.log(`3/3 워크스페이스 ${identity.team} · 아래 링크에서 Ein에게 이 코드를 DM으로 보내세요.\nhttps://slack.com/app_redirect?app=${appId}&team=${identity.team}\n${code}`);
    },
  });
  store.save({ appId, owner: { ...identity, ...match },
    appTokenHash: createHash("sha256").update(appToken).digest("hex") });
}

async function confirm(store: SetupStore, user: string, signal: AbortSignal, slackOnly = false): Promise<void> {
  const { appId, owner, appTokenHash } = store.read();
  if (!appId || !owner || owner.ownerUser !== user) {
    throw new SetupError(`저장된 DM의 사용자와 일치하지 않습니다. ${command} --status로 확인하세요.`);
  }
  const { appToken, botToken } = tokens(store);
  if (createHash("sha256").update(appToken).digest("hex") !== appTokenHash) {
    throw new SetupError(`DM 확인 후 앱 토큰이 바뀌었습니다. ${command} --pair로 다시 연결하세요.`);
  }
  const identity = await setupIdentity(botToken, signal);
  if (identity.team !== owner.team || identity.botUser !== owner.botUser) {
    throw new SetupError(`DM 확인 후 봇 계정이 바뀌었습니다. 토큰을 확인하고 ${command} --pair를 다시 실행하세요.`);
  }
  await confirmSetupReply(store, { botToken, botUser: identity.botUser, ownerDm: owner.ownerDm, signal });
  const workspace = store.finish({ appId, ...owner });
  console.log(`Slack 연결 완료 · ${owner.team} · 소유자 ${user}\nDM에 답장을 보냈습니다. 이제 ${einCommand} listen으로 메시지를 받을 수 있습니다.`);
  console.log(connectGuide);
  if (slackOnly) return;
  console.log(await prepareSetupWorkspace(workspace, signal));
  console.log(workspaceGuide(workspace));
}

async function wizard(store: SetupStore, signal: AbortSignal, slackOnly: boolean): Promise<void> {
  let { appId } = store.read();
  if (!appId) {
    console.log(`1/3 Slack 앱 선택 · ${apps}`);
    const choice = await askSetup("새 앱을 만드시겠어요? [Enter로 새 앱 / 2로 기존 앱]", signal);
    if (choice === "" || choice === "1") {
      console.log("Create New App → From a manifest에서 워크스페이스를 고르고, JSON 탭에 아래 내용을 붙여넣어 앱을 만드세요.\n" + manifest);
    } else if (choice === "2") {
      console.log(`기존 앱의 App Manifest에서 ${command} --manifest와 비교해 필요한 권한과 이벤트만 추가하세요. 권한 변경 후 앱을 재설치하세요.`);
    } else throw new SetupError("새 앱은 Enter, 기존 앱은 2를 입력하세요.");
    appId = await askSetup("Basic Information → App ID", signal);
    selectApp(store, appId);
  }
  if (!store.getToken("app") || !store.getToken("bot")) await inputTokens(store, signal, false);
  if (!store.read().owner) await pair(store, appId, signal);
  const { owner, reply } = store.read();
  if (!owner) throw new SetupError("등록할 DM을 먼저 확인하세요.");
  if (reply && !reply.retryAt) return confirm(store, owner.ownerUser, signal, slackOnly);
  const answer = await askSetup(`워크스페이스 ${owner.team}의 ${owner.ownerUser} 계정을 소유자로 등록하고 DM으로 답장할까요? [y/N]`, signal);
  if (["y", "yes", "예"].includes(answer.toLowerCase())) await confirm(store, owner.ownerUser, signal, slackOnly);
  else console.log(`확정을 보류했습니다. 이어서 진행하려면 ${command}${slackOnly ? " --slack" : ""}, 다른 계정으로 연결하려면 ${command} --pair를 실행하세요.`);
}

export async function setup(configPath: string, args: string[]): Promise<void> {
  const [action, value] = args;
  if (action === "--help" && args.length === 1) { console.log(usage); return; }
  if (action === "--manifest" && args.length === 1) { process.stdout.write(manifest); return; }
  const store = new SetupStore(configPath);
  if (action === "--status" && args.length === 1) {
    console.log(status(store));
    if (store.configExists()) console.log(workspaceGuide(loadConfig(configPath).herdrWorkspace ?? "Ein"));
    return;
  }
  const memoryOnly = action === "--memory";
  const slackOnly = action === "--slack" && args.length === 1;
  const allowed = args.length === 0 || memoryOnly || slackOnly || (args.length === 1 && (action === "--pair" || action === "--tokens"))
    || (args.length === 2 && (action === "--app" || action === "--confirm"));
  if (!allowed) throw new SetupError(`사용법은 ${command} --help로 확인하세요.`);
  if (!memoryOnly && store.configExists()) { console.log(existing + " " + (slackOnly ? connectGuide : `기억 가져오기는 ${command} --memory로 열 수 있습니다.`)); return; }
  if (memoryOnly && (!hasSetupTerminal() || !hasMemoryEngine())) throw new SetupError("Ein과 Sniffer가 설치된 터미널에서 setup --memory를 실행하세요.");
  if (!action && !hasSetupTerminal()) { console.log(status(store)); return; }
  if (slackOnly && !hasSetupTerminal()) throw new SetupError(`직접 사용하는 터미널에서 ${command} --slack을 실행하세요.`);

  const unlock = store.lock();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const memoryHome = snifferEnvironment().EIN_HOME;
    if (memoryOnly || (!action && hasMemoryEngine() && !store.read().appId && !store.memoryReviewed(memoryHome))) {
      const { importMemory } = await import("./setup-memory");
      const imported = await importMemory(args.slice(1), controller.signal);
      if (imported || !memoryOnly) store.finishMemoryReview(memoryHome);
      if (memoryOnly) return;
      if (imported && !["y", "yes", "예"].includes((await askSetup("Slack 연결도 이어서 할까요? [y/N]", controller.signal)).toLowerCase())) return;
    }
    if (store.configExists()) { console.log(existing); return; }
    if (!action || slackOnly) return await wizard(store, controller.signal, slackOnly);
    if (action === "--app" && value) selectApp(store, value);
    else {
      const { appId } = store.read();
      if (!appId) throw new SetupError(status(store));
      if (action === "--pair") await pair(store, appId, controller.signal);
      else if (action === "--tokens") await inputTokens(store, controller.signal, true);
      else if (action === "--confirm" && value) return await confirm(store, value, controller.signal);
      else throw new SetupError(usage);
    }
    console.log(status(store));
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new SetupError(`설정을 중단했습니다. ${command}으로 이어서 진행하세요.`);
    }
    throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    unlock();
  }
}
