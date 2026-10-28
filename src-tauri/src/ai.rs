//! AI 流式请求传输层（M5-2）。
//!
//! 守住 DESIGN 的「前端零网络能力」边界：前端只用纯函数构造 url/headers/body
//! （见 src/ai/provider.ts），真正的 HTTP 流式传输在此用 reqwest 完成，把原始
//! 响应字节块通过 Tauri 事件回传给前端，由前端 parseSseChunk 增量解析 SSE。
//!
//! 事件（payload 均含 request_id 以支持多路并发）：
//!   ai://chunk  { requestId, data }   —— 一段原始响应文本
//!   ai://done   { requestId }         —— 正常结束
//!   ai://error  { requestId, message }—— 出错（HTTP 状态非 2xx 或网络异常）
//!   ai://retry  { requestId, attempt, maxRetries, delayMs, reason } —— 等待重试
//!
//! 取消：前端调用 ai_cancel(request_id) 置位；流循环检测到即中断。

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Window};
use tokio::sync::Notify;

/// 已请求取消的 request_id 集合。
static CANCELLED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));
static SIGNALS: Lazy<Mutex<HashMap<String, Arc<Notify>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
struct RequestGuard(String);
impl Drop for RequestGuard {
    fn drop(&mut self) {
        clear_cancel(&self.0);
        if let Ok(mut signals) = SIGNALS.lock() {
            signals.remove(&self.0);
        }
    }
}

#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}
impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap());
                    self.pending.drain(..valid);
                    if let Some(length) = error.error_len() {
                        output.push('\u{fffd}');
                        self.pending.drain(..length);
                    } else {
                        break;
                    }
                }
            }
        }
        output
    }
    fn finish(&mut self) -> String {
        let tail = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        tail
    }
}

