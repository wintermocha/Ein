# Ein Slack CLI 운영 가이드

배포본을 설치했다면 터미널에서 `ein`을 사용한다. 소스에서 실행할 때는 저장소 루트에서 `ein` 대신 `bun run ein`을 사용한다. [프로젝트 소개와 빠른 시작](../README.md)

아인은 Slack 대화를 수신하고 스레드별 작업 세션을 배정하는 Bun CLI다. 에이전트 답변을 사용하려면 `orchestrate`를 시작하기 전에 설정 파일의 `runner`에 `omo`, `claude`, `codex` 중 하나를 지정한다. 프로젝트를 정할 수 있는 요청은 담당 세션으로 바로 보내고, 해석이 필요한 요청은 Ein 전용 메인 세션에 맡긴다.

[Slack 대화 흐름과 전체 설정표](slack-session-map.html) · [수신기·오케스트레이터·메인 구현 상세와 검증 범위](components.html)

## 토큰 없이 실행해 보기

저장소 루트에서 예제 설정과 이벤트를 사용한다.

```sh
bun install --frozen-lockfile
EIN_CONFIG=examples/config.json bun run ein check
EIN_CONFIG=examples/config.json bun run ein replay < examples/events.jsonl
bun test
bun run typecheck
```

예제 이벤트 다섯 개를 재생하면 멘션 한 줄, 봇이 참여한 스레드의 후속 질문 한 줄, 그 봇 답글에 달린 이모지 한 줄이 나온다. `replay`는 표준 입력에서 한 줄당 하나의 Slack `event_callback` JSON을 읽고 메모리에서만 실행한다. `check`는 설정 문법과 필드를 오프라인으로 검사한다.

Bun 1.4.2의 내장 `undici`에는 Slack SDK 3.2.0이 연결 상태 확인에 쓰는 `ping()`이 없다. 위 설치 명령은 저장소의 `package.json`에 등록된 패치를 적용해 SDK가 npm판 `undici`를 불러오게 한다. SDK나 Bun을 업그레이드할 때는 `bun test test/sdk-socket-integration.test.ts`로 실제 소켓의 heartbeat와 재연결도 확인한다.

## 처음 Slack에 연결하기

1. `ein setup`을 실행한다. 기본 설정 경로는 `~/.config/ein/config.json`이다. 다른 위치를 쓰려면 `EIN_CONFIG`에 새 설정 파일의 경로를 지정한다. 새 앱이면 CLI가 보여주는 JSON을 Slack의 **Create New App → From a manifest**에 붙여넣는다. 기존 앱이면 필요한 구독과 권한을 확인한다. 앱의 **Basic Information**에서 App ID를 복사해 입력한다.
2. **Basic Information → App-Level Tokens**에서 `connections:write` 앱 토큰을 만든다. **OAuth & Permissions**에서 워크스페이스에 앱을 설치하고 봇 토큰을 복사한다. 터미널의 숨김 입력란에 각각 붙여넣는다. 기존 `EIN_APP_TOKEN`과 `EIN_BOT_TOKEN`도 쓸 수 있다. 환경변수를 사용하면 이후 실행에도 같은 환경이 필요하다.
3. 터미널에 표시된 링크에서 Ein에게 일회용 코드를 1:1 DM의 새 메시지로 보낸다. CLI에 표시된 사용자 ID가 본인인지 확인하고 승인한다. Ein이 같은 DM에 **“연결됐어요”**라고 답하면 로컬 설정이 완성된다.

소유자를 확정하면 아인은 `Ein-<Slack 앱 ID>`를 herdr 워크스페이스 이름으로 설정에 저장한다. herdr가 설치돼 있으면 전용 서버 `ein`에서 워크스페이스를 준비한다. herdr를 나중에 설치해도 서버를 시작하고 첫 작업을 보내면 같은 이름의 워크스페이스가 생성된다.

중단한 뒤 같은 `EIN_CONFIG`로 `ein setup`을 다시 실행하면 앱 선택, 개별 토큰 입력, DM 수신까지 마친 지점에서 이어간다. DM을 보내기 전에 중단했다면 새 코드를 사용한다. `ein setup --status`로 다음 단계를 확인한다. 앱 선택 후 설정 파일이 생성되기 전까지는 `ein setup --tokens`로 입력한 토큰을 교체할 수 있다. 설정 파일이 이미 있으면 `ein check`로 검사하고, 토큰을 교체할 때는 사용 중인 환경변수나 설정의 `appTokenFile`·`botTokenFile`이 가리키는 파일을 갱신한다.

