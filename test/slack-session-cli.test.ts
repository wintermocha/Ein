import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { installFixtureHerdr } from "./fixtures/attached-herdr";

const cli = join(import.meta.dir, "../src/cli.ts");
const wire = join(import.meta.dir, "fixtures/attached-slack.ts");
const input = z.object({ channel: z.string(), thread: z.string(), message: z.string() });

function readTurn(prompt: string) {
  const receipt = prompt.match(/\bslack reply ([\w-]+) --stdin/u)?.[1];
  const frame = prompt.split("\n").find(line => line.startsWith("Slack input: "));
  if (!frame || !receipt) throw new Error("The agent did not receive a Slack turn and reply command: " + prompt);
  return { receipt, ...input.parse(JSON.parse(frame.slice("Slack input: ".length))) };
}

function sessionFixture(rootText = "<@UBOT> Stand by for the inventory.") {
  const folder = realpathSync(mkdtempSync("/tmp/ein-attached-cli-"));
  const bin = join(folder, "bin");
  const env = { PATH: bin, HOME: folder, EIN_HOME: join(folder, ".ein"), EIN_CONFIG: join(folder, "config 'copy'.json"),
    EIN_SNIFFER_DELEGATION: "none" };
  async function run(args: string[], stdin = "") {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
      cwd: folder, env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", timeout: 4000, killSignal: "SIGKILL",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  }
  async function success(args: string[], stdin?: string) {
    const result = await run(args, stdin);
    expect(result.code, result.err).toBe(0);
    return result.out;
  }

  function connect(target = ["--session", "lead"], expectedPosts = 3) {
    const ready = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const posts: unknown[] = [];
    const acks: string[] = [];
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", wire, cli, "slack", "connect", ...target], {
      cwd: folder, env: { ...env, FIXTURE: folder, FIXTURE_ROOT_TEXT: rootText, EIN_APP_TOKEN: "xapp-test", EIN_BOT_TOKEN: "xoxb-test" },
      stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 12000, killSignal: "SIGKILL",
      ipc(message: unknown) {
        if (typeof message === "string") {
          acks.push(message);
          if (message === "root") ready.resolve();
        } else {
          posts.push(message);
          if (posts.length === expectedPosts) complete.resolve();
        }
      },
    });
    const diagnostics = new Response(child.stderr).text();
    const until = (event: Promise<void>) => Promise.race([event, child.exited.then(async code => {
      throw new Error(`Receiver exited (${code}): ${await diagnostics}`);
    })]);
    return { child, posts, acks, ready: () => until(ready.promise), complete: () => until(complete.promise) };
  }

  mkdirSync(bin);
  writeFileSync(env.EIN_CONFIG, JSON.stringify({ team: "TTEST", appId: "AEIN", botUser: "UBOT", ownerUser: "UOWNER",
    watchChannels: ["CPROJECT"], otherUserReplyRate: { CPROJECT: 1 }, stateFile: "state.sqlite" }));
  return { folder, bin, run, success, connect };
}

