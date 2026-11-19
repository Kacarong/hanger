# kacarong.kr 개인 작업공간

## 방향 (2026-11-19 사용자와 합의)
- 드라이브가 중심이 아니라 개인 작업공간: 오늘 할 일 · 과제/할 일 · 캘린더 · 노트 · 클라우드(파일함) · 포트폴리오. 혼자 사용.
- 오늘 화면이 로그인 첫 화면: 지난 일, 오늘 날짜의 할 일·과제, 3일 안 마감 과제, 오늘 끝낸 일.
- 과제: 직접 입력(과목·마감일·시간·메모). 헬로 LMS 연동은 되면 나중에.
- 캘린더: 사용자 구글 캘린더와 연동(구글 OAuth에 캘린더 scope 추가 필요). 과제·할 일 날짜도 캘린더에 표시.
- 노트: 노션 같은 블록 편집기. 노트 속 체크박스+날짜 = 할 일(오늘·캘린더에 표시). 편집기 라이브러리 선택은 노트 단계에서.
- 포트폴리오: 공개용과 개인용 구분. 세부는 차차.
- 로그인: 비밀번호 로그인(5번 틀리면 15분 잠금) + 관리자 구글 계정 로그인. 비밀번호는 12자 이상, "kacarong"이 들어가면 안 된다(옛 기본값이 공개 저장소 기록에 있어서, 그런 비밀번호는 맞아도 로그인을 거부). 바꾸기: 작업공간 왼쪽 아래 "비밀번호 바꾸기"(비밀번호 로그인이면 지금 비밀번호 필요) 또는 서버에서 `bun run set-password`. 바꾸면 다른 로그인은 모두 해제.
- 순서: 오늘·과제/할 일(완료) → 캘린더 → 노트 → 클라우드 첨부 → 포트폴리오 공개/개인 구분.

## 결정 (2026-11-18 사용자와 합의)
- 웹: kacarong.kr = 공개 포트폴리오, /admin = 관리 (관리자 구글 계정 1개만).
- 저장: 사용자 구글 드라이브(유료 400GB). OAuth scope `drive.file` (앱이 만든 파일만). 삭제 = 드라이브 휴지통.
- 업로드: 서버가 resumable 세션만 열고(Origin 헤더 포함), 브라우저가 구글로 직접 PUT (16MB 조각). Cloudflare 100MB 제한·약관 회피.
- 다운로드: webContentLink (본인 구글 로그인 필요). 공유 = "링크가 있는 모든 사용자 보기" 권한. 공개 페이지는 공유된 항목만, 썸네일은 서버가 캐시.
- 파일당 1GB 미만. 앱: 웹사이트 그대로(TWA, 나중에). PC: Flutter Windows 업로드 전용 + 자동 업데이트 (나중에).
- 주소: unifi-site cloudflared 터널(.9, `~/.cloudflared/config.yml`)에 kacarong.kr ingress 추가 → 127.0.0.1:2992.

## 상태
- web/ 1차 구현 (디자인 없음): Bun + bun:sqlite, 의존성 없음. `bun test` = 가짜 구글 서버로 전체 흐름 검증.
- 2026-11-19: 비밀번호 로그인, 할 일·과제(tasks 테이블, /api/tasks, /api/today), /admin 탭(오늘/할 일·과제/파일함). 구글 환경변수 없이도 서버가 뜬다(구글 로그인 404, 파일함은 "연결 안 됨").
- 실제 구글로는 아직 미검증: 특히 브라우저→구글 직접 업로드 CORS, 익명 공유/해제.

- 2026-11-19 배포: GitHub https://github.com/Kacarong/hanger (공개 저장소, main; 업데이트마다 푸시 — 사용자 요청). 서버 /home/claude/kacarong-folio (GitHub clone) + user systemd `kacarong-folio.service`, env `~/.config/kacarong-folio/env`, 데이터 `~/.local/share/kacarong-folio`. 터널 ingress kacarong.kr → 127.0.0.1:2992, DNS CNAME 덮어씀. 업데이트: `cd ~/kacarong-folio && git pull && systemctl --user restart kacarong-folio`. 서비스 파일(deploy/kacarong-folio.service)이 바뀌면 `cp deploy/kacarong-folio.service ~/.config/systemd/user/ && systemctl --user daemon-reload` 도. 서비스는 Landlock(setpriv)으로 갇혀 있어 코드·데이터 폴더 밖을 못 읽는다(2026-11-19).
- 2026-11-19 디자인: 공개 페이지 = introck.studio 참고(검은 배경, 큰 타이포, 스크롤 등장·이미지 패럴랙스; public/site.css·site.js). 작업공간 = 어두운 사이드바 대시보드(요약 카드 + 표 + 대화상자; public/admin.css). 노트는 메뉴에 "준비 중".
- 2026-11-19 캘린더: 월 달력(6주)에 구글 캘린더 일정 + 날짜 있는 할 일·과제. scope `calendar.readonly`(읽기만, 일정은 서버에 저장 안 함), 구글에서 체크된 캘린더만. `/api/calendar?from&to`(최대 62일), 구글 실패해도 할 일은 나옴. 받은 scope는 settings `granted_scopes`에 저장, 캘린더 scope가 없으면 /auth/login이 prompt=consent로 다시 동의를 받는다. 빈 칸을 누르면 그 날짜로 새 할 일.

- 2026-11-19 보안: 모든 응답에 CSP(스크립트는 자기 파일만, 인라인 스크립트·핸들러 금지, connect-src는 자기+구글 API), X-Frame-Options DENY, nosniff, HSTS, Referrer-Policy. /admin·/api·/auth는 Cache-Control no-store. API의 POST/PATCH/DELETE는 Origin이 이 사이트일 때만.

## 남은 일
1. 사용자: OAuth 클라이언트(웹 애플리케이션, 리디렉션 URI https://kacarong.kr/auth/callback, 프로덕션 게시, Drive·Calendar API 사용 설정) + 관리자 이메일.
2. (완료) DNS·배포.
4. 실제 계정으로 업로드 CORS·공유 해제 확인 → 디자인 → PWA/TWA → Flutter PC.
