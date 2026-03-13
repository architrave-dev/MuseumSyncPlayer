# Video Player for Museum

전시 환경에서 여러 기기가 서로 다른 영상을 재생하더라도 같은 시간축으로 동기화되도록 만든 브로드캐스트 플레이어입니다.

## 개요

- 서버는 하나의 공통 재생 상태와 시간을 유지합니다.
- admin은 재생, 정지, 처음부터, 점프 이동을 제어합니다.
- viewer는 접속 시 재생할 슬롯 번호를 직접 선택해야 합니다.
- 각 슬롯은 서로 다른 HLS 영상일 수 있지만, 시간축은 서버 기준으로 함께 움직입니다.
- HLS manifest와 segment는 S3/CloudFront에서 직접 내려받습니다.

## 실행

1. 프로젝트 루트의 `.env` 에 `ADMIN_KEY`, `MEDIA_BASE_URL`, `MEDIA_PREFIX`, `VIDEO_SLOTS` 가 설정되어 있어야 합니다.
2. 패키지를 설치하고 서버를 실행합니다.

```bash
npm install
npm start
```

3. 로컬에서는 `http://localhost:3000` 으로 접속합니다.
4. 같은 네트워크의 다른 기기에서는 `http://<이 컴퓨터의 IP>:3000` 으로 접속합니다.

## 사용 방식

- admin 접속: `http://<host>:3000/?adminKey=<ADMIN_KEY>`
- viewer 접속: `http://<host>:3000`
- admin은 1번 슬롯 기준으로 제어 권한을 가집니다.
- viewer는 서버가 알려주는 사용 가능한 슬롯 번호 중 하나를 선택합니다.
- viewer 슬롯 선택창에서 `Cancel` 을 눌러도 자동 배정되지 않으며, 유효한 번호를 입력할 때까지 다시 선택해야 합니다.
- 재생 시작, 처음부터, 루프 재시작은 서버 기준 `5초` 카운트다운 후 동시에 시작합니다.
- admin 화면에는 현재 영상 길이를 기준으로 계산된 `1/4`, `1/2`, `3/4` 이동 버튼이 표시됩니다.
- 점프 버튼 라벨은 현재 영상 길이 기준으로 계산되며 `10초 단위 내림` 규칙을 사용합니다.
- 점프 이동은 admin과 viewer 모두에게 `3초`, `2초`, `1초` 카운트다운이 표시된 뒤 같은 시각에 적용됩니다.
- iPhone viewer는 평소 미세 오차 보정에서는 seek를 피하지만, admin이 명시적으로 점프한 경우에는 강제 seek로 해당 지점으로 이동합니다.
- 영상 종료 시 서버가 0초부터 다시 시작하도록 브로드캐스트합니다.

## 미디어 구조

서버는 로컬 파일을 스캔하지 않고 `.env` 설정을 바탕으로 HLS URL을 조합합니다. 실제 재생 경로는 아래 패턴을 따릅니다.

```text
<MEDIA_BASE_URL>/<MEDIA_PREFIX>/01/hls/playlist.m3u8
<MEDIA_BASE_URL>/<MEDIA_PREFIX>/02/hls/playlist.m3u8
<MEDIA_BASE_URL>/<MEDIA_PREFIX>/03/hls/playlist.m3u8
...
```

정상 재생을 위해서는 CloudFront 또는 S3에서 `.m3u8`, `.ts` 파일에 대한 접근, MIME 타입, CORS 설정이 올바르게 되어 있어야 합니다.

## 선택 기능

- `scripts/build-hls.js` 는 로컬 `asset/` 폴더의 원본 영상을 HLS로 변환하는 보조 스크립트입니다.
- 실행 시 `asset-hls/` 출력 폴더를 새로 만들고 최대 8개 영상까지 슬롯 순서대로 인코딩합니다.
- 현재 런타임 재생은 S3/CloudFront 기준이므로, 이 스크립트는 로컬에서 HLS를 준비할 때만 사용합니다.

```bash
npm run build:hls
```

## 현재 파일 구성

```text
VideoPlayerForMuseum/
├── README.md
├── package.json
├── package-lock.json
├── server.js
├── app.js
├── index.html
├── styles.css
├── ontology.md
└── scripts/
    └── build-hls.js
```

## 기술 스택

- Node.js
- Express
- Socket.IO
- HTML5 Video
- Vanilla JavaScript
- `hls.js`

## 라이선스

무단 사용, 수정, 재사용 및 가공은 불가합니다. 사용이 필요한 경우 `architrave2025@gmail.com` 으로 문의해 주세요.