test("an attached lead recovers a Slack turn and delegates a follow-up in the same thread only while enabled", async () => {
  const { folder, bin, run, success, connect } = sessionFixture();
  const next = () => success(["slack", "next", "--session", "lead"]);
  const reply = (receipt: string, text: string) => success(["slack", "reply", receipt, "--stdin"], text);
  let receiver: ReturnType<typeof connect> | undefined;
  try {
    writeFileSync(join(folder, "inventory.txt"), "ready\nwaiting\nready\n");
    writeFileSync(join(bin, "codex"), `#!${process.execPath}
if (process.argv.includes("mcp")) { console.log("[]"); process.exit(0); }
if (!process.argv.includes("exec") || (await Bun.stdin.text()) !== "Count ready items") process.exit(9);
const lines = (await Bun.file("inventory.txt").text()).split("\\n");
const text = "Ready items: " + lines.filter(line => line === "ready").length;
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
console.log(JSON.stringify({ type: "turn.completed" }));
`, { mode: 0o700 });

    receiver = connect();
    await receiver.ready();
    expect((await run(["slack", "next", "--session", "another-lead"])).code).toBe(1);
    const first = readTurn(await next());
    expect(first.message).toBe("<@UBOT> Stand by for the inventory.");
    expect(receiver.acks).toEqual(["outsider", "root"]);
    receiver.child.kill("SIGKILL");
    await receiver.child.exited;

    receiver = connect();
    await receiver.ready();
    const recovered = await next();
    expect(readTurn(recovered)).toEqual(first);
    expect(recovered).not.toMatch(/\btask ["']/u);
    const confirmation = "Standing by.\n목록을 확인하겠습니다.";
    await reply(first.receipt, confirmation);
    await reply(first.receipt, confirmation);

    await success(["orchestration", "enable", "codex"]);
    const second = await next();
    expect(second).toMatch(/\btask ["']/u);
    const work = readTurn(second);
    expect(work.message).toBe("Count ready items");
    const answer = await success(["task", work.message]);
    await reply(work.receipt, answer);

    await success(["orchestration", "disable"]);
    const third = await next();
    expect(third).not.toMatch(/\btask ["']/u);
    const last = readTurn(third);
    expect(last.message).toBe("Confirm the handoff");
    expect((await run(["task", last.message])).code).toBe(1);
    await reply(last.receipt, "Handoff confirmed.");
    await receiver.complete();
    expect(receiver.posts).toEqual([confirmation, "Ready items: 2", "Handoff confirmed."].map(text =>
      ({ channel: "CPROJECT", thread: "1810000000.000001", text })));
    expect(receiver.acks).toEqual(["outsider", "root", "followup-1", "followup-2"]);
    receiver.child.kill("SIGTERM");
    expect(await receiver.child.exited).toBe(0);
  } finally {
    if (receiver && receiver.child.exitCode === null) receiver.child.kill("SIGKILL");
    await receiver?.child.exited;
    rmSync(folder, { recursive: true, force: true });
  }
}, 24000);

test("an attached pane receives only the local read command and cannot reopen a completed Slack turn", async () => {
  const text = "<@UBOT> triage PANE_PRIVATE_6231\nReview the notes first.";
  const { folder, bin, run, success, connect } = sessionFixture(text);
  const herdr = Bun.serve({ unix: join(folder, "herdr.sock"), fetch: () => new Response() });
  const delivered = Promise.withResolvers<void>();
  const watcher = watch(folder, (_event, file) => {
    if (file === "delivered") delivered.resolve();
  });
  let receiver: ReturnType<typeof connect> | undefined;
  try {
    installFixtureHerdr(bin);
    receiver = connect(["--pane", "w2:p7"], 1);
    await receiver.ready();
    await Promise.race([delivered.promise, receiver.child.exited.then(code => { throw new Error("No pane notice: " + code); })]);
    const { text: notice } = z.object({ text: z.string() }).parse(JSON.parse(readFileSync(join(folder, "delivered"), "utf8")));
    expect(notice).not.toContain("PANE_PRIVATE_6231");
    expect(notice).not.toContain("xoxb-test");
    const command = notice.match(/(\/usr\/bin\/env .+? slack read ([\w-]+))\b/u);
    if (!command?.[1] || !command[2]) throw new Error("Pane did not receive a runnable read command");
    const reader = Bun.spawn(["/bin/sh", "-c", command[1]], {
      cwd: folder, env: { HOME: folder, PATH: bin }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4000,
    });
    const [code, out, err] = await Promise.all([reader.exited, new Response(reader.stdout).text(), new Response(reader.stderr).text()]);
    expect(code, err).toBe(0);
    const turn = readTurn(out);
    expect(turn).toEqual({ receipt: command[2], channel: "CPROJECT", thread: "1810000000.000001", message: text });
    await success(["slack", "reply", turn.receipt, "--stdin"], "Reviewed the notes.");
    await receiver.complete();
    expect(receiver.posts).toEqual([{ channel: "CPROJECT", thread: turn.thread, text: "Reviewed the notes." }]);
    const stale = await run(["slack", "read", turn.receipt]);
    expect(stale.code).toBe(1);
    expect(stale.out).toBe("");
  } finally {
    watcher.close();
    if (receiver?.child.exitCode === null) receiver.child.kill("SIGTERM");
    await receiver?.child.exited;
    await herdr.stop(true);
    rmSync(folder, { recursive: true, force: true });
  }
}, 16000);
