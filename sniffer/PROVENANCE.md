# 출처와 라이선스 범위

## 독립 구현

Ein의 Sniffer는 Go로 새로 작성한 개인용 장기 기억 프로토타입입니다. 기존 제품의 구현 소스, 프롬프트, 테스트를 이 패키지에 복사하거나 번역하지 않았습니다. 데이터 schema, 검색 점수, 프로세스 구조, IPC, transaction journal, 전달 키, 테스트 fixture는 Sniffer에서 별도로 정의했습니다. 참조 프로젝트의 모듈이나 npm 패키지를 import하지 않습니다.

사용자가 지정한 다음 소스에서 committed 기억 조회, description 중심 탐색, 읽기 전용 판단과 쓰기의 분리, 반복 전달 억제라는 동작 원칙을 참고했습니다.

- 저장소: https://github.com/code-yeongyu/oh-my-openagent
- 고정 커밋: `615362696c6717908d0aafa540ce9d3ec71daeb1`
- [Kibitzer AGENTS.md](https://github.com/code-yeongyu/oh-my-openagent/blob/615362696c6717908d0aafa540ce9d3ec71daeb1/packages/omo-senpi/src/components/memory/kibitzer/AGENTS.md)
- [Kibitzer tools/memory.ts](https://github.com/code-yeongyu/oh-my-openagent/blob/615362696c6717908d0aafa540ce9d3ec71daeb1/packages/omo-senpi/src/components/memory/kibitzer/tools/memory.ts)
- [memory-core frontmatter.ts](https://github.com/code-yeongyu/oh-my-openagent/blob/615362696c6717908d0aafa540ce9d3ec71daeb1/packages/memory-core/src/memfs/frontmatter.ts)
- [고정 커밋의 LICENSE.md](https://github.com/code-yeongyu/oh-my-openagent/blob/615362696c6717908d0aafa540ce9d3ec71daeb1/LICENSE.md)

참조 저장소는 해당 커밋에서 Sustainable Use License를 사용합니다. 그 라이선스를 Sniffer 독립 코드의 라이선스로 재배포하지 않았습니다. 새로운 Sniffer 코드에는 이 패키지의 MIT LICENSE가 적용되고, 아래 의존성은 각자의 라이선스를 유지합니다. 원본을 읽은 후 독립적으로 구현한 작업이므로 정식 clean-room 절차를 수행했다고 주장하지 않으며 법적 적합성 인증도 아닙니다.

## 외부 의존성

| 의존성 | 고정 버전 | 용도·라이선스 |
|---|---|---|
| `go.yaml.in/yaml/v3` | v3.0.6 | YAML parser. Apache-2.0 / MIT, vendor 내 고지 참조 |
| `golang.org/x/text` | v0.44.0 | Unicode NFC·case folding. BSD-3-Clause, vendor 내 LICENSE/PATENTS 참조 |
| Go | 빌드 toolchain 1.27.4 | Go BSD-style 라이선스, 바이너리에 포함된 표준 라이브러리 고지는 THIRD-PARTY-NOTICES.txt 참조 |
| Git | 사용자의 설치본 | 별도 실행 프로그램. 이 패키지에 Git 바이너리를 배포하지 않음 |

의존성 버전과 무결성은 `go.mod`, `go.sum`, `vendor/modules.txt`에 고정합니다. 참조한 upstream Kibitzer 파일은 `vendor/`나 다른 배포 디렉터리에 포함하지 않습니다.

## 연결 API의 공식 자료

아래 링크를 확인한 기준일은 **2026-11-26 KST**입니다. 제품이 갱신될 수 있으므로 배포 코드도 설치된 CLI의 capability를 검사합니다.

### Claude Code

- https://code.claude.com/docs/en/plugins/mods/overview
- https://code.claude.com/docs/en/plugins/mods/events
- https://code.claude.com/docs/en/plugins/mods/api
- https://code.claude.com/docs/en/plugins/mods/reference
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/authentication

### Codex

- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/agent-configuration/speed

로컬 문서 확인에 사용한 Codex는 `0.172.0-alpha.2`입니다. 이는 사용자 Mac의 버전이나 모든 안정 버전의 최소 지원을 의미하지 않습니다.

### Antigravity CLI

- https://antigravity.google/docs/hooks
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/reference
- https://antigravity.google/docs/models
- https://antigravity.google/docs/subagents
- https://antigravity.google/docs/install

### MCP·빌드

- https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://go.dev/dl/
- https://pkg.go.dev/go.yaml.in/yaml/v3
- https://pkg.go.dev/golang.org/x/text

MCP transport는 newline-delimited JSON-RPC stdio만 구현합니다. Streamable HTTP MCP 서버나 전체 MCP 확장을 구현한 것으로 설명하지 않습니다. worker의 loopback HTTP는 Sniffer 전용 내부 프로토콜입니다.
