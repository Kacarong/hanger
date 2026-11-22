; kacarong 작업공간 설치 파일. build.sh 가 리눅스에서 makensis 로 만든다:
;   makensis -DVERSION=1.0.0 -DSRC=<kacarong.exe·WebView2Loader.dll 폴더> -DOUT=<setup.exe> -DICON=<icon.ico> -DWEBVIEW2=<부트스트래퍼> installer.nsi
; 이 사용자 계정에만 설치한다(관리자 권한 없음): %LOCALAPPDATA%\Programs\kacarong. 같은 파일을 다시 실행하면 덮어써서 업데이트.

Unicode true
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define APP "kacarong 작업공간"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\kacarong-workspace"
!define WEBVIEW2_KEY "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${APP}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\kacarong"
RequestExecutionLevel user
BrandingText "${APP} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=0 "ProductName" "${APP}"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "FileDescription" "${APP} 설치"
VIAddVersionKey /LANG=0 "LegalCopyright" "kacarong"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\kacarong.exe"
!define MUI_FINISHPAGE_RUN_TEXT "${APP} 열기"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "64비트 Windows 10/11에서만 실행됩니다."
    Abort
  ${EndIf}
FunctionEnd

; 실행 중이면 exe 를 지울 수 없다: 닫아 달라고 한다.
!macro WaitClosed
  ${Do}
    ClearErrors
    Delete "$INSTDIR\kacarong.exe"
    ${IfNot} ${Errors}
      ${Break}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${APP} 창이 열려 있습니다. 창을 닫은 뒤 다시 시도를 눌러 주세요." IDRETRY +2
    Abort
  ${Loop}
!macroend

; 창에 필요한 WebView2 런타임(Windows 11 에는 있다, 오래된 Windows 10 에는 없을 수 있다).
Function EnsureWebView2
  ReadRegStr $0 HKLM "${WEBVIEW2_KEY}" "pv"
  ReadRegStr $1 HKCU "${WEBVIEW2_KEY}" "pv"
  ${If} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    Return
  ${EndIf}
  ${If} $1 != ""
  ${AndIf} $1 != "0.0.0.0"
    Return
  ${EndIf}
  SetOutPath "$PLUGINSDIR"
  File "/oname=webview2.exe" "${WEBVIEW2}"
  DetailPrint "WebView2 런타임 설치"
  ExecWait '"$PLUGINSDIR\webview2.exe" /silent /install'
FunctionEnd

Section
  !insertmacro WaitClosed
  Call EnsureWebView2
  SetOutPath "$INSTDIR"
  File "${SRC}/kacarong.exe"
  File "${SRC}/WebView2Loader.dll"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortCut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\kacarong.exe"
  CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\kacarong.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "kacarong"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\kacarong.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  !insertmacro WaitClosed
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  ; 창의 브라우저 데이터(로그인·캐시)
  RMDir /r "$LOCALAPPDATA\kr.kacarong.workspace"
SectionEnd
