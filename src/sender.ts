import { setTimeout as delay } from "node:timers/promises";
import type { DeliveryStore } from "./delivery-store";
import { postDelivery, reconcileDelivery, type SenderConnection } from "./sender-http";

type SenderOptions = SenderConnection & {
  readonly queue: Pick<DeliveryStore, "claimDelivery" | "settleDelivery">;
  readonly onSettled?: () => void;
  readonly onIssue?: (reason: string) => void;
};

/** Claim before calling Slack. A process stopped at any later point leaves a recoverable claim. */
export async function deliverNext(options: SenderOptions): Promise<boolean> {
  if (options.signal.aborted) return false;
  const delivery = options.queue.claimDelivery(Date.now());
  if (!delivery) return false;
  const outcome = delivery.mode === "send"
    ? await postDelivery(options, delivery)
    : await reconcileDelivery(options, delivery);
  options.queue.settleDelivery(delivery.id, outcome);
  options.onSettled?.();
  if (outcome.kind === "held") options.onIssue?.(`delivery held (${outcome.reason})`);
  if (outcome.kind === "uncertain" && delivery.mode === "send") options.onIssue?.("delivery awaiting confirmation");
  return true;
}

export async function runSender(options: SenderOptions): Promise<void> {
  while (!options.signal.aborted) {
    if (await deliverNext(options)) continue;
    try {
      await delay(250, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}
