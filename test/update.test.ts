import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const releases = "https://github.com/wintermocha/Ein/releases";
const previous = "main-9-aaaaaaa";
const latest = "main-10-bbbbbbb";
const oldBinary = "#!/bin/sh\necho old\n";
const newBinary = "#!/bin/sh\necho new\n";
let dir: string;
let home: string;
let binary: string;
let marker: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ein-update-"));
  home = join(dir, "custom Ein home");
  binary = join(home, "bin", "ein");
  marker = join(home, "release-tag");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(binary, oldBinary, { mode: 0o755 });
  writeFileSync(marker, previous + "\n");
  writeFileSync(join(dir, "redirect"), releases + "/tag/" + latest);
  writeFileSync(join(dir, "new-ein"), newBinary, { mode: 0o755 });
  writeFileSync(join(dir, "install-release.sh"), `#!/bin/sh
set -eu
test "$#" = 1 && test "$1" = --update || exit 1
test "$EIN_UPDATE_TO" = "${latest}"
if [ -f "$EIN_HOME/release-tag" ]; then
  test "$EIN_UPDATE_FROM" = "$(cat "$EIN_HOME/release-tag")"
else
  test "$EIN_UPDATE_FROM" = unversioned
fi
cp "$FIXTURES/new-ein" "$EIN_HOME/bin/ein"
printf '%s\\n' "$EIN_UPDATE_TO" > "$EIN_HOME/release-tag"
`);
  writeFileSync(join(dir, "curl"), `#!/bin/sh
set -eu
output=
format=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) shift; output=$1 ;;
    --write-out|-w) shift; format=$1 ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  '${releases}/latest')
    test -f "$FIXTURES/redirect" || exit 7
    if [ "$format" = '%{redirect_url}' ]; then cat "$FIXTURES/redirect"; fi ;;
  *) printf '%s\\n' "$url" >> "$FIXTURES/downloads"
     test "$url" = '${releases}/download/${latest}/install-release.sh'
     cp "$FIXTURES/install-release.sh" "$output" ;;
esac
`, { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function update() {
  return Bun.spawnSync([process.execPath, "src/cli.ts", "update"], {
    env: {
      ...process.env, HOME: dir, EIN_HOME: home, EIN_CONFIG: join(home, "config.json"),
      PATH: dir + ":" + process.env.PATH, TMPDIR: dir, FIXTURES: dir,
    },
    stdout: "pipe", stderr: "pipe",
  });
}

test.each([previous, "source", "unversioned"])("updates %s to the latest release once", installed => {
  if (installed === "unversioned") rmSync(marker);
  else writeFileSync(marker, installed + "\n");
  const config = join(home, "config.json");
  writeFileSync(config, '{"owner":"example"}\n');

  const first = update();
  expect(first.exitCode, first.stderr.toString()).toBe(0);
  expect(readFileSync(binary, "utf8")).toBe(newBinary);
  expect(readFileSync(marker, "utf8")).toBe(latest + "\n");
  expect(readFileSync(config, "utf8")).toBe('{"owner":"example"}\n');

  const second = update();
  expect(second.exitCode, second.stderr.toString()).toBe(0);
  expect(readFileSync(join(dir, "downloads"), "utf8")).toBe(releases + "/download/" + latest + "/install-release.sh\n");
});

test("keeps the installed version when GitHub points to an older release", async () => {
  writeFileSync(marker, "main-11-ccccccc\n");

  const result = update();
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(binary, "utf8")).toBe(oldBinary);
  expect(readFileSync(marker, "utf8")).toBe("main-11-ccccccc\n");
  expect(await Bun.file(join(dir, "downloads")).exists()).toBe(false);
});

test.each(["failed lookup", "malformed tag", "missing installer", "rejected update"])("preserves the installation after a %s", async failure => {
  if (failure === "failed lookup") rmSync(join(dir, "redirect"));
  if (failure === "malformed tag") writeFileSync(join(dir, "redirect"), releases + "/tag/main-bad");
  if (failure === "missing installer") rmSync(join(dir, "install-release.sh"));
  if (failure === "rejected update") writeFileSync(join(dir, "install-release.sh"), 'test "$#" = 0\n');

  const result = update();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString().trim()).not.toBe("");
  expect(readFileSync(binary, "utf8")).toBe(oldBinary);
  expect(readFileSync(marker, "utf8")).toBe(previous + "\n");
  expect(await Bun.file(join(dir, "downloads")).exists()).toBe(failure === "missing installer" || failure === "rejected update");
});

test("requires an existing installation before downloading an update", async () => {
  rmSync(binary);
  rmSync(marker);

  expect(update().exitCode).not.toBe(0);
  expect(await Bun.file(binary).exists()).toBe(false);
  expect(await Bun.file(join(dir, "downloads")).exists()).toBe(false);
});