#[derive(Clone, Serialize)]
struct ChunkEvent {
    #[serde(rename = "requestId")]
    request_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct DoneEvent {
    #[serde(rename = "requestId")]
    request_id: String,
}

#[derive(Clone, Serialize)]
struct ErrorEvent {
    #[serde(rename = "requestId")]
    request_id: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetryEvent {
    request_id: String,
    attempt: u32,
    max_retries: u32,
    delay_ms: u64,
    reason: String,
}

const MAX_RETRIES: u32 = 3;
const MAX_RETRY_WAIT: Duration = Duration::from_secs(60);

fn is_cancelled(id: &str) -> bool {
    CANCELLED.lock().map(|s| s.contains(id)).unwrap_or(false)
}

fn clear_cancel(id: &str) {
    if let Ok(mut s) = CANCELLED.lock() {
        s.remove(id);
    }
}

/// 请求取消某个进行中的 AI 流。
#[tauri::command]
pub fn ai_cancel(request_id: String) {
    if let Ok(mut s) = CANCELLED.lock() {
        s.insert(request_id.clone());
    }
    if let Ok(signals) = SIGNALS.lock() {
        if let Some(signal) = signals.get(&request_id) {
            signal.notify_one();
        }
    }
}

/// 发起一次 OpenAI 兼容的流式 chat 请求。url/headers/body 由前端 provider.ts 构造。
/// 通过事件把响应块回传给发起窗口。
#[tauri::command]
pub async fn ai_chat_stream(
    window: Window,
    request_id: String,
    url: String,
    headers: HashMap<String, String>,
    body: String,
) -> Result<(), String> {
    let signal = Arc::new(Notify::new());
    SIGNALS
        .lock()
        .map_err(|_| "取消状态不可用")?
        .insert(request_id.clone(), signal.clone());
    let _guard = RequestGuard(request_id.clone());
    if is_cancelled(&request_id) {
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let response = request_before_stream(
        &client,
        &request_id,
        &signal,
        &url,
        &headers,
        &body,
        |notice| {
            let _ = window.emit("ai://retry", notice);
        },
    )
    .await;
    let result = match response {
        Ok(Some(resp)) => {
            consume_stream(resp, &request_id, &signal, |data| {
                let _ = window.emit(
                    "ai://chunk",
                    ChunkEvent {
                        request_id: request_id.clone(),
                        data,
                    },
                );
            })
            .await
        }
        Ok(None) => Ok(()),
        Err(message) => Err(message),
    };
    match result {
        Err(message) => {
            let _ = window.emit(
                "ai://error",
                ErrorEvent {
                    request_id: request_id.clone(),
                    message,
                },
            );
        }
        Ok(()) => {
            let _ = window.emit(
                "ai://done",
                DoneEvent {
                    request_id: request_id.clone(),
                },
            );
        }
    }
    Ok(())
}

/// Retry only rejected HTTP requests. Once a successful response is returned, its stream
/// is consumed exactly once; a broken stream must never replay an answer or tool calls.
async fn request_before_stream(
    client: &reqwest::Client,
    id: &str,
    signal: &Notify,
    url: &str,
    headers: &HashMap<String, String>,
    body: &str,
    mut on_retry: impl FnMut(RetryEvent),
) -> Result<Option<reqwest::Response>, String> {
    for attempt in 0..=MAX_RETRIES {
        if is_cancelled(id) {
            return Ok(None);
        }
        let mut req = client.post(url).body(body.to_owned());
        for (key, value) in headers {
            req = req.header(key.as_str(), value.as_str());
        }
        let resp = tokio::select! {
            biased;
            _ = signal.notified() => return Ok(None),
            result = req.send() => result.map_err(|e| friendly_network_error(&e))?,
        };
        if resp.status().is_success() {
            return Ok(Some(resp));
        }
        let status = resp.status().as_u16();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let text = tokio::select! {
            biased;
            _ = signal.notified() => return Ok(None),
            result = resp.text() => result.unwrap_or_default(),
        };
        let delay = retry_delay(
            status,
            retry_after.as_deref(),
            &text,
            attempt,
            chrono::Utc::now(),
        );
        let Some(delay) = delay.filter(|_| attempt < MAX_RETRIES) else {
            let mut message = friendly_http_error(status, &text);
            if attempt > 0 {
                message = format!("已自动重试 {attempt} 次，仍未成功。\n{message}");
            }
            return Err(message);
        };
        on_retry(RetryEvent {
            request_id: id.to_owned(),
            attempt: attempt + 1,
            max_retries: MAX_RETRIES,
            delay_ms: delay.as_millis() as u64,
            reason: if is_capacity_error(&text) {
                "AI 服务暂时满载"
            } else {
                "AI 服务暂时繁忙或限流"
            }
            .to_owned(),
        });
        tokio::select! {
            biased;
            _ = signal.notified() => return Ok(None),
            _ = tokio::time::sleep(delay) => {},
        }
    }
    unreachable!("retry loop always returns on its last attempt")
}

async fn consume_stream(
    resp: reqwest::Response,
    id: &str,
    signal: &Notify,
    mut on_chunk: impl FnMut(String),
) -> Result<(), String> {
    let mut stream = resp.bytes_stream();
    let mut decoder = Utf8Stream::default();
    loop {
        if is_cancelled(id) {
            return Ok(());
        }
        let item = tokio::select! {
            biased;
            _ = signal.notified() => return Ok(()),
            item = stream.next() => item,
        };
        match item {
            Some(Ok(bytes)) => {
                let text = decoder.push(&bytes);
                if !text.is_empty() {
                    on_chunk(text);
                }
            }
            Some(Err(e)) => return Err(format!("读取流失败：{e}。为避免重复回答，请手动重试。")),
            None => {
                let tail = decoder.finish();
                if !tail.is_empty() {
                    on_chunk(tail);
                }
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    #[test]
    fn every_utf8_byte_boundary_preserves_chinese_and_emoji() {
        let original = "data: 中文🙂与多字节回答\n\n";
        for split in 0..=original.len() {
            let mut decoder = Utf8Stream::default();
            let result = decoder.push(&original.as_bytes()[..split])
                + &decoder.push(&original.as_bytes()[split..])
                + &decoder.finish();
            assert_eq!(result, original);
        }
        let mut decoder = Utf8Stream::default();
        let mut text = String::new();
        for byte in original.as_bytes() {
            text += &decoder.push(&[*byte]);
        }
        text += &decoder.finish();
        assert_eq!(text, original);
    }
    #[tokio::test]
    async fn cancellation_wakes_without_a_network_chunk() {
        let signal = Arc::new(Notify::new());
        let pending = signal.clone();
        let task = tokio::spawn(async move {
            tokio::select! {_ = pending.notified()=>true,_=std::future::pending::<()>()=>false}
        });
        signal.notify_one();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(500), task)
                .await
                .unwrap()
                .unwrap()
        );
    }
}

fn is_capacity_error(body: &str) -> bool {
    let body = body.to_lowercase();
    [
        "ttft_admission_refused",
        "at capacity",
        "overloaded",
        "server_overloaded",
    ]
    .iter()
    .any(|marker| body.contains(marker))
}

fn is_quota_error(body: &str) -> bool {
    let body = body.to_lowercase();
    [
        "insufficient_quota",
        "quota_exceeded",
        "billing_hard_limit_reached",
        "billing_not_active",
        "insufficient balance",
        "insufficient_balance",
        "credit balance",
        "余额不足",
        "额度不足",
    ]
    .iter()
    .any(|marker| body.contains(marker))
}

fn parse_retry_after(value: &str, now: chrono::DateTime<chrono::Utc>) -> Option<Duration> {
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let deadline = chrono::DateTime::parse_from_rfc2822(value.trim()).ok()?;
    Some(
        (deadline.with_timezone(&chrono::Utc) - now)
            .to_std()
            .unwrap_or_default(),
    )
}

fn body_retry_after(body: &str) -> Option<Duration> {
    let body = body.to_lowercase();
    // A number of compatible gateways provide no header, but say "retry ... (after 11 s)".
    for (pos, _) in body.match_indices("after") {
        let rest =
            body[pos + 5..].trim_start_matches(|c: char| c.is_whitespace() || "_\":=".contains(c));
        let number: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if let Ok(mut seconds) = number.parse::<f64>() {
            let unit = rest[number.len()..].trim_start();
            if unit.starts_with("ms") || unit.starts_with("millisecond") {
                seconds /= 1000.0;
            } else if unit.starts_with("min") {
                seconds *= 60.0;
            } else if unit.starts_with("hour") {
                seconds *= 3600.0;
            }
            if let Ok(delay) = Duration::try_from_secs_f64(seconds) {
                return Some(delay);
            }
        }
    }
    None
}

fn retry_delay(
    status: u16,
    retry_after: Option<&str>,
    body: &str,
    attempt: u32,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<Duration> {
    if is_quota_error(body) || !matches!(status, 408 | 429 | 500 | 502 | 503 | 504) {
        return None;
    }
    let header_delay = retry_after.and_then(|v| parse_retry_after(v, now));
    let body_delay = body_retry_after(body);
    // Never retry before either server hint. If the service asks for a long wait,
    // leave an actionable error instead of keeping a chat busy indefinitely.
    let delay = match (header_delay, body_delay) {
        (Some(a), Some(b)) => a.max(b),
        (Some(a), None) | (None, Some(a)) => a,
        (None, None) => Duration::from_secs(2_u64 << attempt.min(MAX_RETRIES)),
    }
    .max(Duration::from_millis(250));
    (delay <= MAX_RETRY_WAIT).then_some(delay)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

/// 把 reqwest 网络错误翻译成用户能看懂的中文引导（断网 / 超时 / 地址错等）。
fn friendly_network_error(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "无法连接到 AI 服务：请检查网络是否正常，以及设置里的「接口地址」是否正确。".to_string()
    } else if e.is_timeout() {
        "连接 AI 服务超时：网络可能不稳定，请稍后重试。".to_string()
    } else if e.is_request() {
        "请求无法发出：请检查设置里的「接口地址」格式是否正确（应形如 https://api.openai.com/v1）。"
            .to_string()
    } else {
        // 兜底：给出简短技术信息但不吓人
        format!(
            "网络请求失败：{}。请检查网络连接后重试。",
            truncate(&e.to_string(), 160)
        )
    }
}

/// 把 HTTP 非 2xx 状态翻译成中文引导；常见鉴权/额度/地址错单独提示。
fn friendly_http_error(status: u16, body: &str) -> String {
    let hint = if status == 429 && is_quota_error(body) {
        "AI 服务账户额度不足：请检查账户余额或配额。"
    } else if matches!(status, 429 | 500..=599) && is_capacity_error(body) {
        "上游模型服务暂时满载：请稍后重试。此报错不表示 Markdown 文件过大或账户余额不足。"
    } else {
        match status {
            401 => "API Key 无效或缺失：请在设置里检查密钥是否填写正确。",
            403 => "访问被拒绝：密钥可能没有该模型的权限，或额度受限，请检查账户设置。",
            404 => "接口地址或模型不存在：请检查设置里的「接口地址」与「模型」名称。",
            413 => "请求内容过大：请缩小本轮文档范围或分段阅读。",
            429 => "AI 服务请求受到限流：请稍后重试，或检查账户的速率限制。",
            500..=599 => "AI 服务端出错：这是对方服务的问题，请稍后重试。",
            _ => "请求未成功。",
        }
    };
    let detail = truncate(body.trim(), 300);
    if detail.is_empty() {
        format!("{hint}（HTTP {status}）")
    } else {
        format!("{hint}（HTTP {status}）\n\n详情：{detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::thread;
    use std::time::Instant;

    const CAPACITY: &str = r#"{"error":{"type":"server_error","message":"Upstream request failed: [ttft_admission_refused] the cell is at capacity; retry shortly (after 11 s)"}}"#;

    fn response(status: u16, headers: &str, body: &str, extra_length: usize) -> String {
        format!("HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}", body.len() + extra_length)
    }

    /// A real local HTTP peer verifies retries at the transport boundary without credentials.
    fn server(replies: Vec<String>) -> (String, Arc<AtomicUsize>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let handle = thread::spawn(move || {
            for reply in replies {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                Instant::now() < deadline,
                                "expected HTTP request was never sent"
                            );
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(e) => panic!("accept failed: {e}"),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buf = [0_u8; 4096];
                loop {
                    let n = socket.read(&mut buf).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buf[..n]);
                    if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let length = head
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .and_then(|n| n.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                assert!(String::from_utf8_lossy(&request).contains(r#"{"model":"test"}"#));
                observed.fetch_add(1, Ordering::SeqCst);
                let _ = socket.write_all(reply.as_bytes());
            }
        });
        (url, count, handle)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
    }

    #[test]
    fn capacity_and_quota_have_distinct_guidance() {
        let busy = friendly_http_error(429, CAPACITY);
        assert!(busy.contains("暂时满载"));
        assert!(!busy.starts_with("AI 服务账户额度不足"));
        assert!(
            friendly_http_error(429, r#"{"error":{"code":"insufficient_quota"}}"#)
                .starts_with("AI 服务账户额度不足")
        );
        assert!(friendly_http_error(429, "rate_limit_exceeded").contains("受到限流"));
    }

    #[test]
    fn delays_respect_header_and_gateway_message() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-29T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            retry_delay(429, None, CAPACITY, 0, now),
            Some(Duration::from_secs(11))
        );
        assert_eq!(
            retry_delay(429, Some("20"), CAPACITY, 0, now),
            Some(Duration::from_secs(20))
        );
        assert_eq!(
            retry_delay(503, Some("Thu, 29 Oct 2026 00:00:13 GMT"), "", 0, now),
            Some(Duration::from_secs(13))
        );
        assert_eq!(retry_delay(429, Some("120"), CAPACITY, 0, now), None);
        assert_eq!(
            retry_delay(429, None, "retry after 0.5 s", 0, now),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            retry_delay(429, None, "retry after 1500 ms", 0, now),
            Some(Duration::from_millis(1500))
        );
        assert_eq!(
            retry_delay(429, None, "retry after 2 minutes", 0, now),
            None
        );
        assert_eq!(
            retry_delay(429, None, "rate_limit_exceeded", 2, now),
            Some(Duration::from_secs(8))
        );
        for status in [400, 401, 403, 404, 413] {
            assert_eq!(retry_delay(status, Some("1"), CAPACITY, 0, now), None);
        }
        assert_eq!(
            retry_delay(429, Some("1"), "insufficient_quota", 0, now),
            None
        );
    }

    #[tokio::test]
    async fn rejected_request_retries_then_streams_once() {
        let expected =
            "data: {\"choices\":[{\"delta\":{\"content\":\"recovered\"}}]}\n\ndata: [DONE]\n\n";
        let (url, count, peer) = server(vec![
            response(429, "Retry-After: 0\r\n", "server is at capacity", 0),
            response(200, "Content-Type: text/event-stream\r\n", expected, 0),
        ]);
        let mut notices = Vec::new();
        let resp = request_before_stream(
            &client(),
            "retry-success",
            &Notify::new(),
            &url,
            &HashMap::new(),
            r#"{"model":"test"}"#,
            |n| notices.push(n),
        )
        .await
        .unwrap()
        .unwrap();
        let mut received = String::new();
        consume_stream(resp, "retry-success", &Notify::new(), |s| {
            received.push_str(&s)
        })
        .await
        .unwrap();
        peer.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].attempt, 1);
        assert_eq!(received, expected);
    }

    #[tokio::test]
    async fn retries_are_bounded() {
        let (url, count, peer) = server(
            (0..=MAX_RETRIES)
                .map(|_| response(503, "Retry-After: 0\r\n", "busy", 0))
                .collect(),
        );
        let mut retries = 0;
        let result = request_before_stream(
            &client(),
            "retry-exhausted",
            &Notify::new(),
            &url,
            &HashMap::new(),
            r#"{"model":"test"}"#,
            |_| retries += 1,
        )
        .await;
        assert!(result.unwrap_err().contains("已自动重试 3 次"));
        peer.join().unwrap();
        assert_eq!(retries, MAX_RETRIES);
        assert_eq!(count.load(Ordering::SeqCst), (MAX_RETRIES + 1) as usize);
    }

    #[tokio::test]
    async fn quota_and_auth_failures_do_not_retry() {
        for (status, body) in [(429, "insufficient_quota"), (401, "invalid_api_key")] {
            let (url, count, peer) = server(vec![response(status, "Retry-After: 0\r\n", body, 0)]);
            let result = request_before_stream(
                &client(),
                "no-retry",
                &Notify::new(),
                &url,
                &HashMap::new(),
                r#"{"model":"test"}"#,
                |_| panic!("permanent failures must not retry"),
            )
            .await;
            assert!(result.is_err());
            peer.join().unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn cancel_during_server_wait_does_not_send_another_request() {
        let id = "cancel-retry-wait";
        clear_cancel(id);
        let signal = Arc::new(Notify::new());
        SIGNALS
            .lock()
            .unwrap()
            .insert(id.to_owned(), signal.clone());
        let _guard = RequestGuard(id.to_owned());
        let (url, count, peer) = server(vec![response(429, "", CAPACITY, 0)]);
        let started = Instant::now();
        let result = request_before_stream(
            &client(),
            id,
            &signal,
            &url,
            &HashMap::new(),
            r#"{"model":"test"}"#,
            |_| {
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    ai_cancel(id.to_owned());
                });
            },
        )
        .await
        .unwrap();
        assert!(result.is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
        clear_cancel(id);
        peer.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn partial_stream_failure_never_replays_request() {
        let partial = "data: partial answer\n\n";
        let (url, count, peer) = server(vec![response(
            200,
            "Content-Type: text/event-stream\r\n",
            partial,
            50,
        )]);
        let resp = request_before_stream(
            &client(),
            "partial-stream",
            &Notify::new(),
            &url,
            &HashMap::new(),
            r#"{"model":"test"}"#,
            |_| panic!("successful response must not retry"),
        )
        .await
        .unwrap()
        .unwrap();
        let mut received = String::new();
        let error = consume_stream(resp, "partial-stream", &Notify::new(), |s| {
            received.push_str(&s)
        })
        .await
        .unwrap_err();
        assert!(error.contains("避免重复回答"));
        assert_eq!(received, partial);
        peer.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
