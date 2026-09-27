use notify_rust::Notification;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn show_native_notification(title: String, body: String) -> Result<(), String> {
    Notification::new()
        .summary(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Build from config so size, user agent and platform settings stay shared.
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .initialization_script(include_str!("chat-connection.js"))
                .build()?;
            // A native timer also runs while the webview's JS timers are throttled.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(25));
                let Some(window) = handle.get_webview_window("main") else {
                    break;
                };
                let _ =
                    window.eval("window.dispatchEvent(new Event('socialtap:connection-check'))");
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, show_native_notification,])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
