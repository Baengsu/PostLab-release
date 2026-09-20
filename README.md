# PostLab

Chrome Manifest V3 사이드패널 확장.  
티켓링크(`www` / `facility`)에서 서버 시각 Sync, 예약·Auto Click Rec, 오픈예정→예매하기 교체, DECORD(스케줄 디코드·경기 표)를 제공합니다.

- 버전: `1.0.0` (`manifest.json`) · Public Release

## 로드

1. Chrome → `chrome://extensions` → 개발자 모드 ON  
2. **압축해제된 확장 프로그램 로드** → 이 폴더  
3. PostLab 아이콘 → 사이드패널  
4. 권한·스크립트 변경 후: 확장 새로고침 + 티켓링크 탭 새로고침

## 구성

| 파일 | 역할 |
|------|------|
| `manifest.json` | 권한 · content script · 사이드패널 |
| `background.js` | Sync · 예약 · Rec · MAIN 진입 · DECORD 창 |
| `sidepanel-v2.html` / `sidepanel.js` / `sidepanel-v2.css` | UI |
| `content.js` | Auto Click Rec |
| `content-exp.js` | 오픈예정 교체 |
| `decord/` | Body 디코드 · 경기 표 · CSV · PID/SID 등록 |
| `icons/` | 아이콘 |

## 포함하지 않음 (Public 컷)

이 배포본에서 의도적으로 뺀 것들:

- 좌석 매크로 클릭 / 구역·등급 자동 선택  
- 자동 캡챠 OCR / Gemini API  
- CDP (`chrome.debugger`) — 네트워크 녹화 · 강제 진입 · 요청 리플레이  
- Inspect / JS Probe / DOM·fiber 라이브 디버거  
- HIDE 미니창 · 백그라운드 전용 조작 UI  
- NetFunnel / 대기열 우회 실험 훅  
- 멀티 탭 · 멀티 계정 오케스트레이션  
- 예약 락(Lock) · 오프셋 고정 · 타이밍 프로파일  
- 네트워크 인터셉트 · 응답 패치 · 헤더 주입 실험  
- 외부 웹훅 연동  
- 실험용 이중 Auto Rec 엔진  
- npm 번들러 / TypeScript / 빌드 파이프라인  

Public = Sync · Rec · 오픈예정 교체 · DECORD 만.