확인 답장을 보내는 도중 연결이 끊기면 같은 명령으로 재개한다. Ein이 해당 DM에서 이전 답장의 전송 기록을 확인하고 설정 저장을 마친다.

Codex에서 이 저장소를 열고 `$ein-setup`으로 연결을 요청하면 같은 과정을 대화로 진행한다. 토큰 입력만 사용자의 로컬 터미널에서 진행한다. 완료된 설정은 DM 수신용이다. `ein listen`으로 실행하고, 채널 멘션은 `watchChannels`에서 추가한다. [온보딩 스킬](../.agents/skills/ein-setup/SKILL.md)

## 수동 설정과 기존 설치 업그레이드

기존 설치에서 업그레이드할 때는 수신기를 종료한 뒤 `EIN_CONFIG`로 기존 설정 파일을 지정한다. 설정에서 `stateFile`을 생략했다면 기존 SQLite 파일의 절대 경로를 명시한다. 같은 스레드에서 작업을 이어가려면 DB와 그 옆의 `<stateFile>.orchestration/` 디렉터리, 등록한 프로젝트 ID와 작업 경로를 유지한다. 셸이나 서비스에 토큰을 등록했다면 환경변수 이름을 `EIN_APP_TOKEN`, `EIN_BOT_TOKEN`으로 바꾼다.

