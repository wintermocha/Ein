import { randomUUID } from "node:crypto";
import { SetupError } from "./config";
import type { OutgoingDelivery } from "./delivery-store";
import { postDelivery, reconcileDelivery, type SenderConnection } from "./sender-http";
import type { SetupStore } from "./setup-store";

type ReplyOptions = SenderConnection & { readonly ownerDm: string };

function retryLater(at: number) {
  const seconds = Math.max(1, Math.ceil((at - Date.now()) / 1000));
  return new SetupError(`${seconds}초 후 같은 --confirm 명령을 다시 실행하세요.`);
}

export async function confirmSetupReply(store: SetupStore, options: ReplyOptions): Promise<void> {
  const progress = store.read();
  const { reply: saved, ...pairing } = progress;
  if (saved?.sent) return;
  if (saved?.retryAt && saved.retryAt > Date.now()) throw retryLater(saved.retryAt);
  if (saved?.readAfter && saved.readAfter > Date.now()) throw retryLater(saved.readAfter);

  const attempt = { id: saved?.id ?? randomUUID(), createdAt: saved?.createdAt ?? Date.now() };
  const mode = !saved || saved.retryAt !== undefined ? "send" : "reconcile";
  const delivery: OutgoingDelivery = {
    ...attempt, mode, channel: options.ownerDm, threadTs: null, text: "연결됐어요",
    ...(saved?.cursor ? { cursor: saved.cursor } : {}),
  };
  // Once sending starts, only a receipt or an unambiguous refusal can settle the attempt.
  if (mode === "send") store.save({ ...pairing, reply: attempt });
  const result = mode === "send" ? await postDelivery(options, delivery) : await reconcileDelivery(options, delivery);
  switch (result.kind) {
    case "sent":
      store.save({ ...pairing, reply: { ...attempt, sent: true } });
      return;
    case "retry":
      store.save({ ...pairing, reply: { ...attempt, retryAt: result.at } });
      throw retryLater(result.at);
    case "uncertain":
      if (mode === "reconcile") {
        store.save({ ...pairing, reply: {
          ...attempt, ...(result.cursor ? { cursor: result.cursor } : {}),
          readAfter: result.at,
        } });
        throw retryLater(result.at);
      }
      throw new SetupError("Slack DM 전송 결과를 확인하지 못했습니다. 같은 --confirm 명령으로 전송 기록을 확인하세요.");
    case "held":
      if (mode === "send") {
        store.save(pairing);
        throw new SetupError(`Slack에서 DM 전송을 거절했습니다 (${result.reason}). 원인을 해결한 후 --confirm을 다시 실행하세요.`);
      }
      // Start at the newest messages on the next scan, including after an expired cursor.
      store.save({ ...pairing, reply: attempt });
      if (result.reason === "delivery_unconfirmed") {
        throw new SetupError("Slack DM에서 답장을 찾지 못했습니다. 잠시 후 --confirm으로 다시 확인하세요. DM에 답장이 없는 것을 직접 확인하고 새로 보내려면 --pair부터 시작하세요.");
      }
      throw new SetupError(`Slack DM 기록을 확인하지 못했습니다 (${result.reason}). 원인을 해결한 후 --confirm을 다시 실행하세요.`);
  }
}
