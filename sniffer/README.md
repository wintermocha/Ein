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

이미 Ein 설정의 `projects`에 등록한 폴더라면 바로 `ein memory`를 사용할 수 있습니다. 터미널 전용 프로젝트는 작업 폴더에서 한 번 등록하세요. 아래 예제는 프로젝트 ID를 `catalog`로 정하고 검색 인덱스에 관한 결정 하나를 저장합니다.

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

ein memory search --query "검색 인덱스"
ein memory read --id search-index-owner --format markdown
```

같은 프로젝트의 하위 폴더에서 위 검색을 실행해도 같은 기억을 찾습니다. 검색 결과에는 기억 ID와 Git revision이 들어 있습니다. 기존 기억을 수정할 때는 `memory read`로 확인한 revision을 `--if-revision`에 넣고 새 요청 ID를 사용하세요. 같은 저장을 재시도할 때는 원래 요청 ID를 다시 사용합니다.

### 프로젝트와 폴더를 연결하는 규칙

- Slack 프로젝트는 `EIN_CONFIG`가 가리키는 파일에서 읽습니다. 기본값은 `~/.config/ein/config.json`입니다. 상대 프로젝트 경로는 이 파일이 있는 폴더를 기준으로 해석합니다. Slack 토큰 없이도 등록 정보를 사용할 수 있습니다.
- Sniffer에 직접 등록한 폴더는 `$EIN_HOME/config.json`에 보관합니다. 같은 ID에 등록한 여러 작업 폴더는 기억을 공유합니다. 터미널에서는 실제 경로를 기준으로 가장 깊게 일치하는 등록 폴더를 선택합니다. 중첩 폴더가 별도 프로젝트로 등록돼 있으면 그 프로젝트의 기억을 사용합니다.
- 검색 범위는 해당 프로젝트, 명시적으로 연결한 상위 그룹, `global`입니다. 형제 프로젝트 전용 기억은 검색에서 제외합니다. Slack 프로젝트를 처음 사용할 때는 필요한 Git 범위를 만들며, 이미 연결된 그룹이 있으면 그 계층을 사용합니다. 그룹에 공유할 기억은 `memory promote --dry-run`으로 대상 범위를 확인할 수 있습니다. [기억 형식과 범위](docs/STORAGE.md)

## Slack에서 작업 이어가기

가령 Slack 설정의 `projects.catalog.path`가 위 폴더를 가리킨다면, 소유자가 `ein orchestrate` 실행 중인 봇에 “`project:catalog` 상품 인덱스 작업 이어줘”라고 요청할 수 있습니다. 프로젝트를 배정한 뒤 아인은 에이전트 턴에 프로젝트 ID, 등록 루트, 작업 디렉터리, 사용할 Sniffer 실행 파일과 설정 위치를 함께 넘깁니다. 에이전트는 그 범위에서 이전 결정과 인수인계를 검색하고 필요한 기억을 읽습니다. 공유 라우팅·검토 단계와 프로젝트 미지정 턴에는 프로젝트 기억을 연결하지 않습니다. [Slack 오케스트레이션](../docs/slack-cli.md)

## 터미널 에이전트에서 자동 회상하기

등록한 폴더에서 `ein run claude`, `ein run codex`, `ein run agy` 중 사용할 제품을 실행하세요. 해당 제품의 CLI와 로그인은 그 제품의 설치 환경을 사용합니다. Codex에서 hook 신뢰 확인이 표시되면 설치 경로와 명령을 확인하세요.

| 제품 | 읽기 전용 기억 에이전트가 동작하는 방식 |
| --- | --- |
| Claude Code | TS mod가 네이티브 하위 에이전트를 만들고 같은 대화에 후속 관찰을 전달합니다. Go 엔진은 필요할 때 호출합니다. |
| Codex | hook이 메인 세션의 관찰을 전달하고, 별도 `codex app-server` 스레드에서 기억 대화를 이어갑니다. |
| Antigravity CLI | hook과 지속적인 `agy` 스트리밍 대화를 연결하고, 별도 reader MCP로 검색·읽기를 제공합니다. |

기억 에이전트는 검색어를 고르고 본문을 읽은 뒤 관련 기억의 ID와 revision을 반환합니다. Go 엔진은 실제 본문을 전달하기 전에 최신 버전, 허용 범위, 이전 전달 여부를 확인합니다. 저장과 상위 범위 공유는 메인 모델의 별도 writer 요청 또는 명시적 CLI 명령으로 수행합니다. 한영 검색어, Git 기반 충돌 처리, 중단된 쓰기 복구는 v0.4.0의 공통 엔진을 사용합니다. [제품별 연결](docs/INTEGRATIONS.md) · [엔진 구조](docs/ARCHITECTURE.md) · [운영·복구](docs/OPERATIONS.md)

## 검증과 출처

코드와 어댑터의 기준은 참고 대화에서 제공된 `ein-sniffer-v0.4.0.zip`입니다. 샘플의 가상 기억은 설치 시 실제 저장소에 추가되지 않습니다. 데모를 실행하면 임시 저장소에 여섯 개의 가상 기억을 만든 뒤 한영 검색, 형제 프로젝트 격리, 상위 범위 공유 미리보기와 저장 재시도를 확인합니다. [장기 메모리 프로토타입 대화](https://chatgpt.com/c/6b0506b7-be18-83ec-99ab-229eb00c40b4) · [샘플 데이터](examples/README.md) · [라이선스와 출처](PROVENANCE.md)

```sh
# sniffer/에서 실행
go test -race ./...
node --test adapters/claude-mod/hooks/register.test.mjs
bash scripts/demo.sh
```

Go 테스트와 Claude 어댑터 계약 테스트는 실제 모델 계정 없이 실행합니다. 설치한 제품의 CLI 기능은 `sniffer doctor --host codex`처럼 확인할 수 있고, 로그인·모델 접근 권한·실제 회상 품질은 각 제품 세션에서 확인해야 합니다.
