import ky from "ky";
import { z } from "zod";
import { SetupError } from "./config";
import { listenSocket, SocketFailure } from "./socket";

const userId = z.string().regex(/^[UW][A-Z0-9]+$/);
const dmId = z.string().regex(/^D[A-Z0-9]+$/);
const identity = z.object({ ok: z.literal(true), team_id: z.string().regex(/^T[A-Z0-9]+$/), user_id: userId });
const directMessage = z.object({
  type: z.literal("message"), channel_type: z.literal("im"), channel: dmId, user: userId, text: z.string(),
  subtype: z.never().optional(), bot_id: z.never().optional(), bot_profile: z.never().optional(), app_id: z.never().optional(),
  edited: z.never().optional(), hidden: z.never().optional(), thread_ts: z.never().optional(),
});
const installations = z.array(z.object({
  team_id: z.string().nullish(), user_id: z.string().nullish(), is_bot: z.boolean(),
}));
export async function setupIdentity(botToken: string, signal: AbortSignal) {
  let raw: unknown;
  try {
    raw = await ky.post("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      timeout: 15_000, redirect: "error", retry: 0,
    }).json();
  } catch {
    throw new SetupError("Slack auth.test 요청을 완료하지 못했습니다.");
  }
  const result = identity.safeParse(raw);
  if (!result.success) throw new SetupError("Slack auth.test에 실패했습니다. 봇 토큰을 확인하세요.");
  return { team: result.data.team_id, botUser: result.data.user_id };
}

type SetupSocket = {
  readonly appId: string;
  readonly appToken: string;
  readonly team: string;
  readonly botUser: string;
  readonly code: string;
  readonly signal: AbortSignal;
  readonly onReady: () => void;
};

export async function waitForSetupDm(options: SetupSocket) {
  const done = new AbortController();
  const signal = AbortSignal.any([options.signal, done.signal, AbortSignal.timeout(5 * 60_000)]);
  let owner: { ownerUser: string; ownerDm: string } | undefined;
  let mismatch = false;
  let ready = false;
  try {
    await listenSocket({
      appId: options.appId, appToken: options.appToken, signal,
      onReady() {
        if (!ready) options.onReady();
        ready = true;
      },
      onEvent(event, team, authorizations) {
        if (team !== options.team || signal.aborted || owner || mismatch) return;
        const dm = directMessage.safeParse(event);
        if (!dm.success || dm.data.text !== options.code || dm.data.user === options.botUser) return;
        const authorized = installations.safeParse(authorizations);
        if (authorized.success && authorized.data.some(a =>
          a.team_id === options.team && a.is_bot && a.user_id === options.botUser)) {
          owner = { ownerUser: dm.data.user, ownerDm: dm.data.channel };
        } else {
          mismatch = true;
        }
        // Let the SDK send its envelope acknowledgment before closing the connection.
        queueMicrotask(() => done.abort());
      },
      onRateLimited() {}, onHealthy() {}, onIssue() {},
    });
  } catch (error) {
    if (error instanceof SocketFailure) throw new SetupError(error.message);
    throw new SetupError("Slack Socket Mode 연결을 완료하지 못했습니다.");
  }
  if (options.signal.aborted) throw new SetupError("Slack 연결 확인을 중단했습니다.");
  if (mismatch) throw new SetupError("봇 토큰과 앱 토큰이 같은 Slack 앱과 워크스페이스에 속하는지 확인하세요.");
  if (!owner) throw new SetupError("Slack DM 확인 시간이 지났습니다. 설정을 다시 실행하세요.");
  return owner;
}
