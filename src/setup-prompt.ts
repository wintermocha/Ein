import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { SetupError } from "./config";
import { einCommand } from "./cli-invocation";

export function hasSetupTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

export async function askSetup(question: string, signal: AbortSignal, hidden = false): Promise<string> {
  if (!hasSetupTerminal()) throw new SetupError(`직접 사용하는 터미널에서 ${einCommand} setup을 실행하세요.`);
  signal.throwIfAborted();
  const closed = new AbortController();
  const output = hidden ? new Writable({ write(_data, _encoding, done) { done(); } }) : process.stderr;
  const prompt = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const interrupt = () => closed.abort();
  prompt.once("SIGINT", interrupt);
  prompt.once("close", interrupt);
  try {
    process.stderr.write(question + " ");
    return (await prompt.question("", { signal: AbortSignal.any([signal, closed.signal]) })).trim();
  } finally {
    prompt.close();
    if (hidden) process.stderr.write("\n");
  }
}
