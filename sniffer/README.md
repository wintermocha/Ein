# Sniffer

Sniffer는 아인(Ein)의 장기 기억 엔진입니다. 터미널에서 기록한 프로젝트 결정을 다음 Slack 작업에서 검색할 수 있고, Slack에서 저장한 인수인계 메모도 같은 프로젝트 폴더에서 읽을 수 있습니다. 기억은 `~/.ein/memory/store/`에 있는 전용 Git 저장소에 YAML frontmatter를 붙인 Markdown으로 보관합니다.

## 한 번에 설치하기

Mac용 Ein 배포 파일을 풀고 그 안에서 실행하세요. 아래 명령은 `ein`, `sniffer`, 제품별 어댑터를 설치하고 기억 저장소를 초기화합니다. `--with-hooks`는 Codex와 Antigravity CLI의 사용자 프로필에 자동 회상 hook도 병합합니다. 터미널에서 기억을 직접 읽고 쓰거나 Slack 오케스트레이션만 사용할 때는 `sh install.sh`로 충분합니다.

```sh
sh install.sh --with-hooks
export PATH="$HOME/.ein/bin:$PATH"
sniffer version
```

두 실행 파일은 이미 빌드돼 있어 사용자가 Bun이나 Go를 설치할 필요가 없습니다. 로컬 Git은 필요합니다. 새 터미널에서도 짧은 명령을 쓰려면 셸 설정에 위 `PATH`를 추가하세요. `EIN_HOME`을 지정해 설치했다면 이후에도 그 값을 사용하고 해당 디렉터리의 `bin`을 PATH에 추가하세요. 소스에서 배포 파일을 만드는 명령은 저장소 루트의 `bun run package`입니다. [Ein 설치 안내](../README.md)

## Slack 없이 프로젝트 기억 사용하기

아래 예제는 프로젝트 폴더에서 검색 인덱스에 관한 결정을 저장하고 다시 찾습니다. 새 프로젝트라면 첫 줄로 현재 폴더를 `catalog`로 등록하세요. 이미 Ein 설정의 `projects`에 등록했다면 첫 줄은 건너뛰고, `scope_id`의 `catalog`를 등록된 프로젝트 ID로 바꾸세요.

```sh
ein project add --id catalog --path "$PWD"
ein memory save --input - --if-revision new --request-id catalog-index-001 <<'MEMORY'
---
schema_version: 1
id: search-index-owner
scope_id: project:catalog
description: 상품 검색 인덱스 갱신 담당과 작업 위치
aliases: [검색 인덱스, search index]
---
상품 변경 후 인덱스는 catalog-worker가 갱신한다.
후속 작업은 services/indexer 폴더에서 이어간다.
MEMORY

ein memory list
ein memory search --query "검색 인덱스"
ein memory read --id search-index-owner
```

같은 프로젝트의 하위 폴더에서도 같은 기억을 찾습니다. 마지막 명령은 JSON으로 본문과 이 기억의 `revision`을 보여 줍니다. Markdown 원문이 필요하면 `--format markdown`을 붙이세요. 수정할 때는 방금 읽은 `revision`을 `--if-revision`에 넣고 새 요청 ID를 사용합니다. 같은 저장을 재시도할 때는 원래 요청 ID를 다시 사용하세요.

### 프로젝트와 폴더를 연결하는 규칙

- Slack 프로젝트는 `EIN_CONFIG`가 가리키는 파일에서 읽습니다. 기본값은 `~/.config/ein/config.json`입니다. 상대 프로젝트 경로는 이 파일이 있는 폴더를 기준으로 해석합니다. Slack 토큰 없이도 등록 정보를 사용할 수 있습니다.
- `ein folder bind --path "$PWD"`로 폴더 전용 기억을 시작합니다. 나중에 같은 명령에 `--project shop`을 붙여 프로젝트에 연결해도 기존 폴더 기억의 범위는 유지됩니다. 등록된 폴더에서는 하위 디렉터리도 같은 기억을 씁니다. 하위 폴더에 별도 기억을 두려면 `--exact`로 연결하세요. 대화형 `ein run`과 `ein memory save`도 첫 작업 폴더 연결을 안내합니다.
- 기억을 저장할 때 `scope_id: folder:current`는 현재 폴더 전용, `scope_id: project:shop`은 shop에 연결된 모든 폴더에서 쓸 수 있는 기억입니다. 검색은 현재 폴더, 연결된 프로젝트와 상위 그룹, `global` 순으로 범위를 확인합니다. `memory promote --dry-run`으로 더 넓게 공유할 때의 대상을 확인할 수 있습니다. [기억 형식과 범위](docs/STORAGE.md)

## Slack에서 작업 이어가기

가령 Slack 설정의 `projects.catalog.path`가 위 폴더를 가리킨다면, 소유자가 `ein orchestrate` 실행 중인 봇에 “`project:catalog` 상품 인덱스 작업 이어줘”라고 요청할 수 있습니다. 프로젝트를 배정한 뒤 아인은 에이전트 턴에 프로젝트 ID, 등록 루트, 작업 디렉터리, 사용할 Sniffer 실행 파일과 설정 위치를 함께 넘깁니다. 에이전트는 그 범위에서 이전 결정과 인수인계를 검색하고 필요한 기억을 읽습니다. 공유 라우팅·검토 단계와 프로젝트 미지정 턴에는 프로젝트 기억을 연결하지 않습니다. [Slack 오케스트레이션](../docs/slack-cli.md)

## 하위 에이전트에 작업 맡기기

