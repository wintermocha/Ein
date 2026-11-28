#!/bin/sh
set -eu
umask 077
with_hooks=false
case "$#:${1:-}" in
  0:) ;;
  1:--with-hooks) with_hooks=true ;;
  *) echo 'Usage: sh install.sh [--with-hooks] (set EIN_HOME to choose an installation directory).' >&2; exit 1 ;;
esac

cd "$(dirname "$0")"
bundle=$(pwd)
target=${EIN_HOME:-"$HOME/.ein"}
case "$target" in /|'') echo 'Choose a user installation directory.' >&2; exit 1 ;; /*) ;; *) echo 'EIN_HOME must be absolute.' >&2; exit 1 ;; esac
if [ ! -f SHA256SUMS ]; then
  echo 'Run install.sh from an extracted Ein release. To build one from source, run bun run package.' >&2
  exit 1
fi
shasum -a 256 -c SHA256SUMS >/dev/null
case "$(uname -s)-$(uname -m)-$(cat platform)" in
  Darwin-arm64-darwin-arm64|Darwin-x86_64-darwin-amd64) ;;
  *) echo "This release targets $(cat platform). Choose a release for this Mac." >&2; exit 1 ;;
esac

mkdir -p "$target/bin" "$target/adapters" "$target/skills"
if ! shlock -p "$$" -f "$target/.install.lock"; then
  echo 'Another Ein installation is running.' >&2
  exit 1
fi
trap 'rm -f "$target/.install.lock"' EXIT
stage=$(mktemp -d "$target/.install.XXXXXXXX")
backup="$target/backups/${stage##*.}"
pending=
restore_on_error() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    for rel in $pending; do
      if [ ! -e "$stage/$rel" ]; then mv "$target/$rel" "$stage/$rel"; fi
      if [ -e "$backup/$rel" ] || [ -L "$backup/$rel" ]; then
        mv "$backup/$rel" "$target/$rel"
      fi
    done
  fi
  rm -rf "$stage"
  rm -f "$target/.install.lock"
  exit "$status"
}
trap restore_on_error EXIT
trap 'exit 1' HUP INT TERM
cp -R "$bundle/bin" "$bundle/adapters" "$stage/"
mkdir "$stage/skills"
cp -R "$bundle/.agents/skills/codemode" "$stage/skills/"
EIN_HOME="$target" "$stage/bin/sniffer" memory init
for rel in bin/ein bin/sniffer adapters/claude-mod adapters/codex adapters/antigravity skills/codemode; do
  current="$target/$rel"
  if [ ! -L "$current" ] && [ -x "$current" ] && diff -qr "$stage/$rel" "$current" >/dev/null; then
    continue
  fi
  pending="$rel $pending"
  if [ -e "$current" ] || [ -L "$current" ]; then
    mkdir -p "$backup/$(dirname "$rel")"
    mv "$current" "$backup/$rel"
  fi
  mv "$stage/$rel" "$current"
done
if [ -d "$backup" ]; then printf 'Previous files saved in %s\n' "$backup"; fi
printf 'Installed ein and sniffer in %s/bin\n' "$target"
printf 'Add %s/bin to your shell PATH to run ein and sniffer.\n' "$target"
printf '기존 도구의 기억을 가져오려면 "%s/bin/ein" setup --memory 를 실행하세요.\n' "$target"
pending=
skill_dir="$HOME/.agents/skills"
installed_skill="$target/skills/codemode"
mkdir -p "$skill_dir"
if [ "$skill_dir/codemode" -ef "$installed_skill" ] || ln -s "$installed_skill" "$skill_dir/" 2>/dev/null; then
  printf '새 Codex 세션에서 $codemode 스킬을 사용할 수 있습니다. 등록 경로는 %s/codemode 입니다.\n' "$skill_dir"
  if command -v codex >/dev/null 2>&1 && features=$(codex features list 2>/dev/null) &&
    printf '%s\n' "$features" | awk '$1 == "code_mode" && $2 != "removed" && $NF == "false" { off = 1 } END { exit !off }'; then
    echo 'Codex CLI의 Code Mode가 꺼져 있습니다. 사용하려면 codex features enable code_mode 를 실행하고 새 Codex 세션을 여세요.'
  fi
elif [ -e "$skill_dir/codemode" ] || [ -L "$skill_dir/codemode" ]; then
  printf '기존 %s/codemode 스킬을 유지했습니다. Ein 스킬은 %s 에 있습니다.\n' "$skill_dir" "$installed_skill" >&2
else
  printf 'Ein 설치는 완료했으나 %s/codemode 에 스킬을 등록하지 못했습니다. 디렉터리 권한을 확인하고 설치를 다시 실행하세요.\n' "$skill_dir" >&2
  exit 1
fi
if [ "$with_hooks" = true ]; then
  if ! EIN_HOME="$target" "$target/bin/sniffer" install-hooks; then
    echo 'Ein is installed. Resolve the profile error above and rerun install.sh --with-hooks.' >&2
    exit 1
  fi
fi
