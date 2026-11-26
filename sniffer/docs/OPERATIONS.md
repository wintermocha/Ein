# 명령과 운영

## 공통 옵션

기본 루트는 `~/.ein/`입니다. `EIN_HOME=/absolute/path` 또는 명령 **앞**의 `--home /absolute/path`로 바꿀 수 있습니다. 인증용 `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`를 Sniffer 경로로 바꾸지 않습니다.

```bash
sniffer --home /tmp/sniffer-example memory init
sniffer help
sniffer version
```

기계가 읽는 결과는 JSON이며 오류는 stderr와 nonzero exit code입니다. hook은 일반 검색 실패를 메인 작업 중단으로 전파하지 않고 제품별 빈 결과를 반환합니다. 진단에 전체 프롬프트·기억·인증 토큰을 출력하지 않습니다.

## 읽기

현재 디렉터리에서 project를 자동 확인합니다. 독립 CLI 조작에서는 `--project <등록된 ID>`로 명시 선택할 수 있습니다. 자동 worker와 MCP는 시작 때 고정한 project를 클라이언트 인자로 바꿀 수 없습니다.

```bash
sniffer memory search --query "개발 서버 포트" --limit 10
sniffer memory search --project folder-1 --query "development port"
sniffer memory list --project folder-1
sniffer memory list --project folder-1 --scope group:payments
sniffer memory list --project folder-1 --scope global
sniffer memory read --project folder-1 --id m-local-port
sniffer memory read --project folder-1 --id m-local-port --format markdown > /tmp/local-port.md
```

`list --scope`는 조상 집합을 좁히는 filter입니다. 형제 project를 지정하면 오류입니다. `read`는 scope 밖 ID가 실제 존재하는지 알려주지 않습니다. 검색어는 UTF-8 8 KiB, limit은 최대 100입니다.

## 저장

YAML frontmatter의 `schema_version`, `id`, `scope_id`, `description`과 Markdown 본문이 필요합니다. aliases·tags·key·updated_at·derived_from은 선택 필드입니다. 허용하지 않는 필드나 중복 key를 조용히 무시하지 않습니다.

```markdown
---
schema_version: 1
id: m-local-port
scope_id: project:folder-1
description: "가상 샘플: folder-1 개발 서버 포트"
aliases:
  - development port
  - 개발 포트
key: dev-server-port
---
가상 샘플입니다. 개발 서버 포트는 4317을 사용합니다.
```

```bash
sniffer memory save --project folder-1 \
  --input /tmp/local-port.md --if-revision new --request-id create-port-001
```

수정은 `memory read`가 돌려준 `revision`을 `--if-revision`에 넣습니다. `new`를 수정 우회로 쓰지 않습니다. request ID는 같은 작업의 재시도에 재사용하고 새 변경에는 새 ID를 씁니다. 동일 ID를 다른 본문에 쓰면 거부합니다. 전역·그룹 저장은 Markdown에 해당 scope를 명시한 별도 요청이며 선택한 project의 조상이어야 합니다.

## 전체·부분 승격

먼저 `read`에서 blob revision을 확인하고 preview 결과의 `changed_paths`, `target_scope`, `newly_visible_projects`를 검토합니다.

```bash
sniffer memory promote --project folder-1 --id m-local-port \
  --to group:payments --if-revision BLOB_REVISION \
  --request-id promote-port-001 --dry-run

sniffer memory promote --project folder-1 --id m-local-port \
  --to group:payments --if-revision BLOB_REVISION \
  --request-id promote-port-001 --apply
```

`BLOB_REVISION`은 실제 값을 넣는 자리입니다. 부분 승격은 `--partial examples/partial-promotion.json`을 추가합니다. 새 shared memory와 남길 원문을 명시하며 자연어 의미를 자동 분해하지 않습니다. [예제 설명](../examples/README.md)과 [저장소 문서](STORAGE.md)를 먼저 확인하세요.

## 반복 전달과 수동 재전달

자동 전달 ledger와 순수 검색은 분리됩니다. 같은 내용이 이미 전달되었어도 `memory read`는 항상 현재 원문을 보여 줍니다. 이미 실행 중인 Codex/agy `sniffer run`의 환경을 물려받은 도구에서 다음 명령을 사용하면 worker의 전달 규칙을 이용할 수 있습니다.

