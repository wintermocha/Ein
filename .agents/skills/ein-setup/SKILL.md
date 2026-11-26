---
name: ein-setup
description: Ein 저장소에서 Slack 앱 설치와 소유자 DM 연결을 대화로 안내하거나 중단한 초기 설정을 이어간다. 사용자가 Ein에 Slack을 처음 연결하거나 DM 연결 확인을 요청할 때 사용한다.
---

# Ein Slack 연결

Ein 저장소 루트에서 `bun run ein setup --status`를 실행한다. 같은 설정을 이어가도록 모든 명령에 같은 `EIN_CONFIG`와 작업 디렉터리를 사용한다. 기존 설정 파일이 있으면 그 사실을 알리고 초기 설정을 종료한다. 한 번에 현재 단계의 질문 하나만 한다.

1. 앱을 선택해야 하면 새 앱을 만들지 기존 앱을 쓸지 묻는다. [Slack 앱 관리](https://api.slack.com/apps)로 안내한다. 새 앱이면 `bun run ein setup --manifest`의 JSON을 **Create New App → From a manifest**에서 붙여넣도록 보여준다. 기존 앱이면 매니페스트의 Socket Mode, 이벤트 구독, 봇 권한을 비교하고 필요한 항목을 추가하도록 안내한다. 사용자가 **Basic Information**의 App ID를 알려주면 `^A[A-Z0-9]+$` 형식인지 확인하고 `bun run ein setup --app <App ID>`로 저장한다.
2. 토큰이 필요하면 Slack의 **Basic Information → App-Level Tokens**에서 `connections:write` 앱 토큰을 만들고, **OAuth & Permissions**에서 앱을 설치한 뒤 봇 토큰을 복사하도록 안내한다. 사용자 본인이 저장소의 로컬 터미널에서 `bun run ein setup --tokens`를 실행해 숨김 입력란에 붙여넣는다. 토큰을 채팅이나 명령 인수로 받거나 파일·환경변수 값을 출력하지 않는다. 이미 설정된 토큰은 CLI가 읽는다. 사용자가 입력을 마치면 상태를 다시 확인한다.
3. DM 확인 차례에는 `bun run ein setup --pair`를 출력이 스트리밍되는 실행 세션으로 시작한다. 소켓 준비 후 출력된 Slack 링크와 일회용 코드를 사용자에게 바로 전달하고, 자기 Slack 계정에서 해당 앱에 코드를 DM으로 보내도록 안내한다. 같은 프로세스가 수신을 마칠 때까지 유지한다. 시간 초과나 중단 시 CLI가 발급하는 새 코드로 다시 시도한다.
4. 이미 DM을 수신한 상태라면 이 단계부터 시작한다. CLI가 표시한 워크스페이스와 사용자 ID를 보여주고, **이 계정을 소유자로 등록하고 같은 DM에 확인 답장을 보낼지** 묻는다. 사용자가 동의하면 `bun run ein setup --confirm <표시된 사용자 ID>`를 실행한다. 다른 계정이라면 새 코드로 다시 연결한다. 확인 명령이 성공하면 연결 완료를 알린다.
