//! kacarong 작업공간 PC 프로그램: https://kacarong.kr/admin 을 창 하나로 띄운다 (안드로이드 앱과 같은
//! 껍데기). 화면·기능은 전부 사이트에 있어서 사이트를 고치면 이 프로그램은 다시 만들 필요가 없다.
//! - 이 사이트와 구글 로그인은 창 안에서, 그 밖의 주소(노션·캘린더 링크 등)는 기본 브라우저로 연다.
//! - 이 사이트의 새 창 링크(파일 열기, 공개 페이지)는 같은 로그인으로 새 창에 연다.
//! - 파일을 창에 끌어다 놓으면 사이트가 받는다(Tauri 의 끌어놓기 가로채기를 끈다).
//! - 다시 실행하면 새로 뜨지 않고 열려 있는 창을 앞으로 가져온다.
//! - 사이트가 window.__TAURI__.notification 으로 윈도우 알림을 띄운다(WebView2 는 웹 알림을 막는다).
//!   이 사이트 주소만 그 기능을 쓸 수 있다(capabilities/site.json).
//! - 받기(다운로드)를 누르면 저장 위치를 고르는 창을 띄운다. WebView2 는 아무 표시 없이 다운로드 폴더에
//!   저장해서 받기가 안 되는 것처럼 보였다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// 여는 주소. 시험 빌드만 `KACARONG_HOME=http://.../admin cargo build` 로 다른 서버를 가리킨다.
const HOME: &str = match option_env!("KACARONG_HOME") {
    Some(h) => h,
    None => "https://kacarong.kr/admin",
};

fn home() -> Url {
    HOME.parse().unwrap()
}

/// 이 사이트(HOME 과 같은 출처)의 주소인지.
fn same_site(url: &Url) -> bool {
    url.origin() == home().origin()
}

/// 구글 로그인이 거치는 주소인지: google.com·나라별 google.co.kr 등과 그 하위 주소, accounts.youtube.com.
/// 로그인 마지막에 구글이 accounts.youtube.com, accounts.google.co.kr 을 차례로 거치며 로그인을 심는다.
/// 이걸 창 밖으로 보내면 로그인이 끝나지 않고 기본 브라우저에 구글 400 화면이 뜬다.
fn google_sign_in_host(h: &str) -> bool {
    if h == "accounts.youtube.com" {
        return true;
    }
    let labels: Vec<&str> = h.split('.').collect();
    let Some(i) = labels.iter().rposition(|l| *l == "google") else {
        return false;
    };
    match &labels[i + 1..] {
        ["com"] => true,
        [cc] => cc.len() == 2,
        ["co" | "com", cc] => cc.len() == 2,
        _ => false,
    }
}

/// 창 안에 머무는 주소: 이 사이트와 구글 로그인.
fn stays_inside(url: &Url) -> bool {
    if same_site(url) {
        return true;
    }
    match (url.scheme(), url.host_str()) {
        ("https", Some(h)) => google_sign_in_host(h),
        ("about" | "blob" | "data", _) => true,
        _ => false,
    }
}

/// http/https 만 기본 브라우저로 넘긴다(그 밖의 스킴은 무시).
fn open_in_browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url.as_str()]).spawn();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(home()))
                .title("kacarong 작업공간")
                .inner_size(1280.0, 860.0)
                .min_inner_size(360.0, 480.0)
                .disable_drag_drop_handler()
                .on_navigation(|url| {
                    if stays_inside(url) {
                        return true;
                    }
                    open_in_browser(url);
                    false
                })
                .on_download(|webview, event| {
                    let DownloadEvent::Requested { destination, .. } = event else {
                        return true;
                    };
                    let mut dialog = rfd::FileDialog::new().set_parent(&webview.window());
                    if let Some(dir) = destination.parent() {
                        dialog = dialog.set_directory(dir);
                    }
                    if let Some(name) = destination.file_name() {
                        dialog = dialog.set_file_name(name.to_string_lossy());
                    }
                    match dialog.save_file() {
                        Some(path) => {
                            *destination = path;
                            true
                        }
                        None => false,
                    }
                })
                .on_new_window(|url, _| {
                    if same_site(&url) {
                        return NewWindowResponse::Allow;
                    }
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("창을 띄우지 못했습니다");
}

#[cfg(test)]
mod tests {
    use super::google_sign_in_host as g;

    #[test]
    fn google_sign_in_hosts() {
        for h in ["google.com", "accounts.google.com", "accounts.google.co.kr", "www.google.co.kr", "accounts.google.de", "accounts.google.com.au", "accounts.youtube.com"] {
            assert!(g(h), "{h}");
        }
        for h in ["notion.so", "youtube.com", "www.youtube.com", "google.evil.com", "accounts.google.com.evil.kr", "evilgoogle.com", "google.co.evil"] {
            assert!(!g(h), "{h}");
        }
    }
}
