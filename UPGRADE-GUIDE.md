# 초보자용 GitHub + Render 업그레이드 안내

기존 Render 주소는 바뀌지 않습니다. GitHub의 파일만 새 버전으로 바꾸고 Render가 다시 배포하게 하면 됩니다.

## A. 새 파일 준비

1. `mafia-classroom-v2.zip`을 다운로드합니다.
2. 다운로드 폴더에서 ZIP 파일을 마우스 오른쪽 클릭합니다.
3. `모두 압축 풀기`를 누릅니다.
4. 생긴 `mafia-classroom` 폴더를 더블클릭합니다.
5. 그 안에 `server.js`, `package.json`, `public` 폴더 등이 보이면 맞습니다.

## B. GitHub에 새 버전 올리기

1. 브라우저에서 GitHub에 로그인합니다.
2. 기존에 만든 `mafia` 저장소를 엽니다.
3. 파일 목록 위의 `Add file` 버튼을 누릅니다.
4. `Upload files`를 누릅니다.
5. Windows 탐색기로 돌아와, 압축을 푼 `mafia-classroom` 폴더 **안의 내용 전체**를 선택합니다.
6. 선택한 내용을 GitHub의 `Drag files here to add them to your repository` 영역으로 끌어 놓습니다.
7. 업로드가 끝날 때까지 기다립니다.
8. 화면 아래 `Commit changes`를 누릅니다.
9. Commit message에는 `Upgrade mafia game to v2.2` 정도로 적고 다시 `Commit changes`를 누릅니다.

중요: GitHub 첫 화면에 `mafia-classroom/server.js`처럼 한 단계 안쪽에 들어가면 안 됩니다. 첫 화면에서 바로 `server.js`, `package.json`, `public`이 보여야 합니다.

## C. Render에서 새 버전 배포 확인

대부분은 GitHub에 Commit하면 Render가 자동으로 다시 배포합니다.

1. Render Dashboard를 엽니다.
2. 기존 `mafia` Web Service를 클릭합니다.
3. `Deploys` 화면을 봅니다.
4. 새 배포가 `Building` 또는 `Deploying`이면 기다립니다.
5. `Live`가 되면 완료입니다.

자동 배포가 시작되지 않았다면:

1. 오른쪽 위 `Manual Deploy`를 누릅니다.
2. `Deploy latest commit`을 누릅니다.
3. `Live`가 될 때까지 기다립니다.

## D. 새 버전 확인

1. 기존 `https://...onrender.com` 주소를 엽니다.
2. 옛 화면이면 `Ctrl + F5`를 눌러 강력 새로고침합니다.
3. 테스트 방을 만들고 학생 기기 3개 이상으로 접속합니다.
4. 역할 수 합계와 접속자 수를 맞춘 뒤 게임을 시작합니다.

확인할 것:

- 시작 직후 역할 화면이 15초만 보이는가?
- 마피아에게 다른 마피아 닉네임이 보이는가?
- 15초 뒤 역할이 사라지는가?
- 투표 종료 뒤 득표수가 10초 동안 보이는가?
- 단계가 바뀔 때 띵동 소리가 나는가?
- 역할 캐릭터 그림이 보이는가?

## 문제 발생 시

Render 배포 화면의 빨간 오류 메시지 또는 GitHub 저장소 첫 화면을 캡처해서 ChatGPT에 보내면 됩니다.

## v2.2로 올릴 때
기존과 동일하게 이 폴더 안의 파일 전체를 GitHub 저장소 루트에 업로드하여 덮어쓴 뒤 **Commit changes**를 누르세요. Render 자동 배포가 시작되지 않으면 **Manual Deploy → Deploy latest commit**을 누르면 됩니다. 기존 Render 주소는 바뀌지 않습니다.
