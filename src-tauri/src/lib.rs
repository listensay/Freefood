use std::{io::{BufRead, BufReader}, path::PathBuf, process::{Child, Command, Stdio}, sync::{Arc, Mutex}, time::Duration};
use serde::{Deserialize, Serialize};
use tauri::{Manager, RunEvent};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tokio::sync::OnceCell;

struct Bridge {
    child: Mutex<Option<Child>>,
    ready: OnceCell<Result<String, String>>,
    token: String,
    client: reqwest::Client,
}
impl Bridge {
    fn new() -> Self {
        let bytes: [u8; 32] = rand::random();
        Self { child: Mutex::new(None), ready: OnceCell::new(),
            token: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
            client: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).no_proxy().build().unwrap() }
    }
    fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            #[cfg(unix)] unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
            for _ in 0..60 {
                if child.try_wait().ok().flatten().is_some() { return; }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill(); let _ = child.wait();
        }
    }
}
#[derive(Deserialize)]
struct Ready { r#type: String, port: u16 }
#[derive(Serialize)]
struct ApiResponse { status: u16, body: String }

fn service_paths(_app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    #[cfg(debug_assertions)] {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        return Ok((root.join(format!("binaries/food-node-{}", env!("FOOD_TARGET"))), root.join("../dist/service/index.mjs")));
    }
    #[cfg(not(debug_assertions))] {
        let node = std::env::current_exe().map_err(|_| "应用路径无效")?.parent().ok_or("应用路径无效")?.join("food-node");
        let service = _app.path().resource_dir().map_err(|_| "应用资源无法读取")?.join("service/index.mjs");
        Ok((node, service))
    }
}
fn start_service(app: tauri::AppHandle, bridge: Arc<Bridge>) -> Result<String, String> {
    let (node, service) = service_paths(&app)?;
    let directory = std::env::var_os("FOOD_DATA_DIR").map(PathBuf::from)
        .unwrap_or(app.path().app_data_dir().map_err(|_| "数据目录无法读取")?);
    std::fs::create_dir_all(&directory).map_err(|_| "数据目录无法创建")?;
    let mut child = Command::new(node).arg(service)
        .env("FOOD_DATA_DIR", directory).env("FOOD_DESKTOP", "1").env("FOOD_ALLOW_LAN", "0")
        .env("FOOD_SERVICE_TOKEN", &bridge.token).env("PORT", "0").env("HOST", "127.0.0.1")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|_| "本地服务无法启动")?;
    let stdout = child.stdout.take().ok_or("本地服务无法启动")?;
    let stderr = child.stderr.take().ok_or("本地服务无法启动")?;
    *bridge.child.lock().unwrap() = Some(child);
    std::thread::spawn(move || { let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink()); });
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        if reader.read_line(&mut line).is_ok() && line.len() < 4096 {
            let _ = sender.send(serde_json::from_str::<Ready>(&line).ok());
        }
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    match receiver.recv_timeout(Duration::from_secs(90)) {
        Ok(Some(ready)) if ready.r#type == "ready" && ready.port > 0 => Ok(format!("http://127.0.0.1:{}", ready.port)),
        _ => { bridge.stop(); Err("本地服务启动失败，请检查系统钥匙串和数据目录".into()) }
    }
}
fn valid_request(path: &str, method: &str, body: &Option<String>) -> bool {
    path.starts_with("/api/") && path.len() <= 200 && !path.ends_with('/') && !path.contains("//")
        && path.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'/' || b == b'-')
        && matches!(method, "GET" | "POST" | "DELETE") && body.as_ref().map_or(true, |body| body.len() <= 16 * 1024 * 1024)
}
async fn forward(app: tauri::AppHandle, bridge: Arc<Bridge>, path: String, method: String, body: Option<String>, timeout_ms: u64) -> Result<ApiResponse, String> {
    if !valid_request(&path, &method, &body) { return Err("请求参数无效".into()); }
    let endpoint = bridge.ready.get_or_init(|| {
        let bridge = bridge.clone();
        async move { tauri::async_runtime::spawn_blocking(move || start_service(app, bridge)).await.map_err(|_| "本地服务启动失败".to_string())? }
    }).await.as_ref().map_err(Clone::clone)?;
    let mut request = bridge.client.request(method.parse().map_err(|_| "请求方式无效")?, format!("{endpoint}{path}"))
        .header("x-food-desktop-token", &bridge.token).header("x-food-request", "1")
        .header("origin", endpoint).header("content-type", "application/json")
        .timeout(Duration::from_millis(timeout_ms.clamp(1000, 600_000)));
    if let Some(body) = body { request = request.body(body); }
    let response = request.send().await.map_err(|_| "本地服务连接失败")?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| "本地服务响应无效")?;
    if body.len() > 32 * 1024 * 1024 { return Err("服务响应过大".into()); }
    Ok(ApiResponse { status, body })
}
#[tauri::command]
async fn api_request(app: tauri::AppHandle, bridge: tauri::State<'_, Arc<Bridge>>, path: String, method: String, body: Option<String>, timeout_ms: u64) -> Result<ApiResponse, String> {
    forward(app, bridge.inner().clone(), path, method, body, timeout_ms).await
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "打开主窗口", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出叠个饭", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(tauri::include_image!("icons/tray-icon.png"))
        .icon_as_template(true)
        .tooltip("叠个饭")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            // Use the normal exit event so the local service and schedulers shut down together.
            "tray-quit" => app.exit(0),
            _ => (),
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    let bridge = Arc::new(Bridge::new());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(bridge.clone()).invoke_handler(tauri::generate_handler![api_request])
        .setup(|app| { setup_tray(app)?; Ok(()) })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); }
        })
        .build(tauri::generate_context!()).expect("桌面应用启动失败");
    app.run(move |app, event| match event {
        RunEvent::Exit => bridge.stop(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main_window(app),
        _ => (),
    });
}

#[cfg(test)]
mod tests {
    use super::valid_request;
    #[test]
    fn tray_icon_has_visible_monochrome_pixels_and_a_transparent_background() {
        let icon = tauri::include_image!("icons/tray-icon.png");
        assert_eq!((icon.width(), icon.height()), (36, 36));
        assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] == 0));
        assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] == 255));
        assert!(icon.rgba().chunks_exact(4).all(|pixel| pixel[..3] == [0, 0, 0]));
    }
    #[test]
    fn bridge_only_allows_bounded_local_api_requests() {
        assert!(valid_request("/api/xiaochan/enroll", "POST", &Some("{}".into())));
        for path in ["https://example.com/api/data", "/api/../secret", "/api/x?url=http://example.com", "/api/%2e%2e/secret", "/api/\\secret", "/api//desktop/import", "/api/desktop/import/"] {
            assert!(!valid_request(path, "GET", &None));
        }
        assert!(!valid_request("/api/dashboard", "PUT", &None));
        assert!(!valid_request("/api/import", "POST", &Some("a".repeat(16 * 1024 * 1024 + 1))));
    }
}