아인은 Bun에서 Slack 공식 `@slack/socket-mode` 클라이언트로 이벤트를 받는다. 봇 신원 확인, 연결 공백의 기록 조회, 답글 게시는 기존처럼 봇 토큰으로 Slack Web API를 호출한다. `listen`과 `orchestrate`는 같은 수신기를 사용한다. [Slack Node SDK](https://docs.slack.dev/tools/node-slack-sdk/)

1. 새 앱을 만들 때는 [Ein 앱 매니페스트](../examples/slack-manifest.json)를 사용한다. 기존 Slack 앱을 계속 쓸 때는 현재 매니페스트에 필요한 구독·권한만 추가한다. 기존 앱을 쓰면 봇 ID와 기존 DM이 이어진다. 새 앱은 별도의 봇 ID와 DM을 갖는다.
2. Socket Mode를 켜고 **Basic Information → App-Level Tokens**에서 `connections:write`가 있는 앱 토큰(`xapp-`)을 만든다. 봇 이벤트로 `app_mention`, `message.im`, `message.channels`, `message.groups`, `reaction_added`를 구독한다. [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
3. 봇에 `app_mentions:read`, `im:history`, `channels:history`, `groups:history`, `reactions:read`를 부여한다. `chat:write`는 오케스트레이터가 원래 대화에 답변을 게시하는 데도 쓰인다. 변경된 권한을 적용하려면 앱을 워크스페이스에 설치하거나 재설치하고, 감시할 공개·비공개 채널에 봇을 초대한다. [Slack App Home](https://docs.slack.dev/surfaces/app-home/#using-the-messages-tab)
4. [예제 설정](../examples/config.json)을 `~/.config/ein/config.json`에 복사해 예시 ID를 실제 값으로 교체한다. `team`은 워크스페이스 ID, `appId`는 앱 설정의 App ID, `botUser`는 봇 사용자 ID, `ownerUser`는 소유자의 사용자 ID다. `ownerDm`은 선택 사항이며 지정하면 처음 보는 소유자 DM도 연결 공백 복구에 포함된다. `watchChannels`는 멘션을 받을 채널 목록이다.
5. 앱 토큰과 같은 앱의 봇 토큰(`xoxb-`)을 각 토큰 파일에 따로 저장하고 파일 권한을 `600`으로 설정한다. 환경변수 `EIN_APP_TOKEN`, `EIN_BOT_TOKEN`도 지원한다. 설정의 상대 경로는 설정 파일 위치를 기준으로 해석한다. 아인은 시작할 때 봇 토큰의 팀·사용자 ID와 Socket Mode의 앱 ID를 대조한다.

`blockedUsers`에 차단할 Slack 사용자 ID를 지정한다. 차단은 DM·멘션·스레드 답글·이모지에 공통으로 적용된다. `otherUserReplyRate`에는 채널별로 0~1의 숫자를 둔다. 해당 채널에서 소유자 외 사용자의 이벤트에 `REPLY=yes` 또는 `REPLY=no`가 붙는다. 수신기만 실행할 때는 리드가 답장을 결정한다. 오케스트레이션 모드에서 소유자 외 사용자는 응답 대상으로 선정되면 안내문을 받는다. 에이전트에 작업을 전달할 수 있는 사용자는 `ownerUser`다.

### 일반 Slack 봇과 Slack Agent

기본 매니페스트는 봇 사용자를 가진 Slack 앱을 만든다. DM·멘션을 받아 아인의 로컬 에이전트에 작업을 맡기고 스레드에 답하는 데 이 설정이면 충분하다.

Slack Agent는 앱에 Agent 대화 화면과 세션 기능을 추가하는 선택지다. 두 구성 모두 같은 Socket Mode를 사용할 수 있고, Agent 화면에서 사용자가 입력한 DM도 `message.im`으로 전달된다. 새 Agent 앱은 매니페스트의 `features.agent_view`에 `agent_description`을 지정한다. Slack에서 Agent로 표시하려면 봇 권한 `assistant:write`를 사용한다. 일부 Agent 기능은 유료 Slack 플랜이 필요하다. [Socket Mode를 쓰는 공식 Agent 예제](https://github.com/slack-samples/bolt-js-starter-agent/blob/main/claude-agent-sdk/manifest.json) · [Slack Agent 설정과 이벤트](https://docs.slack.dev/ai/developing-agents/)

아인이 현재 처리하는 범위는 메시지·멘션·반응과 일반 답글이다. Agent 화면에서 사용자가 보는 채널을 읽으려면 `app_context_changed` 구독과 처리가 필요하다. 진행 상태와 중지 버튼을 연결하려면 `agents.sessions.setStatus` 호출과 `agent_session_stopped`를 실제 작업 취소에 연결하는 구현이 필요하다. [Slack Agent 세션](https://docs.slack.dev/ai/agent-sessions/)

## 수신기 실행

```sh
ein listen
```

아인은 첫 연결 시점부터 이벤트를 받는다. 감시 채널의 오래된 스레드도 새 멘션이 오면 리드에게 전달한다. 봇이 원글이나 답글을 쓴 것을 확인하면 해당 스레드를 자동으로 기록하고, 이후 멘션 없는 답글도 전달한다. 수신 기록은 기본적으로 `~/.local/state/ein/inbound.sqlite`에 저장한다.

리드에는 stdout을 연결하고 운영 진단은 stderr에서 확인한다. 같은 Slack 앱에 여러 Socket Mode 연결을 열면 이벤트가 연결 간에 나뉜다. Gateway CA가 필요한 Mac에서는 신뢰하는 PEM 경로를 `NODE_EXTRA_CA_CERTS`로 지정한다. 실행 스크립트는 Bun의 `--use-system-ca`를 사용한다.

## 리드 입력 계약

```text
INBOUND <source> <channel> <threadTs> <ts> <user> "<JSON-escaped text>" [REPLY=yes|REPLY=no]
```

| source | 전달 조건 |
| --- | --- |
| `dm`, `dm-thread` | 봇이 받은 1:1 DM의 원글 또는 답글 |
| `mention`, `thread-mention` | 감시 채널의 원글 또는 답글에서 봇 멘션 |
| `own-thread` | 봇이 원글이나 답글을 쓴 것으로 확인된 스레드의 일반 답글 |
| `reaction` | 봇 게시물에 추가된 이모지. `ts`는 반응 시각, 본문은 `:emoji:` |

`threadTs`는 원글의 Slack 타임스탬프다. 아인이 관찰하기 전 작성된 봇 답글은 원글을 모를 수 있어 반응 대상의 타임스탬프를 사용한다. 멘션과 참여 스레드 조건이 겹치면 멘션이 우선한다. 일반 메시지의 중복 키는 채널과 `ts`이며, 이모지는 대상·사용자·이름·이벤트 시각을 구분한다. 본문 안의 개행과 따옴표는 JSON으로 이스케이프하고, Slack 토큰과 Bearer 자격증명 패턴은 가린다.

## 저장과 복구 범위

- 아인은 처리할 이벤트의 중복 키와 대기 항목(`listen`의 출력 또는 `orchestrate`의 작업)을 SQLite에서 함께 커밋한 뒤 SDK의 `ack()`를 호출한다. 이 ACK는 아인이 요청을 접수했다는 뜻이다. 커밋에 실패하면 ACK를 보내지 않는다. 커밋 직후 ACK가 유실돼도 Slack이 다시 보낸 메시지는 같은 키로 걸러진다.
- `listen`은 stdout 출력에 성공하면 본문을 비우고 중복 키를 유지한다. stdout 쓰기 직후 완료 표시 전에 강제 종료되면 마지막 줄이 다시 나갈 수 있다. 외부 작업까지 한 번만 실행해야 한다면 리드도 같은 식별자로 처리 여부를 기록한다.
- 소켓이 끊기거나 Mac이 잠든 뒤에는 감시 채널, 알려진 DM, 알려진 스레드를 저장된 위치부터 페이지 단위로 읽는다. 삭제된 스레드는 건너뛰고, 권한 오류나 불완전한 조회가 있으면 커서를 유지해 재시도한다. Slack의 `Retry-After`를 따르며, 반복되는 연결·복구 오류는 2분 이상 계속될 때 stderr에 한 번 표시한다. 추적하는 스레드가 많으면 복구 시간도 늘어난다. [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/) · [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/)
- 연결 중에는 스레드 생성 시점과 무관하게 구독 이벤트를 처리한다. 오프라인 중 처음 생긴 미등록 DM, 이미 오래된 미관찰 스레드의 새 답글·멘션, 이모지 추가 이력은 메시지 기록 조회만으로 모두 복원할 수 없다. Slack도 Events API를 best effort로 제공한다. [Slack Events API](https://docs.slack.dev/apis/events-api/)

## 작업 세션과 Slack 답변 연결

1. 설정 최상위의 `runner`에 설치한 실행기 하나를 넣는다. 이 실행기와 `herdr`가 아인을 실행하는 셸의 PATH에 있어야 한다.
   새 세션에서 쓸 모델은 같은 파일의 `models.claude`, `models.codex`, `models.omo`에서 선택한다. 생략하면 각각 `claude-opus-5-5`, `gpt-6.2-astra`, OMO 자체 기본값을 사용한다. 설정 파일을 고친 뒤 `ein orchestrate`를 다시 시작하면 다음 새 세션부터 적용된다. 기존 Slack 세션을 재개할 때는 실행기가 저장한 모델 설정을 따른다.
2. `projects`에 작업 디렉터리를 등록한다. 예제의 `projects.ein.path` 값 `..`는 `examples/`를 기준으로 한 저장소 루트다. 설정을 복사했다면 실제 저장소 경로로 바꾼다. `channels`에는 이 프로젝트 전용 채널을 넣고, 그 채널에서 멘션도 받으려면 `watchChannels`에도 추가한다.
3. 온보딩에서 시작한 herdr 서버가 실행 중이면 다음 단계로 넘어간다. 수동 설치나 재부팅 후 서버가 꺼져 있으면 별도 터미널에서 아래 명령으로 시작한다. 작업 탭은 서버의 환경을 상속하므로 Slack 토큰은 다음 단계의 Ein 프로세스에 제공한다.

```sh
env -u EIN_BOT_TOKEN -u EIN_APP_TOKEN herdr --session ein server
```

기존 설치에 저장된 세션은 생성 당시의 `hogu` 서버와 pane 이름을 사용한다. 그 세션도 재개할 때는 기존 herdr 서버를 함께 실행한다.

4. Slack에 연결하고 작업을 처리할 터미널에서 아래 명령을 실행한다. 같은 앱에서 `listen`도 실행하면 Slack이 연결 간에 이벤트를 나눈다. 실제 수신 프로세스를 전환할 때는 한쪽만 연결한다.

```sh
ein orchestrate
```

진행 중인 작업을 보려면 다른 터미널에서 `herdr session attach ein`을 실행한다. `ein setup --status`에 표시된 워크스페이스를 고르면 메인 세션과 Slack 대화·프로젝트 세션이 각각 탭으로 열린다. 새 탭이 생겨도 보고 있던 탭의 포커스는 유지된다. Codex와 Claude Code 탭에는 대화형 CLI가, OMO 탭에는 응답과 도구 실행 상황이 표시된다.

수동 설정에서 워크스페이스 이름을 정할 때는 `herdrWorkspace`에 넣는다. 이 필드가 없는 기존 설정은 새 탭을 `Ein` 워크스페이스에 연다. 업그레이드 전에 이미 실행 중이던 세션은 기존 탭에서 이어간다.

소유자가 공용 채널에서 봇을 멘션해 `project:ein 테스트 결과를 확인해 줘`라고 보내면 등록한 경로에서 세션이 열린다. 같은 스레드의 후속 질문은 기존 담당에게 간다. 전용 채널에는 프로젝트 지정을 생략할 수 있다. 응답은 원래 스레드로, 일반 1:1 DM은 최상위 DM으로 돌아온다. 프로젝트 단서가 충돌하거나 작업 위치가 모호하면 메인이 질문할 수 있다.

첫 멘션을 받은 담당 세션에는 현재 요청과 그 전에 오간 대화가 함께 전달된다. 앞선 대화는 메시지마다 `작성자 ID: 본문`으로 세고 줄바꿈을 포함해 1,000자 이하면 모두 보여 준다. 1,000자를 넘으면 원글과 가장 최근 답글을 발췌하고, 세션이 필요할 때 읽을 수 있도록 전체 대화를 로컬 JSON 파일로 전달한다. 현재 멘션은 이 글자 수에서 제외한다. 파일은 해당 세션의 결과 디렉터리에 소유자만 읽고 쓸 수 있게 저장한다.

같은 세션의 다음 턴에는 마지막으로 전달한 요청 이후부터 현재 요청 직전까지의 새 메시지만 붙인다. 새 대화만으로 1,000자를 넘으면 그 구간을 파일로 전달한다. 다른 프로젝트 세션이 스레드에 처음 합류하면 그 세션은 처음부터 문맥을 받는다. Slack 기록 조회가 실패하면 세션은 현재 요청으로 진행하고 필요할 때 사용자에게 묻는다. 마지막 전달 위치는 유지해 다음 턴에 누락 구간을 다시 조회한다.

프로젝트가 확정된 소유자 턴은 `EIN_TURN.memoryScope`로 등록 ID, 루트, 작업 디렉터리와 Sniffer 호출 환경을 받는다. 에이전트가 받은 경로에서 `memory search`와 `memory read`를 호출하면 해당 프로젝트와 허용된 상위 범위의 기억을 읽는다. 다른 프로젝트로 위임한 턴은 그 프로젝트를 사용하고, 원래 대화로 돌아오면 원래 프로젝트를 사용한다. 공유 라우팅 세션과 프로젝트 미지정 턴은 프로젝트 기억을 조회하지 않는다. 터미널에서도 같은 `EIN_CONFIG`와 `EIN_HOME`을 사용하면 별도 등록 없이 이어갈 수 있다. [Sniffer 사용법](../sniffer/README.md)

작업 중 설정의 실행기를 바꾸고 재시작해도 기존 세션은 생성 당시 실행기와 고유 ID를 사용한다. SQLite 파일과 그 옆의 `<stateFile>.orchestration/` 디렉터리를 함께 보존한다. 실행 결과나 Slack 전송 여부가 불명확하여 보류된 건의 의미는 [장애 복구 안내](components.html#recovery)에서 확인할 수 있다.

OMO 5.1.59와 Codex 0.140.0은 기존 pane을 닫은 뒤 같은 세션 ID로 재개하는 것까지 확인했다. 두 실행기 모두 로컬 모델 대역과 실제 파일 도구로 Ein 결과 파일을 작성하고 회수하는 검사도 통과했다. Claude 실기동, 운영 Slack과 외부 모델을 연결한 왕복은 미검증이다. [실행기별 검증 범위](components.html#verification)

herdr는 별도의 Apache-2.0 프로젝트다. [herdr v0.9.5](https://github.com/herdrdev/herdr/tree/v0.9.5) · [라이선스](https://github.com/herdrdev/herdr/blob/v0.9.5/LICENSE)
