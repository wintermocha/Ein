#!/bin/sh
# Run after bun run package on the host Mac.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
bun_bin=$(command -v bun)
case "$(uname -m)" in
  arm64) archive=ein-darwin-arm64 ;;
  x86_64) archive=ein-darwin-amd64 ;;
  *) exit 1 ;;
esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export HOME="$scratch/user"
export CODEX_HOME="$scratch/codex-profile"
mkdir -p "$HOME" "$CODEX_HOME"
export EIN_HOME="$scratch/ein's home"
export EIN_CONFIG="$scratch/missing-config.json"
export PATH="$EIN_HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset EIN_APP_TOKEN EIN_BOT_TOKEN EIN_SNIFFER_BIN
cd "$scratch"
tar -xzf "$root/dist/$archive.tar.gz"
grep -q '  ./release-tag$' "$archive/SHA256SUMS"
printf '%s\n' "${EIN_RELEASE_TAG:-source}" | cmp - "$archive/release-tag"
diff -r "$root/.agents/skills/codemode" "$archive/.agents/skills/codemode"
if EIN_UPDATE_FROM=unversioned EIN_UPDATE_TO=wrong-release sh "$archive/install.sh"; then exit 1; fi
test ! -e "$EIN_HOME"
mkdir feature-cli
cat > feature-cli/codex <<'CLI'
#!/bin/sh
printf '%s\n' "$*" >> "$HOME/codex-calls"
test "$*" = 'features list' || exit 1
printf '%s\n' 'code_mode_only  under development  false' "$FEATURE_ROW"
CLI
chmod +x feature-cli/codex
install_with_features() {
  FEATURE_ROW="$1" PATH="$scratch/feature-cli:$PATH" sh "$archive/install.sh" > install-output
}
hint='codex features enable code_mode'
(
  export EIN_UPDATE_FROM=unversioned EIN_UPDATE_TO="$(cat "$archive/release-tag")"
  install_with_features 'code_mode  under development  false'
)
grep -Fq "$hint" install-output
skill="$HOME/.agents/skills/codemode"
test "$(readlink "$skill")" = "$EIN_HOME/skills/codemode"
diff -r "$archive/.agents/skills/codemode" "$skill/"
cmp "$archive/release-tag" "$EIN_HOME/release-tag"
if EIN_UPDATE_FROM=unversioned sh "$archive/install.sh"; then exit 1; fi
test ! -e "$EIN_HOME/.install.lock"
test -f "$EIN_HOME/memory/store/.ein-store.json"
test -f "$EIN_HOME/adapters/claude-mod/.claude-plugin/plugin.json"
test -f "$EIN_HOME/adapters/antigravity/sniffer-memory-agent.md"
test -f "$EIN_HOME/adapters/codex/hooks.example.json"
sniffer version > sniffer-version.json
ein sniffer version > ein-sniffer-version.json
cmp sniffer-version.json ein-sniffer-version.json
ein --help
"$bun_bin" "$root/test/fixtures/onboarding-memory.ts" "$EIN_HOME/bin/ein"
ein setup --manifest > manifest.json
ruby -rjson -e 'abort unless JSON.parse(File.read(ARGV[0])) == JSON.parse(File.read(ARGV[1]))' \
  manifest.json "$root/examples/slack-manifest.json"
EIN_CONFIG="$root/examples/config.json" ein check
mkdir folder-1 folder-2
sniffer project add --id folder-1 --path "$scratch/folder-1"
sniffer project add --id folder-2 --path "$scratch/folder-2"
fixture="$root/sniffer/examples/memories/projects/folder-1/m-local-port.md"
(cd folder-1 && sniffer memory save --input "$fixture" --if-revision new --request-id smoke-save)
mkdir folder-1/indexer
(cd folder-1 && ein delegate --cwd indexer -- ein memory search --query PORT) > delegated-search.json
ruby -rjson -e '
  result = JSON.parse(File.read(ARGV.fetch(0)))
  abort unless result.fetch("project_id") == "folder-1"
  abort unless result.fetch("hits").map { |hit| hit.fetch("memory").fetch("id") } == ["m-local-port"]
' delegated-search.json
(cd folder-1 && ein delegate --project folder-2 --cwd ../folder-2 -- ein memory search --query PORT) > reassigned-search.json
ruby -rjson -e 'result = JSON.parse(File.read(ARGV.fetch(0))); abort unless result.fetch("project_id") == "folder-2" && result.fetch("hits").empty?' reassigned-search.json
if (cd folder-1 && EIN_SNIFFER_EXPECT_PROJECT=folder-1 EIN_SNIFFER_DELEGATION=assigned \
    sniffer delegate --project folder-2 --cwd ../folder-2 -- touch "$scratch/unexpected-child"); then exit 1; fi
