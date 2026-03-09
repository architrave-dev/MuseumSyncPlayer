# Video Player for Museum

**전시/갤러리용 브로드캐스트 싱크 플레이어** — 하나의 영상을 여러 기기(iPhone 7·8 등)에서 같은 시점으로 재생·정지·루프합니다.

---

## 사용 방법 (단일 영상 + 여러 기기 싱크)

1. **영상 넣기**  
   - `asset` 폴더에 재생할 영상 파일을 하나 넣어 두세요. (`.mov`, `.mp4`, `.webm`, `.m4v` 지원)

2. **서버 실행**  
   ```bash
   npm install
   npm start
   ```
   - 브라우저에서 `http://localhost:3000` 접속

3. **여러 기기에서 접속**  
   - 같은 Wi‑Fi에서 iPhone·iPad 등에서 `http://<이 PC의 IP>:3000` 으로 접속  
   - 한 기기에서 **재생** 또는 **정지**를 누르면, 접속한 **모든 기기가 같은 시점으로 동기화**됩니다 (브로드캐스트).

4. **루프**  
   - 영상이 끝나면 서버가 0초부터 다시 재생하도록 알려 주어, 모든 기기가 함께 처음부터 재생합니다.

---

## CTO 기술 결정 요약

| 니즈 | 대응 |
|-----|------|
| 여러 기기에서 같은 시점 재생/정지 | 서버가 “진짜 시계”를 갖고, 재생/정지/시간을 Socket.io로 모든 클라이언트에 브로드캐스트 |
| iPhone 7·8 등에서 사용 | 웹 + Node 서버 한 대만 같은 Wi‑Fi에 두면 됨 |
| 수동 싱크 제거 | 한 기기에서만 재생/정지 누르면 전 기기 동기화 |

- **서버**: Node.js + Express(정적 파일 + `/api/video-url`) + Socket.io  
- **클라이언트**: 단일 `<video>`, 재생/정지/처음부터 버튼 → 서버에 이벤트 전송, 서버에서 내려준 `state` / `sync` / `time` 으로 `currentTime` 동기화

---

## 프로젝트 구조

```
VideoPlayerForMuseum/
├── README.md
├── package.json
├── server.js           # Express + Socket.io 브로드캐스트 서버
├── index.html
├── styles.css
├── app.js              # 단일 영상 + 서버와 싱크
├── asset/              # 여기에 영상 파일 한 개 넣기
└── config.example.js   # (참고용)
```

---

## 기술 스택

- **Node.js** + Express + Socket.io (서버가 재생 상태·시간을 브로드캐스트)
- **HTML5 Video** + Vanilla JS (클라이언트는 서버 시그널에 맞춰 재생/정지/seek)

---

## 라이선스 / 사용

전시·갤러리·예술가 개인 사용 목적으로 자유롭게 수정·배포 가능합니다.
