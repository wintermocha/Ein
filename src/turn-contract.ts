import { z } from "zod";
import type { SessionRef } from "./runners";

export const turnResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("assign"), project: z.string().min(1) }),
  z.strictObject({ kind: z.literal("ask"), question: z.string().trim().min(1).max(40_000) }),
  z.strictObject({ kind: z.literal("reply"), text: z.string().trim().min(1).max(40_000) }),
  z.strictObject({ kind: z.literal("escalate"), reason: z.string().trim().min(1).max(40_000) }),
]);

export type TurnResult = z.infer<typeof turnResultSchema>;
export type MemoryScope =
  | { readonly kind: "workspace" }
  | {
      readonly kind: "project";
      readonly projectId: string;
      readonly projectRoot: string;
      readonly workingDirectory: string;
      readonly command: {
        readonly executable: string;
        readonly env: { readonly EIN_CONFIG: string; readonly EIN_HOME: string; readonly EIN_SNIFFER_EXPECT_PROJECT: string };
      };
    };

export type TurnRequest = {
  readonly jobId: number;
  readonly attempt: number;
  readonly session: SessionRef;
  readonly role: "main" | "conversation" | "project";
  readonly memoryScope: MemoryScope | null;
  readonly input: string;
  readonly projects: readonly string[];
  readonly canAssign: boolean;
  readonly canEscalate: boolean;
};

export type RunTurn = (
  request: TurnRequest,
  signal: AbortSignal,
  onUpdate: (ref: SessionRef) => void,
) => Promise<TurnResult>;
