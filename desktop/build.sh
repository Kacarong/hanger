#!/bin/sh
# 리눅스에서 윈도우용 설치 파일을 만든다:  desktop/build.sh <출력 폴더>  ->  kacarong-Setup-<버전>.exe (+ .sha256)
# 필요한 것: Rust x86_64-pc-windows-gnu 타깃, mingw-w64, makensis 3 (시스템에 없으면 NSISDIR 지정), curl.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "${1:?출력 폴더}" && cd "$1" && pwd)
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/Cargo.toml" | head -1)
target=${CARGO_TARGET_DIR:-$here/target}
cargo build --release --locked --target x86_64-pc-windows-gnu --manifest-path "$here/Cargo.toml"
rel="$target/x86_64-pc-windows-gnu/release"
# WebView2 런타임 부트스트래퍼(마이크로소프트, 약 2MB): 런타임이 없는 PC 에서만 실행된다.
wv2="$target/MicrosoftEdgeWebview2Setup.exe"
[ -s "$wv2" ] || curl -fsSL -o "$wv2" "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
setup="$out/kacarong-Setup-$version.exe"
makensis -V2 ${NSIS_EXTRA:-} -DVERSION="$version" -DSRC="$rel" -DOUT="$setup" -DICON="$here/icons/icon.ico" -DWEBVIEW2="$wv2" "$here/installer.nsi"
(cd "$out" && sha256sum "kacarong-Setup-$version.exe" > "kacarong-Setup-$version.exe.sha256")
echo "$setup"