```bash
sniffer memory recall --id m-local-port
sniffer memory recall --id m-local-port --force
```

이 명령은 terminal stdout/도구 결과로 reference JSON을 반환합니다. 호스트 대화에 임의의 새 턴을 push하는 API가 아닙니다. 첫 host 이벤트 전에 호출하면 active conversation을 알 수 없어 거부합니다. `--conversation`으로 같은 worker에서 관측한 conversation을 지정할 수도 있습니다. 일반 별도 터미널에는 run 환경이 없으므로 `memory read`를 사용합니다.

claimed 상태에서 출력 여부를 알 수 없게 된 기억은 uncertain으로 남을 수 있습니다. 중복 방지를 우선하므로 자동 반복을 하지 않습니다. `--force`는 새 명시적 전달 요청입니다.

## 설정과 예산

`memory init`은 `config.json`을 만듭니다. 일반적으로 CLI로 project를 등록하고 `doctor --host <제품>`으로 로컬 기능을 확인합니다. 실행 파일 경로를 저장하려면 `--executable /absolute/path --configure`를 사용합니다. 직접 config를 편집할 때는 CLI 세션을 종료하고 JSON 구조를 유지하세요. 알 수 없는 필드·잘못된 범위는 오류로 처리됩니다.

| 설정 | 기본값 | 의미 |
| --- | ---: | --- |
| `recall.output_count` | 3 | 자동 전달 최대 개수, 1..3 |
| `recall.output_bytes` | 12288 | reference JSON 전체 크기 |
| `recall.wait_millis` | 1000 | Codex/agy hook이 즉시 기다리는 시간 |
| `recall.timeout_seconds` | 60 | Codex/agy 회상 작업 deadline; native adapter 상한 60초 |
| `EIN_SNIFFER_PROMPT_WAIT_MS` | 1000 | Claude prompt 대기, 0..5000 ms |

설정의 timeout_seconds는 1..120을 허용하지만 각 native adapter의 별도 상한이 60초이므로 실효 제한은 min(설정값, 60초)입니다. Claude native agent의 작업 제한은 mod에서 45초로 정합니다. Go request는 3분 후 만료되어 재사용할 수 없습니다. native reader는 요청당 12회 시도·192 KiB 결과 상한을 적용합니다. `candidate_limit`이나 `input_bytes`로 초기 후보를 잘라 LLM에 넘기는 설정은 제거했습니다. 모델이 자신의 질의를 선택합니다.

hook 대기 시간을 늘리는 경우 제품 hook timeout도 확인해야 합니다. 전달 지연과 사용자 응답 지연의 절충이며, 늦은 결과를 위해 추가 사용자 턴을 만들지는 않습니다. `wait_millis`를 변경해도 Claude의 대기 시간은 별도 환경변수로 관리됩니다.

CLI 실행 파일을 따로 지정하려면:

```bash
sniffer doctor --host codex --executable /absolute/path/codex --configure
```

이 경로는 해당 제품의 main CLI와 판단기에서 함께 사용합니다. 모델·effort를 임의 변경하는 사용자 옵션은 제공하지 않습니다. 별도 제품으로 fallback하지 않습니다.

## 선택적 MCP

Claude 자동 회상은 native custom tools, Codex 자동 회상은 app-server dynamic tools를 사용합니다. agy 자동 회상은 adapter가 전용 reader MCP를 자동 구성합니다. 아래 일반 reader/writer는 메인 LLM의 명시적 도구에 연결할 때 사용하며, 각각 별도 프로세스와 role로 구성합니다.

```bash
sniffer mcp --role reader --project folder-1
sniffer mcp --role writer --project folder-1
```

| role | 공개 도구 |
|---|---|
| reader | `memory_search`, `memory_list`, `memory_read` |
| writer | `memory_save`, `memory_promote` |
| agent-reader | `memory_search`, `memory_read`, `memory_context`; agy adapter가 private context 파일과 함께 생성 |

reader에는 save/promote 이름을 호출해도 권한이 생기지 않습니다. 입력 arguments로 다른 project를 넣을 수도 없습니다. writer에는 `markdown`, `if_revision`, `request_id`, 승격의 명시적 `apply` 등이 필요합니다. writer를 자동 회상 memory agent의 MCP에 등록하지 않습니다. 부분 승격·scope 등록·복구는 CLI에서 수행합니다.

