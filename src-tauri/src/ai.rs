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
//!
//! 取消：前端调用 ai_cancel(request_id) 置位；流循环检测到即中断。

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{Emitter, Window};

/// 已请求取消的 request_id 集合。
static CANCELLED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

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
        s.insert(request_id);
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
    // 起点：清掉可能残留的取消标记
    clear_cancel(&request_id);

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut req = client.post(&url).body(body);
    for (k, v) in headers.iter() {
        req = req.header(k.as_str(), v.as_str());
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = window.emit(
                "ai://error",
                ErrorEvent {
                    request_id: request_id.clone(),
                    message: friendly_network_error(&e),
                },
            );
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = friendly_http_error(status.as_u16(), &text);
        let _ = window.emit(
            "ai://error",
            ErrorEvent {
                request_id: request_id.clone(),
                message: msg,
            },
        );
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    while let Some(item) = stream.next().await {
        if is_cancelled(&request_id) {
            clear_cancel(&request_id);
            // 视作正常结束（前端已知晓是自己取消的）
            let _ = window.emit(
                "ai://done",
                DoneEvent {
                    request_id: request_id.clone(),
                },
            );
            return Ok(());
        }
        match item {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes).to_string();
                let _ = window.emit(
                    "ai://chunk",
                    ChunkEvent {
                        request_id: request_id.clone(),
                        data: text,
                    },
                );
            }
            Err(e) => {
                let _ = window.emit(
                    "ai://error",
                    ErrorEvent {
                        request_id: request_id.clone(),
                        message: format!("读取流失败: {e}"),
                    },
                );
                return Ok(());
            }
        }
    }

    clear_cancel(&request_id);
    let _ = window.emit(
        "ai://done",
        DoneEvent {
            request_id: request_id.clone(),
        },
    );
    Ok(())
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
        format!("网络请求失败：{}。请检查网络连接后重试。", truncate(&e.to_string(), 160))
    }
}

/// 把 HTTP 非 2xx 状态翻译成中文引导；常见鉴权/额度/地址错单独提示。
fn friendly_http_error(status: u16, body: &str) -> String {
    let hint = match status {
        401 => "API Key 无效或缺失：请在设置里检查密钥是否填写正确。",
        403 => "访问被拒绝：密钥可能没有该模型的权限，或额度受限，请检查账户设置。",
        404 => "接口地址或模型不存在：请检查设置里的「接口地址」与「模型」名称。",
        429 => "请求过于频繁或额度不足：请稍后重试，或检查账户余额与限流设置。",
        500..=599 => "AI 服务端出错：这是对方服务的问题，请稍后重试。",
        _ => "请求未成功。",
    };
    let detail = truncate(body.trim(), 300);
    if detail.is_empty() {
        format!("{hint}（HTTP {status}）")
    } else {
        format!("{hint}（HTTP {status}）\n\n详情：{detail}")
    }
}