test ! -e "$scratch/unexpected-child"
install_with_features 'code_mode  under development  true'
if grep -Fq "$hint" install-output; then exit 1; fi
install_with_features ''
if grep -Fq "$hint" install-output; then exit 1; fi
test "$(cat "$HOME/codex-calls")" = "$(printf '%s\n' 'features list' 'features list' 'features list')"
test ! -e "$EIN_HOME/backups"
codex_hooks="$CODEX_HOME/hooks.json"
agy_hooks="$HOME/.gemini/config/hooks.json"
test ! -e "$codex_hooks" && test ! -e "$agy_hooks"
mkdir -p "$HOME/.gemini/config"
printf '%s\n' '{"description":"existing Codex hooks","hooks":{}}' > "$codex_hooks"
printf '%s\n' '{"existing-host":{"hooks":{}}}' > "$agy_hooks"
sh "$archive/install.sh" --with-hooks
grep -q 'existing Codex hooks' "$codex_hooks"
grep -q 'existing-host' "$agy_hooks"
ruby -rjson -rshellwords -e '
  def commands(value)
    case value
    when Hash then value.values_at("command").compact + value.values.flat_map { |item| commands(item) }
    when Array then value.flat_map { |item| commands(item) }
    else []
    end
  end
  ARGV.each do |path|
    hooks = commands(JSON.parse(File.read(path)))
    abort "Missing hooks in #{path}" if hooks.empty?
    hooks.each do |command|
      binary = File.realpath(File.join(ENV.fetch("EIN_HOME"), "bin", "sniffer"))
      abort "Invalid hook executable" unless Shellwords.split(command).first(2) == [binary, "hook"]
    end
  end
' "$codex_hooks" "$agy_hooks"
shasum -a 256 "$codex_hooks" "$agy_hooks" > installed-hooks.sha256
sh "$archive/install.sh" --with-hooks
shasum -a 256 -c installed-hooks.sha256
conflict_user="$scratch/conflicting-user"
conflict_codex="$scratch/conflicting-codex"
mkdir -p "$conflict_user/.gemini/config" "$conflict_codex" "$conflict_user/.agents/skills/codemode"
printf '%s\n' 'my own skill' > "$conflict_user/.agents/skills/codemode/SKILL.md"
printf '%s\n' '{"description":"local","hooks":{}}' > "$conflict_codex/hooks.json"
cp "$conflict_codex/hooks.json" codex-before.json
printf '%s\n' '{"sniffer-memory":{"custom":true}}' > "$conflict_user/.gemini/config/hooks.json"
if HOME="$conflict_user" CODEX_HOME="$conflict_codex" sh "$archive/install.sh" --with-hooks; then exit 1; fi
test "$(cat "$conflict_user/.agents/skills/codemode/SKILL.md")" = 'my own skill'
test ! -e "$conflict_user/.agents/skills/codemode/codemode"
cmp "$conflict_codex/hooks.json" codex-before.json
(cd folder-1 && ein memory search --query PORT) > same-project.json
grep -q 'm-local-port' same-project.json
(cd folder-2 && sniffer memory search --query PORT) > other-project.json
if grep -q 'm-local-port' other-project.json; then exit 1; fi
printf 'local edits\n' >> "$EIN_HOME/adapters/codex/hooks.example.json"
sh "$archive/install.sh"
grep -q 'local edits' "$EIN_HOME"/backups/*/adapters/codex/hooks.example.json
cmp "$archive/adapters/codex/hooks.example.json" "$EIN_HOME/adapters/codex/hooks.example.json"
# Force a failed rename after the executable has already been upgraded.
printf '#!/bin/sh\necho previous-version\n' > previous-ein
cp previous-ein "$EIN_HOME/bin/ein"
printf '%s\n' main-1-1234567 > previous-tag
cp previous-tag "$EIN_HOME/release-tag"
printf 'modified hook\n' >> "$EIN_HOME/adapters/codex/hooks.example.json"
mkdir fail-rename
cat > fail-rename/mv <<'WRAPPER'
#!/bin/sh
case "$1" in */.install.*/release-tag) exit 1 ;; esac
exec /bin/mv "$@"
WRAPPER
chmod +x fail-rename/mv
if EIN_UPDATE_FROM="$(cat previous-tag)" EIN_UPDATE_TO="$(cat "$archive/release-tag")" \
    PATH="$scratch/fail-rename:$PATH" sh "$archive/install.sh"; then exit 1; fi
cmp previous-tag "$EIN_HOME/release-tag"
cmp previous-ein "$EIN_HOME/bin/ein"
grep -q 'modified hook' "$EIN_HOME/adapters/codex/hooks.example.json"
test ! -e "$EIN_HOME/.install.lock"
printf 'tamper test\n' >> "$archive/release-tag"
if EIN_HOME="$scratch/rejected" sh "$archive/install.sh"; then exit 1; fi
test ! -e "$scratch/rejected"
printf '%s\n' 'PASS: install, memory initialization, standalone CLIs, compiled setup, optional idempotent host hooks, project visibility, reinstall, backup, failed-upgrade rollback and integrity check.'
