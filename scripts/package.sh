#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
root=$(pwd)
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Darwin-x86_64) platform=darwin-amd64 ;;
  *) echo 'Build the macOS distribution on an Apple Silicon or Intel Mac.' >&2; exit 1 ;;
esac

name="ein-$platform"
mkdir -p dist
stage=$(mktemp -d "$root/dist/.package.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
bundle="$stage/$name"
mkdir -p "$bundle/bin" "$bundle/licenses"

bun install --frozen-lockfile
bun build --compile --define EIN_STANDALONE=true --compile-exec-argv=--use-system-ca src/cli.ts --outfile="$bundle/bin/ein"
(
  cd sniffer
  CGO_ENABLED=0 GOOS=darwin GOARCH=${platform#darwin-} go build \
    -mod=vendor -buildvcs=false -trimpath -ldflags='-s -w' -o "$bundle/bin/sniffer" ./cmd/sniffer
)
cp -R sniffer/adapters "$bundle/"
cp scripts/install.sh README.md "$bundle/"
mkdir -p "$bundle/sniffer" "$bundle/.agents/skills" "$bundle/docs/assets" "$bundle/examples"
cp docs/*.md docs/*.html "$bundle/docs/"
cp docs/assets/*.png "$bundle/docs/assets/"
cp examples/config.json examples/events.jsonl examples/slack-manifest.json "$bundle/examples/"
mkdir -p "$bundle/sniffer/scripts"
cp -R sniffer/docs sniffer/examples "$bundle/sniffer/"
cp sniffer/README.md sniffer/PROVENANCE.md "$bundle/sniffer/"
cp sniffer/scripts/demo.sh "$bundle/sniffer/scripts/"
cp -R .agents/skills/ein-setup .agents/skills/codemode "$bundle/.agents/skills/"
cp sniffer/LICENSE sniffer/THIRD-PARTY-NOTICES.txt "$bundle/licenses/"
find sniffer/vendor node_modules -type f \( -iname 'license' -o -iname 'license.*' -o -name NOTICE -o -name PATENTS \) \
  -exec sh -ec 'dest=$1; shift; for f do mkdir -p "$dest/$(dirname "$f")"; cp "$f" "$dest/$f"; done' sh "$bundle/licenses" {} +
printf '%s\n' "$platform" > "$bundle/platform"
printf '%s\n' "${EIN_RELEASE_TAG:-source}" > "$bundle/release-tag"
(
  cd "$bundle"
  find . -type f ! -name SHA256SUMS -exec shasum -a 256 {} + > SHA256SUMS
)
COPYFILE_DISABLE=1 tar -czf "$stage/$name.tar.gz" -C "$stage" "$name"
mv -f "$stage/$name.tar.gz" "dist/$name.tar.gz"
printf 'Created %s/dist/%s.tar.gz\n' "$root" "$name"
