# kacarong.kr 개인 작업공간

## 방향 (2026-11-19 사용자와 합의)
- 드라이브가 중심이 아니라 개인 작업공간: 오늘 할 일 · 과제/할 일 · 캘린더 · 노트 · 클라우드(파일함) · 포트폴리오. 혼자 사용.
- 오늘 화면이 로그인 첫 화면: 지난 일, 오늘 날짜의 할 일·과제, 3일 안 마감 과제, 오늘 끝낸 일.
- 과제: 직접 입력(과목·마감일·시간·메모). 헬로 LMS 연동은 되면 나중에.
- 캘린더: 사용자 구글 캘린더와 연동(구글 OAuth에 캘린더 scope 추가 필요). 과제·할 일 날짜도 캘린더에 표시.
- 노트: 노션 같은 블록 편집기. 노트 속 체크박스+날짜 = 할 일(오늘·캘린더에 표시). 편집기 라이브러리 선택은 노트 단계에서.
- 포트폴리오: 공개용과 개인용 구분. 세부는 차차.
- 로그인: 비밀번호 로그인 먼저(`bun run set-password`, 5번 틀리면 15분 잠금). 구글 정보가 오면 구글 로그인·드라이브·캘린더를 켠다.
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

## 남은 일
1. 사용자: OAuth 클라이언트(웹 애플리케이션, 리디렉션 URI https://kacarong.kr/auth/callback, 프로덕션 게시, Drive·Calendar API 사용 설정) + 관리자 이메일.
2. 사용자: kacarong.kr 기존 A 레코드(525) 교체 동의 → `cloudflared tunnel route dns --overwrite-dns unifi-site kacarong.kr`.
3. 배포: deploy/kacarong-folio.service, deploy/env.example.
4. 실제 계정으로 업로드 CORS·공유 해제 확인 → 디자인 → PWA/TWA → Flutter PC.
