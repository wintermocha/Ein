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
if [ "${EIN_UPDATE_TO+x}" = x ] && ! printf '%s\n' "$EIN_UPDATE_TO" | cmp -s - "$bundle/release-tag"; then
  echo 'The package release tag does not match the requested update.' >&2
  exit 1
fi
case "$(uname -s)-$(uname -m)-$(cat platform)" in
  Darwin-arm64-darwin-arm64|Darwin-x86_64-darwin-amd64) ;;
  *) echo "This release targets $(cat platform). Choose a release for this Mac." >&2; exit 1 ;;
esac

mkdir -p "$target/bin" "$target/adapters"
if ! shlock -p "$$" -f "$target/.install.lock"; then
  echo 'Another Ein installation is running.' >&2
  exit 1
fi
trap 'rm -f "$target/.install.lock"' EXIT
if [ "${EIN_UPDATE_FROM+x}" = x ]; then
  installed=unversioned
  if [ -f "$target/release-tag" ]; then
    installed=$(cat "$target/release-tag")
  elif [ -e "$target/release-tag" ] || [ -L "$target/release-tag" ]; then
    echo 'Cannot read the installed release tag.' >&2
    exit 1
  fi
  if [ "$installed" != "$EIN_UPDATE_FROM" ]; then
    echo 'The installed release changed. Run ein update again.' >&2
    exit 1
  fi
fi
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
cp -R "$bundle/bin" "$bundle/adapters" "$bundle/release-tag" "$stage/"
EIN_HOME="$target" "$stage/bin/sniffer" memory init
for rel in bin/ein bin/sniffer adapters/claude-mod adapters/codex adapters/antigravity release-tag; do
  current="$target/$rel"
  if [ -e "$current" ] && [ ! -L "$current" ] && { [ "$rel" = release-tag ] || [ -x "$current" ]; } &&
      diff -qr "$stage/$rel" "$current" >/dev/null; then
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
if [ "$with_hooks" = true ]; then
  if ! EIN_HOME="$target" "$target/bin/sniffer" install-hooks; then
    echo 'Ein is installed. Resolve the profile error above and rerun install.sh --with-hooks.' >&2
    exit 1
  fi
fi
