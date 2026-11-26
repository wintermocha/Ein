#!/usr/bin/env bash
# Isolated, offline sample demonstration. All six memories are fictional.
set -euo pipefail
umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
package_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
sniffer_bin="${1:-${EIN_SNIFFER_BIN:-}}"
if [[ -z "$sniffer_bin" ]]; then
  if command -v sniffer >/dev/null 2>&1; then
    sniffer_bin="$(command -v sniffer)"
  elif [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]]; then
    sniffer_bin="$package_root/bin/darwin-arm64/sniffer"
  elif [[ "$(uname -s)" == Darwin && "$(uname -m)" == x86_64 ]]; then
    sniffer_bin="$package_root/bin/darwin-amd64/sniffer"
  else
    sniffer_bin="$package_root/bin/sniffer"
  fi
fi
if [[ "$sniffer_bin" != */* ]]; then
  sniffer_bin="$(command -v -- "$sniffer_bin")"
elif [[ "$sniffer_bin" != /* ]]; then
  sniffer_bin="$(CDPATH= cd -- "$(dirname -- "$sniffer_bin")" && pwd)/$(basename -- "$sniffer_bin")"
fi
if [[ ! -x "$sniffer_bin" ]]; then
  printf '실행 가능한 Sniffer 바이너리가 필요합니다: %s\n' "$sniffer_bin" >&2
  exit 1
fi

demo_root="$(mktemp -d "${TMPDIR:-/tmp}/sniffer-demo.XXXXXXXX")"
export EIN_HOME="$demo_root/sniffer"
export EIN_CONFIG="$demo_root/ein-config.json"
results="$demo_root/results"
mkdir -p "$results" "$demo_root/projects/folder-1" "$demo_root/projects/folder-2" "$demo_root/projects/folder-3"

printf '가상 기억 데모 디렉터리: %s\n' "$demo_root"
"$sniffer_bin" memory init > "$results/00-init.json"
"$sniffer_bin" group add --id work --parent global --request-id demo-group-work > "$results/01-work.json"
"$sniffer_bin" group add --id payments --parent group:work --request-id demo-group-payments > "$results/02-payments.json"
"$sniffer_bin" project add --id folder-1 --path "$demo_root/projects/folder-1" --parent group:payments --request-id demo-project-1 > "$results/03-project-1.json"
"$sniffer_bin" project add --id folder-2 --path "$demo_root/projects/folder-2" --parent group:payments --request-id demo-project-2 > "$results/04-project-2.json"
"$sniffer_bin" project add --id folder-3 --path "$demo_root/projects/folder-3" --parent group:work --request-id demo-project-3 > "$results/05-project-3.json"

save_sample() {
  local number="$1" project="$2" relative="$3" id="$4"
  "$sniffer_bin" memory save --project "$project" --input "$package_root/examples/memories/$relative" --if-revision new --request-id "demo-save-$id" > "$results/$number-$id.json"
}
save_sample 10 folder-1 global/m-pref-language.md m-pref-language
save_sample 11 folder-1 groups/work/m-review-format.md m-review-format
save_sample 12 folder-1 groups/payments/m-idempotency.md m-idempotency
save_sample 13 folder-1 projects/folder-1/m-local-port.md m-local-port
save_sample 14 folder-2 projects/folder-2/m-test-fixture.md m-test-fixture
save_sample 15 folder-3 projects/folder-3/m-theme-color.md m-theme-color

"$sniffer_bin" memory search --project folder-1 --query '멱등성' > "$results/20-korean.json"
"$sniffer_bin" memory search --project folder-2 --query 'idempotency' > "$results/21-english.json"
"$sniffer_bin" memory search --project folder-1 --query 'SAMPLE-B' > "$results/22-sibling-hidden.json"
"$sniffer_bin" memory search --project folder-2 --query 'SAMPLE-B' > "$results/23-fixture-visible.json"
"$sniffer_bin" memory search --project folder-3 --query 'payment retry idempotency' > "$results/24-other-group.json"
"$sniffer_bin" memory read --project folder-3 --id m-review-format > "$results/25-parent-visible.json"

grep -q '"id": "m-idempotency"' "$results/20-korean.json"
grep -q '"id": "m-idempotency"' "$results/21-english.json"
grep -q '"id": "m-test-fixture"' "$results/23-fixture-visible.json"
grep -q '"id": "m-review-format"' "$results/25-parent-visible.json"
if grep -q '"id": "m-test-fixture"' "$results/22-sibling-hidden.json"; then
  printf '실패: 형제 프로젝트의 fixture가 노출되었습니다.\n' >&2
  exit 1
fi
if grep -q '"id": "m-idempotency"' "$results/24-other-group.json"; then
  printf '실패: 결제 그룹 밖으로 기억이 노출되었습니다.\n' >&2
  exit 1
fi

# Extract the stable, program-produced blob field without requiring jq or Python.
revision="$(sed -n 's/^  "revision": "\([0-9a-f]*\)",\{0,1\}$/\1/p' "$results/13-m-local-port.json")"
if [[ -z "$revision" ]]; then
  printf '실패: 저장 결과에 revision이 없습니다.\n' >&2
  exit 1
fi
"$sniffer_bin" memory promote --project folder-1 --id m-local-port --to group:payments --if-revision "$revision" --request-id demo-whole-preview --dry-run > "$results/30-whole-preview.json"
"$sniffer_bin" memory promote --project folder-1 --id m-local-port --to group:payments --if-revision "$revision" --request-id demo-partial-preview --partial "$package_root/examples/partial-promotion.json" --dry-run > "$results/31-partial-preview.json"
grep -q '"preview": true' "$results/30-whole-preview.json"
grep -q '"preview": true' "$results/31-partial-preview.json"
grep -q 'project:folder-2' "$results/31-partial-preview.json"

# A repeated request returns the original commit even after unrelated writes.
"$sniffer_bin" memory save --project folder-1 --input "$package_root/examples/memories/projects/folder-1/m-local-port.md" --if-revision new --request-id demo-save-m-local-port > "$results/32-idempotent-retry.json"
cmp "$results/13-m-local-port.json" "$results/32-idempotent-retry.json"

cat > "$results/summary.txt" <<EOF
PASS: six fictional memories saved
PASS: Korean and English retrieval
PASS: sibling project memory excluded
PASS: payment scope excluded from folder-3
PASS: work parent visible from folder-3
PASS: whole and partial promotion preview (no promotion applied)
PASS: same-request replay returns original result

EIN_HOME=$EIN_HOME
DEMO_ROOT=$demo_root
RESULTS=$results
EOF
cat "$results/summary.txt"
printf '\n데모 파일은 검토를 위해 보존했습니다. 실제 기억 저장소는 수정하지 않았습니다.\n'