일반적인 stdio 설정의 내용 예시는 다음과 같습니다. 각 제품이 요구하는 상위 설정 키와 설치 위치는 제품 설명서에 맞춰 적용해야 합니다.

```json
{
  "command": "/Users/YOUR_NAME/.ein/bin/sniffer",
  "args": ["mcp", "--role", "reader", "--project", "folder-1"]
}
```

MCP는 newline-delimited JSON-RPC만 사용합니다. `initialize` → `notifications/initialized` → `tools/list`/`tools/call` 순서입니다. stdout에는 protocol JSON만 씁니다. reader의 호출 결과는 delivery ledger를 갱신하지 않습니다.

## 복구·백업

쓰기 오류에 request ID가 표시되면 같은 작업을 재시도하거나 다음을 실행합니다.

```bash
sniffer memory recover --request-id ORIGINAL_REQUEST_ID
```

복구가 unknown edit, 다른 index.lock, HEAD 변경을 보고하면 해당 파일을 덮어쓰지 않습니다. store와 state를 보존하고 [STORAGE.md](STORAGE.md)의 복구 조건에 따라 확인합니다. 임의로 `.git/index.lock`을 지우거나 `git reset --hard`를 실행하는 흐름을 자동화하지 않았습니다.

백업하려면 세션과 쓰기를 종료한 상태에서 `~/.ein/`를 복사합니다. Git 기억만 복사하면 원문은 보존되지만 로컬 project root 매핑·영수증·미완료 journal은 별개입니다. journal은 원래 store의 경로에 묶이므로 미완료 작업 중 저장소를 이동하지 않습니다. Git에는 과거 내용이 남으므로 비밀키·비밀번호를 기억으로 저장하지 마세요.

## 증상별 확인

| 증상 | 확인할 항목 |
|---|---|
| `unregistered working directory` | 실제 경로 또는 worktree를 같은 ID에 등록했는지 |
| 형제 기억이 검색되지 않음 | 의도된 project 분리인지; 공유하려면 ancestor로 명시적 promote |
| 자동 기억이 안 들어옴 | `sniffer run` 사용, adapter 로딩·trust, doctor, 관련 기억, 다음 안전한 주입 시점 |
| `agent_failed` / `agent_unavailable` | 제품 protocol·모델 접근·reader 제한·정책 변경 확인. 다른 모델로 자동 fallback하지 않음 |
| 모델 오류 후 로컬 검색은 됨 | 기존 로그인·정확한 모델 entitlement·API key 우선순위·네트워크 |
| 같은 기억을 다시 보고 싶음 | `memory read` 또는 Codex/agy 활성 run의 `memory recall --force` |
| 한영 표현 차이로 검색 안 됨 | description·aliases·glossary 보강; 의미 임베딩 검색은 없음 |
| CLI를 종료했는데 기억이 남음 | 정상: store/state는 영속, run/worker만 종료 |

제품별 API 출처와 테스트 실행 방법을 확인할 수 있습니다. [출처](../PROVENANCE.md) · [검증과 데모](../README.md#검증과-출처)

## JSON bridge

Claude mod는 `sniffer bridge begin|tool|complete|ack|cancel|reset|write`에 JSON을 stdin으로 전달합니다. JSON binding은 host, conversation_id, cwd, 선택적인 turn_id·event_id와 활성 request_id입니다. begin은 prompt와 request_id를 돌려주며 tool은 현재 generation에만 허용됩니다. complete는 ID/revision Decision을 검증하고 claim을 반환합니다. write는 Claude main binding과 `role:"main"`, 비어 있는 agent_id를 요구합니다. 이 명령은 제품 adapter 내부 인터페이스이며 메모리 agent에 CLI 실행 도구로 노출하지 않습니다.

`memory search/list/read`의 순수 조회와 달리 bridge는 `memory/state/sessions/`에 현재 observation과 도구 예산을 기록합니다. 해당 파일은 private 권한으로 생성되며 Git에 포함하지 않습니다. deliveries에는 본문이 없지만 sessions·transactions·제품 자체 transcript에는 일부 본문이 있을 수 있습니다. 백업·보관 정책을 정할 때 이 차이를 함께 확인합니다.
