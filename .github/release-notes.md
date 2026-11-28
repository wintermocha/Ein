## Mac에 설치하기

터미널에서 아래 한 줄을 실행하면 Mac의 CPU에 맞는 패키지를 받아 SHA-256을 확인한 뒤 `~/.ein`에 설치합니다.

```sh
curl -fsSL https://github.com/wintermocha/Ein/releases/latest/download/install-release.sh | sh
```

다음 업데이트부터는 `~/.ein/bin/ein update`를 실행하세요. 새 릴리스가 있으면 설치하고, 이미 최신이면 현재 버전을 알려 줍니다.

Slack을 연결하려면 `~/.ein/bin/ein setup`을 실행하세요. 특정 버전을 설치하려면 해당 릴리스의 **Assets**에서 `install-release.sh`를 내려받아 `sh install-release.sh`로 실행하세요.
