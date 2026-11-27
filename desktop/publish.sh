#!/bin/sh
# 자동 업데이트로 내보낸다:  desktop/publish.sh <kacarong-Setup-X.Y.Z.exe> [내보낼 폴더]
# 설치 파일에 서명(.sig)하고, 설치 파일과 latest.json 을 사이트 데이터 폴더의 desktop/ 에 둔다(https://kacarong.kr/desktop/).
# 켜 둔 PC 프로그램은 12시간 안에(켤 때는 바로) 새 버전을 보고 설치할지 묻는다.
# 서명 키: $KACARONG_UPDATER_KEY (기본 ~/.config/ejclaw/kacarong-updater.key, 비밀번호 없음). 키를 잃으면 자동 업데이트를 못 하니 바꾸지 말 것.
set -eu
setup=$(cd "$(dirname "${1:?설치 파일}")" && pwd)/$(basename "$1")
dest=${2:-$HOME/.local/share/kacarong-folio/desktop}
base=${KACARONG_BASE:-https://kacarong.kr}
key=${KACARONG_UPDATER_KEY:-$HOME/.config/ejclaw/kacarong-updater.key}
name=$(basename "$setup")
version=$(echo "$name" | sed -n 's/^kacarong-Setup-\([0-9]*\.[0-9]*\.[0-9]*\)\.exe$/\1/p')
[ -n "$version" ] || { echo "파일 이름이 kacarong-Setup-X.Y.Z.exe 가 아닙니다: $name" >&2; exit 1; }
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" cargo tauri signer sign -f "$key" "$setup" >/dev/null
mkdir -p "$dest"
cp "$setup" "$dest/$name.part" && mv "$dest/$name.part" "$dest/$name"
# latest.json 은 설치 파일이 다 놓인 뒤에 바꾼다(받는 쪽이 없는 파일을 가리키지 않게).
cat > "$dest/latest.json.part" <<JSON
{
  "version": "$version",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "windows-x86_64": {
      "signature": "$(cat "$setup.sig")",
      "url": "$base/desktop/$name"
    }
  }
}
JSON
mv "$dest/latest.json.part" "$dest/latest.json"
echo "$dest/latest.json -> $version"
