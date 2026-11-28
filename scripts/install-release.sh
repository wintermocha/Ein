#!/bin/sh
set -eu

install_release() {
  tag='@RELEASE_TAG@'
  case "$#:${1:-}" in
    0:|1:--with-hooks) ;;
    1:--update)
      if [ -z "${EIN_UPDATE_FROM:-}" ] || [ "${EIN_UPDATE_TO:-}" != "$tag" ]; then
        echo 'The installer does not match the requested Ein update.' >&2
        exit 1
      fi
      set --
      ;;
    *) echo 'Usage: sh install-release.sh [--with-hooks]' >&2; exit 1 ;;
  esac

  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin-arm64; checksum='@SHA256_ARM64@' ;;
    Darwin-x86_64) platform=darwin-amd64; checksum='@SHA256_AMD64@' ;;
    *) echo 'Ein releases support Apple Silicon and Intel Macs.' >&2; exit 1 ;;
  esac
  case "$checksum" in
    ''|*[!0-9a-f]*) echo 'Download install-release.sh from a published Ein release.' >&2; exit 1 ;;
  esac

  umask 077
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/ein-release.XXXXXXXX")
  trap 'rm -rf "$scratch"' EXIT
  trap 'exit 1' HUP INT TERM
  bundle="ein-$platform"
  archive="$bundle.tar.gz"
  url="https://github.com/wintermocha/Ein/releases/download/$tag/$archive"
  (
    cd "$scratch"
    curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --retry 3 --output "$archive" "$url"
    printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
    tar -xzf "$archive"
    sh "$bundle/install.sh" "$@"
  )
}

install_release "$@"
