//! Anonymous, bounded public-share reads. No remote IPC capability is granted.
use once_cell::sync::Lazy;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
static ACTIVE: Lazy<Mutex<HashMap<String, (String, Arc<AtomicBool>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CANCELLED: Lazy<Mutex<HashMap<(String, String), Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
fn address(raw: &str) -> Result<(reqwest::Url, &'static str), String> {
    let mut url = reqwest::Url::parse(raw.trim()).map_err(|_| "分享地址无效")?;
    if raw.len() > 2048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
    {
        return Err("只支持三家官方HTTPS分享链接".into());
    }
    let (provider, prefix) = match url.host_str() {
        Some("chat.deepseek.com") => ("deepseek", "/share/"),
        Some("chatgpt.com" | "chat.openai.com") => ("gpt", "/share/"),
        Some("www.doubao.com" | "doubao.com") => ("doubao", "/thread/"),
        _ => return Err("当前支持DeepSeek、ChatGPT和豆包；其他来源请导入Markdown".into()),
    };
    let id = url
        .path()
        .strip_prefix(prefix)
        .ok_or("请使用对话分享地址，不能导入网站首页")?
        .trim_end_matches('/');
    if !(8..=128).contains(&id.len())
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("分享标识无效".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok((url, provider))
}
fn same_share(left: &str, right: &str) -> bool {
    match (address(left), address(right)) {
        (Ok((a, ap)), Ok((b, bp))) => {
            ap == bp && a.path().trim_end_matches('/') == b.path().trim_end_matches('/')
        }
        _ => false,
    }
}
struct ActiveGuard(String);
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            active.remove(&self.0);
        }
    }
}
fn register(
    window: &WebviewWindow,
    request: &str,
) -> Result<(ActiveGuard, Arc<AtomicBool>), String> {
    crate::storage::safe_id(request)?;
    let cancelled = CANCELLED.lock().map_err(|_| "分享取消状态不可用")?;
    if cancelled
        .get(&(window.label().into(), request.into()))
        .is_some_and(|at| at.elapsed() < Duration::from_secs(60))
    {
        return Err("已取消分享读取".into());
    }
    let mut active = ACTIVE.lock().map_err(|_| "分享读取状态不可用")?;
    if active.len() >= 3
        || active.contains_key(request)
        || active.values().any(|(owner, _)| owner == window.label())
    {
        return Err("请先完成或取消上一次分享读取".into());
    }
    let flag = Arc::new(AtomicBool::new(false));
    active.insert(request.into(), (window.label().into(), flag.clone()));
    drop(active);
    drop(cancelled);
    Ok((ActiveGuard(request.into()), flag))
}
async fn cancelled(flag: &AtomicBool, owner: &WebviewWindow) {
    while !flag.load(Ordering::Relaxed) && owner.is_visible().is_ok() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
#[tauri::command]
pub async fn conversation_share_html(
    window: WebviewWindow,
    url: String,
    request_id: String,
) -> Result<String, String> {
    let (url, provider) = address(&url)?;
    if provider != "gpt" {
        return Err("此来源需要读取公开网页呈现内容".into());
    }
    let (_active, flag) = register(&window, &request_id)?;
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(25),crate::model_catalog::public_get_limited(url.as_str(),64*1024*1024)) => result.map_err(|_|"网页数据读取超时，将尝试公开页面".to_string())?,
        _ = cancelled(&flag, &window) => Err("已取消分享读取".into()),
    }
}
#[tauri::command]
pub async fn conversation_share_cancel(window: WebviewWindow, request_id: String) -> bool {
    if crate::storage::safe_id(&request_id).is_err() {
        return false;
    }
    if let Ok(mut cancelled) = CANCELLED.lock() {
        cancelled.retain(|_, at| at.elapsed() < Duration::from_secs(60));
        if cancelled.len() >= 256 {
            if let Some(old) = cancelled
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(key, _)| key.clone())
            {
                cancelled.remove(&old);
            }
        }
        cancelled.insert((window.label().into(), request_id.clone()), Instant::now());
    }
    if let Ok(active) = ACTIVE.lock() {
        if let Some((owner, flag)) = active.get(&request_id) {
            if owner == window.label() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
    // Resolve only after the cancelled operation has released this owner's slot.
    for _ in 0..40 {
        let remains = ACTIVE
            .lock()
            .map(|active| {
                active
                    .get(&request_id)
                    .is_some_and(|(owner, _)| owner == window.label())
            })
            .unwrap_or(false);
        if !remains {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}
#[derive(Default)]
struct ShareReadGate {
    previous: String,
    since: Duration,
    samples: usize,
}
impl ShareReadGate {
    fn observe(&mut self, snapshot: Option<&Value>, requested: &str, elapsed: Duration) -> bool {
        let Some(snapshot) = snapshot.filter(|s| {
            s["url"]
                .as_str()
                .is_some_and(|url| same_share(requested, url))
                && s["ready"] == true
                && s["complete"] == true
                && s["scrolledTop"] == true
        }) else {
            self.samples = 0;
            self.previous.clear();
            return false;
        };
        let Some(messages) = snapshot["messages"].as_array().filter(|m| {
            !m.is_empty()
                && m.iter().filter_map(|v|v["content"].as_str()).map(str::len).sum::<usize>() <= 32*1024*1024
                && m.iter().any(|v| v["role"] == "assistant")
                && m.iter().all(|v| {
                    ["user", "assistant"].contains(&v["role"].as_str().unwrap_or(""))
                        && v["content"].as_str().is_some_and(|s| !s.trim().is_empty())
                })
        }) else {
            self.samples = 0;
            self.previous.clear();
            return false;
        };
        let current = serde_json::to_string(messages).unwrap_or_default();
        if self.previous == current {
            self.samples += 1;
        } else {
            self.previous = current;
            self.since = elapsed;
            self.samples = 1;
        }
        self.samples >= 3 && elapsed.saturating_sub(self.since) >= Duration::from_millis(1800)
    }
}
struct ReadGuard {
    reader: WebviewWindow,
}
impl Drop for ReadGuard {
    fn drop(&mut self) {
        let _ = self.reader.destroy();
    }
}
#[tauri::command]
pub async fn conversation_share_read(
    app: tauri::AppHandle,
    window: WebviewWindow,
    url: String,
    request_id: String,
) -> Result<Value, String> {
    let (url, _) = address(&url)?;
    let (_active, flag) = register(&window, &request_id)?;
    let started = Instant::now();
    let _ = window.emit(
        "lumen://share-read-progress",
        serde_json::json!({"requestId":request_id,"stage":"正在打开匿名分享页面"}),
    );
    let requested_url = url.to_string();
    let navigation_url = requested_url.clone();
    let label = format!("share-{}", crate::storage::new_id("read"));
    let handle = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    if let Err(e) = app.run_on_main_thread(move || {
        let result = WebviewWindowBuilder::new(&handle, label, WebviewUrl::External(url))
            .visible(false)
            .focused(false)
            .incognito(true)
            .inner_size(1200., 900.)
            .on_navigation(move |target| same_share(&navigation_url, target.as_str()))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .build()
            .map(|reader| ReadGuard { reader })
            .map_err(|e| e.to_string());
        // The channel owns the guard too: cancellation after a successful send
        // must destroy a queued reader even when it is never received.
        let _ = send.send(result);
    }) {
        return Err(e.to_string());
    }
    let received = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(8),receive) => result.map_err(|_|"分享页面创建超时，请稍后重试".to_string())?,
        _ = cancelled(&flag, &window) => return Err("已取消分享读取".into()),
    };
    let guard = match received {
        Ok(Ok(guard)) => guard,
        Ok(Err(e)) => return Err(format!("无法创建分享读取页：{e}")),
        Err(e) => return Err(format!("无法创建分享读取页：{e}")),
    };
    let mut gate = ShareReadGate::default();
    let mut last_progress=Instant::now();
    let mut previous_progress=String::new();
    while started.elapsed() < Duration::from_secs(30*60) {
        if flag.load(Ordering::Relaxed) || window.is_visible().is_err() {
            return Err("已取消分享读取".into());
        }
        let (send, receive) = tokio::sync::oneshot::channel();
        let sender = Mutex::new(Some(send));
        guard
            .reader
            .eval_with_callback(format!("window.__LUMEN_SHARE_SCAN=true;{}",include_str!("share_extract.js")), move |result| {
                if let Ok(mut slot) = sender.lock() {
                    if let Some(send) = slot.take() {
                        let _ = send.send(result);
                    }
                }
            })
            .map_err(|_| "读取网页失败")?;
        let response = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(5), receive) => result,
            _ = cancelled(&flag, &window) => return Err("已取消分享读取".into()),
        };
        let mut observed = false;
        if let Ok(Ok(raw)) = response {
            if raw.len() > 128 * 1024 * 1024 {
                return Err("分享内容超过读取上限，请改用Markdown".into());
            }
            if let Ok(snapshot) = serde_json::from_str::<Value>(&raw) {
                observed = true;
                if let Some(error)=snapshot["error"].as_str(){return Err(error.into());}
                let count = snapshot["total"].as_u64().unwrap_or_else(||snapshot["messages"].as_array().map_or(0, Vec::len) as u64);
                let progress=format!("{}:{}:{}:{}",snapshot["phase"],count,snapshot["position"],snapshot["bytes"]);
                if progress!=previous_progress{previous_progress=progress;last_progress=Instant::now();}
                let stage = if count > 0 {
                    format!("已累计 {count} 条消息 · {}",if snapshot["complete"]==true{"正在核对首尾与完整性"}else{"滚动加载其余对话"})
                } else {
                    "正在定位对话开头，等待公开正文加载".into()
                };
                let _ = window.emit(
                    "lumen://share-read-progress",
                    serde_json::json!({"requestId":request_id,"stage":stage}),
                );
                if gate.observe(Some(&snapshot), &requested_url, started.elapsed()) {
                    return Ok(snapshot);
                }
            }
        }
        if !observed {
            gate.observe(None, &requested_url, started.elapsed());
        }
        if last_progress.elapsed()>Duration::from_secs(90){return Err("分享页超过90秒没有新增内容或滚动进展；没有将未读完内容当作全文，请重试或导入Markdown。".into());}
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(750)) => (),
            _ = cancelled(&flag, &window) => return Err("已取消分享读取".into()),
        }
    }
    Err("未能读取完整公开问答。链接可能失效、需要登录/验证，或页面结构已变化；请在浏览器确认后改用Markdown导入。".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore="Manual anonymous public-share GET, URL supplied locally; never inference or CI content upload"]
    async fn live_large_share_uses_separate_transport_budget(){
        let url=std::env::var("LSQ_LIVE_SHARE_URL").expect("set an explicitly provided public share URL");let (url,provider)=address(&url).unwrap();assert_eq!(provider,"gpt");
        let html=crate::model_catalog::public_get_limited(url.as_str(),64*1024*1024).await.unwrap();assert!(html.len()>2_000_000);assert!(html.contains("linear_conversation"));eprintln!("anonymous share HTML bytes: {}",html.len());
    }
    #[test]
    fn body_readiness_must_be_continuous_and_settle_after_busy_or_invalid_samples() {
        let url = "https://chat.deepseek.com/share/synthetic123";
        let ready = serde_json::json!({"url":url,"ready":true,"complete":true,"scrolledTop":true,"messages":[{"role":"user","content":"Q"},{"role":"assistant","content":"A"}]});
        let mut gate = ShareReadGate::default();
        assert!(!gate.observe(Some(&ready), url, Duration::ZERO));
        assert!(!gate.observe(Some(&ready), url, Duration::from_millis(750)));
        assert!(!gate.observe(None, url, Duration::from_millis(1500)));
        assert!(!gate.observe(Some(&ready), url, Duration::from_millis(2250)));
        assert!(!gate.observe(Some(&ready), url, Duration::from_millis(3000)));
        assert!(gate.observe(Some(&ready), url, Duration::from_millis(4500)));
        let mut busy = ready.clone();
        busy["ready"] = serde_json::json!(false);
        assert!(!gate.observe(Some(&busy), url, Duration::from_millis(5000)));
        assert!(!gate.observe(Some(&ready), url, Duration::from_millis(6000)));
    }
    #[test]
    fn later_messages_restart_stability_and_foreign_or_empty_payloads_never_complete() {
        let url = "https://chat.deepseek.com/share/synthetic123";
        let ready = serde_json::json!({"url":url,"ready":true,"complete":true,"scrolledTop":true,"messages":[{"role":"assistant","content":"A"}]});
        let mut gate = ShareReadGate::default();
        assert!(!gate.observe(Some(&ready), url, Duration::ZERO));
        let mut later = ready.clone();
        later["messages"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"role":"assistant","content":"B"}));
        assert!(!gate.observe(Some(&later), url, Duration::from_secs(2)));
        assert!(!gate.observe(Some(&later), url, Duration::from_secs(3)));
        assert!(gate.observe(Some(&later), url, Duration::from_secs(4)));
        assert!(!gate.observe(
            Some(&later),
            "https://chat.deepseek.com/share/other1234",
            Duration::from_secs(5)
        ));
        later["messages"][0]["content"] = serde_json::json!("");
        assert!(!gate.observe(Some(&later), url, Duration::from_secs(10)));
    }
    #[test]
    fn only_known_public_share_routes_are_accepted() {
        for url in [
            "https://chat.deepseek.com/share/synthetic123",
            "https://chatgpt.com/share/synthetic-123",
            "https://www.doubao.com/thread/synthetic_123",
        ] {
            assert!(address(url).is_ok());
        }
        assert!(same_share(
            "https://chat.openai.com/share/synthetic123",
            "https://chatgpt.com/share/synthetic123/?track=1"
        ));
        assert!(!same_share(
            "https://chatgpt.com/share/synthetic123",
            "https://chatgpt.com/share/different123"
        ));
        for url in [
            "http://chatgpt.com/share/synthetic123",
            "https://user:pass@chatgpt.com/share/synthetic123",
            "https://127.0.0.1/share/synthetic123",
            "https://chatgpt.com.evil.example/share/synthetic123",
            "https://chatgpt.com/",
            "file:///private/key",
            "https://www.doubao.com/thread/a/b",
            "https://chat.qwen.ai/s/synthetic123",
        ] {
            assert!(address(url).is_err());
        }
    }
}
