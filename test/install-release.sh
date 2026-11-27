#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
template=$(pwd)/scripts/install-release.sh
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
export TMPDIR="$scratch/downloads" HOME="$scratch/user" FIXTURES="$scratch"
mkdir -p "$TMPDIR" "$HOME" commands
export PATH="$scratch/commands:$PATH"
cat > commands/uname <<'EOF'
#!/bin/sh
case "$1" in
  -s) echo "${TEST_OS:-Darwin}" ;;
  -m) echo "$TEST_ARCH" ;;
  *) exit 1 ;;
esac
EOF
cat > commands/curl <<'EOF'
#!/bin/sh
set -eu
while [ "$1" != --output ]; do shift; done
archive=$2
test "$3" = "https://github.com/wintermocha/Ein/releases/download/v1.2.3/$archive"
cp "$FIXTURES/$archive" "$archive"
EOF
chmod +x commands/*

for arch in arm64 amd64; do
  bundle="ein-darwin-$arch"
  mkdir "$bundle"
  cat > "$bundle/install.sh" <<'EOF'
#!/bin/sh
set -eu
printf '%s %s %s\n' "$(dirname "$0")" "$#" "${1:-}" > "$HOME/invocation"
EOF
  tar -czf "$bundle.tar.gz" "$bundle"
done
arm=$(shasum -a 256 ein-darwin-arm64.tar.gz)
intel=$(shasum -a 256 ein-darwin-amd64.tar.gz)
sed -e 's/@RELEASE_TAG@/v1.2.3/g' \
  -e "s/@SHA256_ARM64@/${arm%% *}/g" -e "s/@SHA256_AMD64@/${intel%% *}/g" \
  "$template" > installer.sh

TEST_ARCH=arm64 sh -s < installer.sh
test "$(cat "$HOME/invocation")" = "ein-darwin-arm64 0 "
test -z "$(ls -A "$TMPDIR")"
TEST_ARCH=x86_64 sh -s -- --with-hooks < installer.sh
test "$(cat "$HOME/invocation")" = "ein-darwin-amd64 1 --with-hooks"
test -z "$(ls -A "$TMPDIR")"
rm "$HOME/invocation"

printf 'corrupted' >> ein-darwin-arm64.tar.gz
if TEST_ARCH=arm64 sh -s < installer.sh; then exit 1; fi
test ! -e "$HOME/invocation"
test -z "$(ls -A "$TMPDIR")"
if TEST_ARCH=arm64 TEST_OS=Linux sh -s < installer.sh; then exit 1; fi
if TEST_ARCH=arm64 sh -s -- --unexpected < installer.sh; then exit 1; fi
test ! -e "$HOME/invocation"
printf '%s\n' 'PASS: release URL, Apple Silicon and Intel selection, optional hooks, checksum failure, platform and argument rejection, and cleanup.'
