# 가상 기억 데모

세 가상 프로젝트에서 한영 검색, 프로젝트별 기억의 공개 범위, 상위 그룹으로의 승격을 확인합니다. Git과 Bash가 필요합니다. 데모는 임시 폴더에 기억 저장소와 프로젝트를 만들고 검토할 수 있도록 결과를 남깁니다.

## 실행과 결과 확인

저장소 또는 압축을 푼 배포본의 `sniffer/examples/`에서 시작하세요. 배포본은 다음과 같이 실행합니다.

```sh
SNIFFER="$PWD/../../bin/sniffer"
bash ../scripts/demo.sh "$SNIFFER"
```

소스에서는 같은 폴더에서 Go로 빌드한 뒤 실행합니다.

```sh
SNIFFER="$(mktemp -d)/sniffer"
go build -o "$SNIFFER" ../cmd/sniffer
bash ../scripts/demo.sh "$SNIFFER"
```

실행이 끝나면 터미널에 각 검사의 `PASS`와 `DEMO_ROOT`가 표시됩니다. 같은 터미널에서 아래 첫 줄의 경로를 출력된 값으로 바꾸세요.

```sh
DEMO_ROOT='/출력된/데모/폴더'
cat "$DEMO_ROOT/results/summary.txt"
cat "$DEMO_ROOT/results/22-sibling-hidden.json" "$DEMO_ROOT/results/23-fixture-visible.json"
cat "$DEMO_ROOT/results/31-partial-preview.json"
```

두 검색 결과에서 같은 검색어 `SAMPLE-B`를 비교해 보세요. folder-1에서는 형제 프로젝트의 기억을 찾을 수 없고, folder-2에서는 `m-test-fixture`가 나옵니다. 데모는 `group add`와 `project add`로 아래 범위를 등록합니다. [범위 계층](scopes.json)

| 기억 ID | 범위 | 가상 내용 | 읽을 수 있는 프로젝트 |
| --- | --- | --- | --- |
| `m-pref-language` | `global` | 한국어 설명, 원문 코드 식별자 | folder-1, folder-2, folder-3 |
| `m-review-format` | `group:work` | 문제 → 근거 → 수정안 리뷰 | folder-1, folder-2, folder-3 |
| `m-idempotency` | `group:payments` | 결제 재시도 멱등 키 | folder-1, folder-2 |
| `m-local-port` | `project:folder-1` | PORT 규칙과 로컬 포트 4317 | folder-1 |
| `m-test-fixture` | `project:folder-2` | SAMPLE-B fixture | folder-2 |
| `m-theme-color` | `project:folder-3` | darkblue 테마 | folder-3 |

## 부분 승격 검토하기

데모는 승격을 미리보기까지만 실행합니다. 부분 승격 입력은 공통 `PORT` 규칙을 `group:payments`의 새 기억 `m-port-configuration`으로 분리하고, 로컬 포트 4317은 folder-1의 원본에 남깁니다. [부분 승격 입력](partial-promotion.json)

같은 `sniffer/examples/` 폴더에서 아래 명령으로 데모 저장소에 있는 원본의 현재 `revision`을 읽으세요.

```sh
EIN_HOME="$DEMO_ROOT/sniffer" EIN_CONFIG="$DEMO_ROOT/ein-config.json" \
  "$SNIFFER" memory read --project folder-1 --id m-local-port
```

아래 `REVISION`에 방금 읽은 값을 넣으세요.

```sh
REVISION='출력된 revision 값'
EIN_HOME="$DEMO_ROOT/sniffer" EIN_CONFIG="$DEMO_ROOT/ein-config.json" \
  "$SNIFFER" memory promote \
    --project folder-1 \
    --id m-local-port \
    --to group:payments \
    --if-revision "$REVISION" \
    --request-id sample-partial-review-01 \
    --partial ./partial-promotion.json \
    --dry-run
```

`newly_visible_projects`에는 공통 규칙을 새로 읽게 될 `project:folder-2`가 표시됩니다. 데모 저장소에 적용하려면 같은 요청 ID로 마지막 옵션만 `--apply`로 바꿔 실행하세요. 한 커밋에 새 기억과 수정된 원본이 저장됩니다. 새 기억의 `derived_from`에는 원본 ID와 revision이, 원본 본문에는 새 기억의 ID가 남습니다.
