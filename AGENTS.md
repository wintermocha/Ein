# Ein 작업 방식

새 작업은 최신 `main`에서 작업 브랜치를 만든 뒤 시작한다. 브랜치 이름은 `<도구>/<작업-설명>` 형식으로 짓고, 작업에 사용하는 도구에 따라 접두사를 고른다.

| 작업 도구 | 접두사 | 기억 검색 개선 작업의 예 |
| --- | --- | --- |
| Claude Code | `cc/` | `cc/improve-memory-search` |
| Antigravity | `agy/` | `agy/improve-memory-search` |
| Codex | `codex/` | `codex/improve-memory-search` |

변경 사항은 작업 브랜치에 커밋한다. 관련 테스트와 diff를 확인한 뒤 완료된 작업 브랜치를 `main`에 머지한다.
