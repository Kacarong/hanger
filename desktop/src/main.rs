//! kacarong 작업공간 PC 프로그램: https://kacarong.kr/admin 을 창 하나로 띄운다 (안드로이드 앱과 같은
//! 껍데기). 화면·기능은 전부 사이트에 있어서 사이트를 고치면 이 프로그램은 다시 만들 필요가 없다.
//! - 이 사이트와 구글 로그인은 창 안에서, 그 밖의 주소(노션·캘린더 링크 등)는 기본 브라우저로 연다.
//! - 이 사이트의 새 창 링크(파일 열기, 공개 페이지)는 같은 로그인으로 새 창에 연다.
//! - 파일을 창에 끌어다 놓으면 사이트가 받는다(Tauri 의 끌어놓기 가로채기를 끈다).
//! - 다시 실행하면 새로 뜨지 않고 열려 있는 창을 앞으로 가져온다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

const HOME: &str = "https://kacarong.kr/admin";

/// 창 안에 머무는 주소: 이 사이트와 구글 로그인(accounts.google.com 등 *.google.com).
fn stays_inside(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("https", Some(h)) => h == "kacarong.kr" || h == "google.com" || h.ends_with(".google.com"),
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
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(HOME.parse().unwrap()))
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
                .on_new_window(|url, _| {
                    if url.host_str() == Some("kacarong.kr") {
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
