# kacarong 작업공간 PC 프로그램 (Windows)

https://kacarong.kr/admin 을 창 하나로 띄우는 껍데기 프로그램이다 (안드로이드 앱과 같은 방식,
Tauri 2 + Windows 내장 WebView2). 화면·기능은 전부 사이트에 있으므로 **사이트를 고치면 프로그램을
다시 만들 필요가 없다.** 다시 빌드하는 건 이름·아이콘·창 동작을 바꿀 때뿐이다.

- 이 사이트와 구글 로그인은 창 안에서, 그 밖의 주소(노션·구글 캘린더 링크 등)는 기본 브라우저로 연다.
- 이 사이트의 새 창 링크(파일 열기, 공개 페이지, 포트폴리오 미리 보기)는 같은 로그인으로 새 창에 연다.
- 파일을 창에 끌어다 놓으면 사이트가 받는다.
- 다시 실행하면 열려 있는 창을 앞으로 가져온다.
- 로그인·캐시는 `%LOCALAPPDATA%\kr.kacarong.workspace` 에 남는다(제거하면 같이 지운다).

## 빌드 (리눅스에서)

```bash
cd desktop
NSISDIR=$HOME/.local/nsis/usr/share/nsis PATH=$HOME/.local/nsis/usr/bin:$PATH ./build.sh <출력 폴더>
# → <출력 폴더>/kacarong-Setup-<버전>.exe (+ .sha256)
```

필요한 것: Rust `x86_64-pc-windows-gnu` 타깃, mingw-w64, makensis 3, curl.

시험용으로 다른 서버를 띄우려면 `KACARONG_HOME=http://127.0.0.1:2993/admin cargo build ...` (컴파일 때만 읽는다,
그 서버와 같은 출처가 "이 사이트"가 된다). `NSIS_EXTRA='-DWEBVIEW2_HKLM=... -DWEBVIEW2_HKCU=...'` 로 런타임
확인 키를 바꾸면 런타임이 없는 PC의 설치 흐름을 시험할 수 있다.

## 설치 파일

- 관리자 권한 없이 이 사용자 계정에만 설치한다: `%LOCALAPPDATA%\Programs\kacarong`, 시작 메뉴·바탕 화면 바로 가기.
- 새 버전은 같은 설치 파일을 다시 실행하면 덮어쓴다(`Cargo.toml` 의 `version` 을 올린다). `/S` 는 조용한 설치.
- WebView2 런타임(HKLM WOW6432Node 또는 HKCU 의 EdgeUpdate 키)이 없는 PC(오래된 Windows 10)에서는 설치 중에
  마이크로소프트 부트스트래퍼로 런타임을 받는다. 그래도 없으면 아무것도 설치하지 않고 멈춘다(다시 시도 / 취소, `/S` 면 종료 코드 3).
- 제거: Windows 설정 → 앱 → "kacarong 작업공간".
