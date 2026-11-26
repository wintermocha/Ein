import { createInterface } from "node:readline";
import { writeSync } from "node:fs";
import { z } from "zod";
import { SetupError, type Config } from "./config";
import { ReceiverState } from "./state";

const callback = z.object({ type: z.literal("event_callback"), team_id: z.string(), event: z.object({ type: z.string() }).passthrough() });

export function writeRecord(line: string): void {
  const buffer = Buffer.from(`${line}\n`);
  for (let offset = 0; offset < buffer.length;) {
    offset += writeSync(1, buffer, offset, buffer.length - offset);
  }
}

export async function replay(config: Config): Promise<void> {
  const state = new ReceiverState(":memory:", config.team, config.botUser);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let number = 0;
  try {
    for await (const line of lines) {
      number++;
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch { throw new SetupError(`Invalid JSON at line ${number}.`); }
      const result = callback.safeParse(raw);
      if (!result.success) throw new SetupError(`Expected an Events API callback at line ${number}.`);
      if (result.data.team_id === config.team) {
        state.consume(result.data.event, config);
        state.drain(writeRecord);
      }
    }
  } finally {
    lines.close();
    state.close();
  }
}
