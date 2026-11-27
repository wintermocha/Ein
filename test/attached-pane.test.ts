import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installFixtureHerdr } from "./fixtures/attached-herdr";

async function exercise(scenario: string) {
  const dir = realpathSync(mkdtempSync("/tmp/ein-attached-"));
  const server = Bun.serve({ unix: join(dir, "herdr.sock"), fetch: () => new Response() });
  try {
    installFixtureHerdr(dir);
    const source = `import {resolveAttachedPane} from "./src/attached-pane"; const signal = AbortSignal.timeout(6000);
      const bound = await resolveAttachedPane(process.env.SCENARIO === "agent-name" ? "existing" : "w2:p7", signal);
      if (process.env.SCENARIO === "reconnect") {
        await Bun.write(process.env.FIXTURE + "/reopened", "yes");
        const reopened = await resolveAttachedPane("w3:p2", signal);
        if (bound.id !== reopened.id) throw Error("Lost durable session identity after reconnect");
        await reopened.prompt("Reply\\nhello\\u001b\\u0003 world", signal);
      } else await bound.prompt("Reply\\nhello\\u001b\\u0003 world", signal);`;
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
      env: { ...process.env, FIXTURE: dir, SCENARIO: scenario, PATH: dir, EIN_BOT_TOKEN: "receiver-only" },
      stdout: "ignore", stderr: "pipe",
    });
    const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    const output = join(dir, "delivered");
    return { code, error, delivered: existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null };
  } finally {
    await server.stop(true);
    rmSync(dir, { force: true, recursive: true });
  }
}

for (const scenario of ["busy", "unnamed", "reconnect"]) {
  test(`delivers sanitized text to the bound foreground agent once ready (${scenario})`, async () => {
    const out = await exercise(scenario);
    expect(out.error).toBe("");
    expect(out.code).toBe(0);
    expect(out.delivered).toEqual({ text: "Reply hello   world", whileBusy: false });
  }, 9000);
}
for (const [scenario, reason] of [["replacement", "bound herdr agent changed"], ["suspended", "verified foreground process"],
  ["other-directory", "same working directory"], ["blocked", "not ready for a prompt"],
  ["missing-native", "native session ID"], ["agent-name", "Specify the herdr pane ID"], ["exited-before-write", "herdr agent prompt failed"]] as const) {
  test(`withholds the prompt from a different target (${scenario})`, async () => {
    const out = await exercise(scenario);
    expect(out.code).not.toBe(0);
    expect(out.delivered).toBeNull();
    expect(out.error).toContain(reason);
  });
}
