# 가상 기억 샘플

이 디렉터리의 모든 기억·프로젝트·설정값·근거 번호는 **기능 검토용 가상 데이터**다. 실제 사용자 선호나 실제 프로젝트의 규칙을 의미하지 않는다.

`../scripts/demo.sh`를 실행하면 새 임시 디렉터리에 독립 Sniffer home과 세 프로젝트를 만든다. 현재 사용자의 `~/.ein/`와 실제 프로젝트 저장소는 수정하지 않는다. `EIN_SNIFFER_BIN=/absolute/path/sniffer bash scripts/demo.sh`로 실행할 바이너리를 지정한다.

| 기억 ID | scope | 가상 내용 | 기본적으로 읽는 프로젝트 |
| --- | --- | --- | --- |
| `m-pref-language` | `global` | 한국어 설명, 원문 코드 식별자 | folder-1, folder-2, folder-3 |
| `m-review-format` | `group:work` | 문제 → 근거 → 수정안 리뷰 | folder-1, folder-2, folder-3 |
| `m-idempotency` | `group:payments` | 결제 재시도 멱등 키 | folder-1, folder-2 |
| `m-local-port` | `project:folder-1` | PORT 규칙과 로컬 포트 4317 | folder-1 |
| `m-test-fixture` | `project:folder-2` | SAMPLE-B fixture | folder-2 |
| `m-theme-color` | `project:folder-3` | darkblue 테마 | folder-3 |

논리 계층은 `scopes.json`에 표시했다. 이 파일은 구조 검토용이며 데모는 `group add`와 `project add` 명령으로 같은 계층을 등록한다.

## 부분 승격 입력

`partial-promotion.json`은 `m-local-port`에서 공통 PORT 규칙을 분리해 `group:payments`의 새 기억 `m-port-configuration`으로 만드는 예제다. 원본에는 folder-1의 4317 설정을 남긴다. 저장기는 새 기억의 `derived_from`을 원본 ID와 실제 blob revision으로 채우고, 원본 본문에 새 ID 참조를 추가한다.

데모는 승격의 **미리보기만** 수행한다. 적용하려면 데모가 출력한 `EIN_HOME`을 지정하고 `memory read --project folder-1 --id m-local-port` 결과의 `revision`을 사용한다.

```bash
export EIN_HOME=/actual/path/printed/by/demo/sniffer

sniffer memory read --project folder-1 --id m-local-port

sniffer memory promote \
  --project folder-1 \
  --id m-local-port \
  --to group:payments \
  --if-revision ACTUAL_BLOB_REVISION \
  --request-id sample-partial-review-01 \
  --partial examples/partial-promotion.json \
  --dry-run
```

내용과 `newly_visible_projects`를 검토한 뒤 같은 명령의 마지막 옵션을 `--apply`로 바꾸면 한 commit으로 새 공유 파일 생성과 원본 수정이 반영된다. 미리보기는 journal과 Git을 변경하지 않으므로 같은 request ID를 적용 명령에 사용할 수 있다. 이 예제에서 새로 공통 규칙을 읽게 되는 프로젝트는 folder-2이고, 4317은 folder-1에 남는다.
