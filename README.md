<p align="center">
  <img src="docs/assets/ein.png" width="220" height="220" alt="캐릭터 배지가 달린 후드를 입고 노트북 앞에 앉은 코기 아인">
</p>

# project Ein

**project Ein(아인)**은 Claude, Codex, Antigravity를 오가며 개발할 때 필요한 도구를 한곳에 모아 설치할 수 있도록 만든 프로젝트입니다. 이름은 《카우보이 비밥》의 코기 아인에서 따왔습니다.

## 지금 쓸 수 있는 도구

**Ein Slack CLI**는 Slack 대화를 로컬 코딩 에이전트에 연결합니다. 예를 들어 Slack에서 봇을 멘션해 `project:ein 테스트 결과를 확인해 줘`라고 보내면, 아인이 등록된 프로젝트 폴더에서 작업 세션을 열고 결과를 같은 스레드에 답합니다. 그 스레드에서 “실패한 테스트만 다시 봐 줘”라고 하면 같은 세션이 작업을 이어갑니다.

Slack 작업을 맡길 실행기는 설정의 `runner`에서 하나를 고릅니다. 현재 선택지는 Claude Code(`claude`), Codex CLI(`codex`), OMO(`omo`)입니다. Antigravity에서도 프로젝트를 열고 아래 명령을 실행할 수 있습니다. Slack 실행기로 Antigravity를 직접 지정하는 기능은 아직 없습니다.

## 설치하고 첫 이벤트 받아 보기

Bun이 설치된 환경에서 저장소 루트로 이동해 다음 명령을 실행합니다. 예제는 로컬 파일을 사용하므로 Slack 계정이나 API 토큰 없이 실행할 수 있습니다.

```sh
bun install --frozen-lockfile
EIN_CONFIG=examples/config.json bun run ein check
EIN_CONFIG=examples/config.json bun run ein replay < examples/events.jsonl
```

`check`가 `Ein config OK (offline).`을 출력하면 설정을 읽은 것입니다. `replay`는 예제 이벤트 다섯 건을 읽어 봇 멘션(`mention`), 같은 스레드의 후속 질문(`own-thread`), 답글에 달린 반응(`reaction`)을 한 줄씩 출력합니다.

## 내 Slack에 연결하기

의존성을 설치한 뒤 저장소 루트에서 실행합니다.

```sh
bun run ein setup
```

안내에 따라 Slack 앱을 만들거나 기존 앱을 선택하고, 두 토큰을 입력한 뒤 Ein에게 확인 코드를 DM으로 보냅니다. 터미널에서 소유자 계정을 확인하면 Ein이 같은 DM에 **“연결됐어요”**라고 답합니다. 중간에 멈췄다면 같은 명령으로 이어갑니다.

Codex에서 이 저장소를 열고 **“`$ein-setup`으로 Slack 연결해 줘”**라고 요청해도 됩니다. 에이전트가 한 단계씩 안내하고, 토큰은 내 터미널에서 비공개로 입력합니다. [온보딩 스킬](.agents/skills/ein-setup/SKILL.md)

연결 후 `bun run ein listen`으로 DM을 받을 수 있습니다. 채널 멘션이나 에이전트 답변을 사용하려면 운영 가이드에서 추가 설정을 진행합니다. [Slack CLI 운영 가이드](docs/slack-cli.md) · [설정 예제](examples/config.json)