부모의 현재 폴더에서 `ein delegate`를 실행하면 자식이 사용할 프로젝트 ID, 실제 작업 경로, 메모리 환경 변수를 JSON으로 확인할 수 있습니다. `--` 뒤에 실행 파일과 인자를 넣으면 같은 검증을 거쳐 그 폴더에서 자식 프로세스를 시작합니다.

```sh
ein delegate
ein delegate --cwd services/indexer
ein delegate --cwd services/indexer -- ein run codex
```

`--cwd`는 부모의 현재 폴더를 기준으로 해석합니다. 심볼릭 링크를 해석한 실제 경로에 등록된 프로젝트가 부모와 다르면 실행을 멈춥니다. 터미널에서 다른 프로젝트로 위임할 때는 `ein delegate --project catalog --cwd /work/catalog -- ein run claude`처럼 대상 ID와 경로를 지정하세요. Slack에서는 대화의 프로젝트 배정 절차로 돌아가 대상 프로젝트를 지정합니다.

호스트 자체의 하위 에이전트 기능을 쓰려면 명령 없이 검증한 `workingDirectory`와 `env`를 자식 실행 설정에 적용합니다. 부모의 기억 에이전트 연결이나 Slack 토큰은 전달하지 않습니다. 호스트에서 작업 경로 또는 메모리 범위를 지정할 수 없는 경우에는 부모가 필요한 기억을 조회해 작업 설명에 담습니다. 이때 자식에게 연결된 Sniffer 도구를 끄고, 자식 프로세스에서는 `EIN_SNIFFER_DELEGATION=none`으로 Sniffer 명령의 메모리 접근을 막을 수 있습니다. 직접 접근을 끌 수 없으면 부모가 작업을 이어갑니다.

`ein run`으로 시작한 Claude Code에는 플러그인이 이 규칙을 전달합니다. Codex와 Antigravity에서 자동 안내를 받으려면 아래의 제품별 hook을 설치하고 활성화하세요. `ein delegate` 명령 자체는 hook 없이도 사용할 수 있습니다.

## 터미널 에이전트에서 자동 회상하기

사용할 제품의 CLI를 설치하고 로그인한 뒤, 등록한 프로젝트 폴더에서 아래 명령으로 시작하세요. 기본 설치 후 Codex나 Antigravity의 자동 회상을 추가하려면 `sniffer install-hooks`를 한 번 실행하세요.

| 제품 | 실행 명령 | 자동 회상에 필요한 기능 |
| --- | --- | --- |
| Claude Code | `ein run claude` | 런처가 기억 플러그인을 로드합니다. 네이티브 하위 에이전트를 지원하는 mod API가 필요합니다. |
| Codex | `ein run codex` | hook으로 관찰을 전달하고 `codex app-server`에서 기억을 검색합니다. hook 신뢰 확인이 표시되면 경로와 명령을 검토해 승인하세요. |
| Antigravity CLI | `ein run agy` | hook을 통해 주 세션과 연결합니다. `agy`에서 스트리밍 대화와 전용 reader MCP를 사용할 수 있어야 합니다. |

새 작업 세션은 Ein 설정의 `models.claude`, `models.codex`, `models.agy`를 읽습니다. 기본값은 각각 `claude-opus-5-5`, `gpt-6.2-astra`, `gemini-4-carbon`입니다. `ein delegate -- ein run codex`로 위임해도 같은 설정을 씁니다. 한 번만 모델을 바꾸려면 `ein run claude -- --model sonnet`처럼 실행하세요. 기억 검색 에이전트의 모델은 [제품별 연결 설정](docs/INTEGRATIONS.md#1-제품별로-다른-연결부)을 따릅니다.

`sniffer doctor --host codex`로 해당 CLI의 로컬 기능을 점검할 수 있습니다. 다른 제품은 `claude` 또는 `agy`를 지정하세요. 로그인과 모델 접근 권한, 실제 회상 결과는 제품 세션에서 확인하세요.

기억 에이전트는 검색어를 고르고 본문을 읽은 뒤 관련 기억의 ID와 revision을 반환합니다. Go 엔진은 실제 본문을 전달하기 전에 최신 버전, 허용 범위, 이전 전달 여부를 확인합니다. 저장과 상위 범위 공유는 메인 모델의 별도 writer 요청 또는 명시적 CLI 명령으로 수행합니다. 한영 검색어, Git 기반 충돌 처리, 중단된 쓰기 복구는 v0.4.0의 공통 엔진을 사용합니다. [제품별 연결](docs/INTEGRATIONS.md) · [엔진 구조](docs/ARCHITECTURE.md) · [운영·복구](docs/OPERATIONS.md)

## 검증과 출처

Mac 배포 파일을 풀고 그 최상위 폴더에서 아래 명령을 실행하면 설치 전에도 데모를 볼 수 있습니다. 임시 저장소에 가상 기억 여섯 개를 저장한 뒤 한영 검색, 형제 프로젝트 격리, 공유 범위 미리보기와 저장 재시도를 확인합니다. 소스에서 데모를 실행하는 방법과 결과 파일의 위치는 예제 안내에 있습니다. [데모와 샘플 데이터](examples/README.md)

```sh
bash sniffer/scripts/demo.sh ./bin/sniffer
```

소스 저장소에서 엔진과 Claude 어댑터를 검증하려면 `sniffer/` 폴더에서 실행하세요. 두 테스트는 모델 계정 없이 실행할 수 있습니다.

```sh
go test -race ./...
node --test adapters/claude-mod/hooks/register.test.mjs
```

코드와 어댑터의 기준은 참고 대화에서 제공된 `ein-sniffer-v0.4.0.zip`입니다. [장기 메모리 프로토타입 대화](https://chatgpt.com/c/6b0506b7-be18-83ec-99ab-229eb00c40b4) · [라이선스와 출처](PROVENANCE.md)
