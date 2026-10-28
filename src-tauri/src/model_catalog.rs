//! Public catalogue has no access to profiles, credentials, boards or knowledge.
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;
use std::{collections::HashMap, net::{IpAddr, SocketAddr}, path::Path, sync::Mutex, time::{Duration, Instant}};

static CATALOG_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
#[derive(Default, Serialize, Deserialize)]
struct Stored { revision: u64, providers: Vec<Value>, previous: Option<Vec<Value>> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { revision: u64, providers: Vec<Value>, can_rollback: bool }
impl Stored { fn snapshot(self) -> Snapshot { Snapshot { revision: self.revision, providers: self.providers, can_rollback: self.previous.is_some() } } }
fn read(path: &Path) -> Result<Stored,String> {
    if !path.exists() { return Ok(Stored::default()); }
    let bytes = std::fs::read(path).map_err(|_| "读取公共目录失败")?;
    if bytes.len() > 2_000_000 { return Err("公共目录缓存过大".into()); }
    let stored:Stored=serde_json::from_slice(&bytes).map_err(|_| "公共目录缓存格式无效，原文件已保留")?;
    validate(&stored.providers)?;
    if let Some(previous)=stored.previous.as_ref(){validate(previous)?;}
    Ok(stored)
}
fn path() -> Result<std::path::PathBuf,String> { Ok(crate::config::config_dir()?.join("model-catalog.json")) }
fn keys(value: &Value, allowed: &[&str]) -> bool { value.as_object().is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str()))) }
fn url(value: &str) -> Result<reqwest::Url,String> {
    let parsed = reqwest::Url::parse(value).map_err(|_| "地址格式无效")?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some_and(|p|p!=443) || value.len() > 2048 { return Err("公共资料只接受不含凭据的 HTTPS 地址".into()); }
    let host = parsed.host_str().ok_or("缺少公共资料域名")?;
    if !host.contains('.') || host.parse::<IpAddr>().is_ok() || [".local", ".localhost", ".internal"].iter().any(|s|host.ends_with(s)) { return Err("不能访问本机或内网资料地址".into()); }
    Ok(parsed)
}
fn number(value: &Value, field: &str, min: u64) -> Result<u64,String> {
    value[field].as_u64().filter(|n|*n>=min&&*n<=16_777_216).ok_or_else(||format!("目录额度无效：{field}"))
}
fn validate(providers: &[Value]) -> Result<(),String> {
    if providers.len() > 32 { return Err("供应商过多".into()); }
    let mut ids = std::collections::HashSet::new();
    for p in providers {
        if !keys(p,&["id","name","baseUrl","docs","note","models","sources","aliases"]) { return Err("供应商目录含不允许的字段".into()); }
        let id=p["id"].as_str().ok_or("缺少供应商ID")?;
        if id.is_empty() || id.len()>60 || !id.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'-') || !ids.insert(id) { return Err("供应商ID无效或重复".into()); }
        for field in ["baseUrl","docs"] { url(p[field].as_str().ok_or("缺少目录地址")?)?; }
        if let Some(aliases)=p["aliases"].as_array() { if aliases.len()>16 {return Err("旧地址过多".into());} for alias in aliases { url(alias.as_str().ok_or("旧地址无效")?)?; } }
        let models=p["models"].as_array().ok_or("缺少模型目录")?;
        if models.is_empty() || models.len()>120 { return Err("模型数量无效".into()); }
        let mut mids=std::collections::HashSet::new();
        for m in models {
            if !keys(m,&["id","label","window","output","maxInput","recommendedOutput","temperature","temperatureMax","temperaturePrecision","omitTemperature","outputParameter","extra","note","reasoning"]) {return Err("模型目录含不允许的字段".into());}
            let mid=m["id"].as_str().ok_or("缺少模型ID")?;
            if mid.is_empty()||mid.len()>180||!mid.bytes().all(|c|c.is_ascii_alphanumeric()||b"_./:+-".contains(&c))||!mids.insert(mid) {return Err("模型ID无效或重复".into());}
            let window=number(m,"window",8192)?; number(m,"output",1)?;
            if m.get("maxInput").is_some()&&number(m,"maxInput",1)?>window {return Err("独立输入上限超过窗口".into());}
            if let Some(parameter)=m["outputParameter"].as_str() {if !["max_tokens","max_completion_tokens"].contains(&parameter){return Err("尚未实现该输出协议".into());}}
            if let Some(extra)=m.get("extra") {if !keys(extra,&["reasoning_effort","top_p","thinking","enable_thinking"]){return Err("不能写入任意请求参数".into());}}
            if let Some(r)=m.get("reasoning") {
                if !keys(r,&["kind","levels","default"])|| !["deepseek","toggle","qwen","effort","openrouter"].contains(&r["kind"].as_str().unwrap_or("")) {return Err("思考协议无效".into());}
                let levels=r["levels"].as_array().ok_or("缺少思考档位")?;
                if levels.is_empty()||levels.len()>8||!levels.iter().all(|l|["none","enabled","minimal","low","medium","high","xhigh","max"].contains(&l.as_str().unwrap_or("")))||!levels.contains(&r["default"]) {return Err("思考档位无效".into());}
            }
        }
    }
    Ok(())
}
fn apply_at(path: &Path, expected: u64, providers: Vec<Value>, rollback: bool) -> Result<Snapshot,String> {
    let mut current=read(path)?;
    if current.revision!=expected { return Err("目录已被另一个窗口更新，请重新检查差异".into()); }
    let next = if rollback {current.previous.take().ok_or("没有可回退的目录版本")?} else {providers};
    validate(&next)?;
    let saved=Stored{revision:current.revision.checked_add(1).ok_or("目录版本溢出")?,providers:next,previous:Some(current.providers)};
    let parent=path.parent().ok_or("目录位置无效")?;
    std::fs::create_dir_all(parent).map_err(|_|"创建公共目录缓存失败")?;
    let serialized=serde_json::to_string(&saved).map_err(|_|"目录序列化失败")?;
    if serialized.len()>2_000_000{return Err("目录缓存已达上限，原目录保留".into());}
    crate::storage::atomic_write(path,&serialized)?;
    Ok(saved.snapshot())
}
#[tauri::command] pub fn model_catalog_load()->Result<Snapshot,String>{let _guard=CATALOG_LOCK.lock().map_err(|_|"目录锁失效")?; Ok(read(&path()?)?.snapshot())}
#[tauri::command] pub fn model_catalog_apply(app:tauri::AppHandle,expected_revision:u64,providers:Vec<Value>)->Result<Snapshot,String>{let _guard=CATALOG_LOCK.lock().map_err(|_|"目录锁失效")?; let result=apply_at(&path()?,expected_revision,providers,false)?;let _=app.emit("lumen://model-catalog-changed",result.revision);Ok(result)}
#[tauri::command] pub fn model_catalog_rollback(app:tauri::AppHandle,expected_revision:u64)->Result<Snapshot,String>{let _guard=CATALOG_LOCK.lock().map_err(|_|"目录锁失效")?;let result=apply_at(&path()?,expected_revision,vec![],true)?;let _=app.emit("lumen://model-catalog-changed",result.revision);Ok(result)}

fn public_ip(ip:IpAddr)->bool {
    match ip {
        IpAddr::V4(v)=>{let o=v.octets();!v.is_private()&&!v.is_loopback()&&!v.is_link_local()&&!v.is_broadcast()&&!v.is_unspecified()&&!v.is_multicast()&&o[0]!=0&&o[0]<224&&!(o[0]==100&&(64..=127).contains(&o[1]))&&!(o[0]==198&&[18,19,51].contains(&o[1]))&&!(o[0]==192&&o[1]==0)&&o!=[168,63,129,16]},
        IpAddr::V6(v)=>v.to_ipv4_mapped().map(|v|public_ip(IpAddr::V4(v))).unwrap_or(!v.is_loopback()&&!v.is_unspecified()&&!v.is_multicast()&&(v.segments()[0]&0xe000)==0x2000),
    }
}
async fn limited_body(resp:reqwest::Response,max:usize)->Result<String,String>{
    if resp.content_length().is_some_and(|n|n>max as u64){return Err("公共资料或测试响应过大".into());}
    let mut data=Vec::new();let mut stream=resp.bytes_stream();
    while let Some(chunk)=stream.next().await {let chunk=chunk.map_err(|_|"读取响应失败")?;if data.len()+chunk.len()>max{return Err("公共资料或测试响应过大".into());} data.extend_from_slice(&chunk);}
    String::from_utf8(data).map_err(|_|"资料不是 UTF-8 文本".into())
}
pub(crate) async fn public_get(address:&str)->Result<String,String>{
    public_get_limited(address,2_000_000).await
}
pub(crate) async fn public_get_limited(address:&str,limit:usize)->Result<String,String>{
    let parsed=url(address)?;let host=parsed.host_str().ok_or("缺少域名")?;
    let addresses:Vec<SocketAddr>=tokio::time::timeout(Duration::from_secs(6),tokio::net::lookup_host((host,443))).await.map_err(|_|"公共资料域名查询超时")?.map_err(|_|"无法解析公共资料域名")?.collect();
    if addresses.is_empty()||addresses.iter().any(|a|!public_ip(a.ip())){return Err("不能访问内网或保留地址".into());}
    let builder=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(20)).connect_timeout(Duration::from_secs(8)).user_agent("Lumen-Catalog/0.1.8").resolve_to_addrs(host,&addresses);
    // Only established production sources may use the existing proxy. Newly
    // discovered domains use a direct pinned connection, so a proxy cannot
    // re-resolve an attacker-controlled hostname into the private network.
    let builder=if trusted_proxy_host(host){builder}else{builder.no_proxy()};
    let client=builder.build().map_err(|_|"创建公共资料客户端失败")?;
    let response=client.get(parsed.clone()).send().await.map_err(|_|"无法读取公共资料，请检查网络或稍后重试")?;
    if !response.status().is_success(){return Err(format!("官方资料返回 HTTP {}，目录未更改",response.status().as_u16()));}
    let content_type=response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v|v.to_str().ok()).unwrap_or("");
    if !(content_type.starts_with("text/")||content_type.contains("json")||content_type.contains("xml")){return Err("公共来源没有返回可读文本".into());}
    limited_body(response,limit).await
}
fn trusted_proxy_host(host:&str)->bool{["html.duckduckgo.com","api-docs.deepseek.com","developers.openai.com","platform.openai.com","mimo.mi.com","help.aliyun.com","platform.kimi.com","docs.bigmodel.cn","opencode.ai","openrouter.ai","chatgpt.com","chat.openai.com"].contains(&host)}
#[tauri::command] pub async fn model_catalog_web_read(url:String)->Result<String,String>{public_get(&url).await}
#[tauri::command] pub async fn model_catalog_search(query:String)->Result<String,String>{
    if query.is_empty()||query.len()>300{return Err("搜索词无效".into());}
    let mut search=reqwest::Url::parse("https://html.duckduckgo.com/html/").unwrap();search.query_pairs_mut().append_pair("q",&query);
    public_get(search.as_str()).await
}
#[derive(Serialize)] #[serde(rename_all="camelCase")]
pub struct ConnectionResult{ok:bool,stage:String,status:Option<u16>,elapsed_ms:u128,message:String}
#[tauri::command] pub async fn ai_connection_test(url:String,headers:HashMap<String,String>,body:String)->Result<ConnectionResult,String>{
    let start=Instant::now();
    let parsed=reqwest::Url::parse(&url).map_err(|_|"接口地址无效")?;
    if !["https","http"].contains(&parsed.scheme())||!parsed.username().is_empty()||parsed.password().is_some()||body.len()>8000{return Err("测试请求无效".into());}
    let payload:Value=serde_json::from_str(&body).map_err(|_|"测试请求无效")?;
    if payload.get("tools").is_some()||payload["stream"]!=false||payload["messages"]!=json!([{"role":"user","content":"Reply with OK."}]) {return Err("连通测试只能发送固定合成问题".into());}
    let output=payload["max_tokens"].as_u64().or_else(||payload["max_completion_tokens"].as_u64()).unwrap_or(0);
    if output==0||output>1024{return Err("测试输出额度无效".into());}
    let client=reqwest::Client::builder().timeout(Duration::from_secs(20)).connect_timeout(Duration::from_secs(8)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"创建测试客户端失败")?;
    let mut request=client.post(parsed).body(body);
    for (name,value) in headers{if !["authorization","content-type","user-agent","x-opencode-session"].contains(&name.to_ascii_lowercase().as_str()){return Err("测试请求头无效".into());}request=request.header(&name,&value);}
    let result=request.send().await;
    let (ok,stage,status,message)=match result {
        Err(e)=>(false,"connect",None,if e.is_timeout(){"连接测试超时"}else{"无法连接接口，请检查地址与网络"}),
        Ok(resp)=>{
            let status=resp.status().as_u16();
            if status==401||status==403{(false,"auth",Some(status),"接口可达，鉴权或模型权限未通过")}
            else if !(200..300).contains(&status){(false,"model",Some(status),"接口可达，所选模型请求未成功；请检查模型、额度与协议")}
            else {let data=limited_body(resp,65536).await.ok().and_then(|s|serde_json::from_str::<Value>(&s).ok());let valid=data.as_ref().is_some_and(|v|v["choices"][0]["message"].is_object());if valid{(true,"model",Some(status),"鉴权通过，所选模型已响应；未测试最大上下文或长输出")}else{(false,"model",Some(status),"接口可达，但未收到兼容的模型响应")}}
        }
    };
    Ok(ConnectionResult{ok,stage:stage.into(),status,elapsed_ms:start.elapsed().as_millis(),message:message.into()})
}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn public_reader_rejects_local_credentials_and_unimplemented_schemes(){for value in ["http://example.com","https://127.0.0.1","https://[::1]","file:///etc/passwd","https://a:b@example.com","https://service.local","https://example.com:444"]{assert!(url(value).is_err(),"{value}");}assert!(url("https://api-docs.deepseek.com/api/list-models/").is_ok());}
 #[test]fn resolved_addresses_cannot_target_private_networks(){for ip in ["127.0.0.1","10.0.0.1","169.254.169.254","192.168.0.1","100.64.0.1","0.0.0.0","::1","fc00::1","fe80::1","::ffff:127.0.0.1"]{assert!(!public_ip(ip.parse().unwrap()),"{ip}");}assert!(public_ip("1.1.1.1".parse().unwrap()));}
 #[test]fn only_established_production_sources_may_use_the_existing_proxy(){assert!(trusted_proxy_host("opencode.ai"));assert!(!trusted_proxy_host("dev.opencode.ai"));assert!(!trusted_proxy_host("opencode.ai.attacker.example"));assert!(!trusted_proxy_host("new-provider.example"));}
 #[ignore="Manual anonymous official-document GET; never inference"] #[tokio::test]async fn live_official_metadata_read(){let document=public_get("https://api-docs.deepseek.com/api/list-models/").await.unwrap();assert!(document.contains("context_window")&&document.contains("1048576"));}
 #[tokio::test]async fn connection_test_is_one_synthetic_request_and_never_returns_a_reflected_secret(){
  use std::io::{Read,Write};let server=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=server.local_addr().unwrap();
  let capture=std::thread::spawn(move||{let(mut socket,_)=server.accept().unwrap();socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();let mut data=vec![];let mut block=[0u8;4096];loop{let count=socket.read(&mut block).unwrap();if count==0{break;}data.extend_from_slice(&block[..count]);if let Some(end)=data.windows(4).position(|v|v==b"\r\n\r\n"){let headers=String::from_utf8_lossy(&data[..end]);let length=headers.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);if data.len()>=end+4+length{break;}}}let response="synthetic-reflected-key";write!(socket,"HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();String::from_utf8(data).unwrap()});
  let result=ai_connection_test(format!("http://{address}/v1/chat/completions"),HashMap::from([("Authorization".into(),"Bearer synthetic-reflected-key".into()),("Content-Type".into(),"application/json".into())]),json!({"model":"synthetic-model","stream":false,"max_tokens":128,"messages":[{"role":"user","content":"Reply with OK."}]}).to_string()).await.unwrap();
  let request=capture.join().unwrap();assert!(request.contains("Reply with OK."));assert_eq!(result.stage,"auth");assert!(!result.ok);assert!(!serde_json::to_string(&result).unwrap().contains("synthetic-reflected-key"));
 }
 #[test]fn catalogue_validation_rejects_executable_fields_and_invalid_limits(){let p=json!({"id":"test","name":"Test","baseUrl":"https://example.com/v1","docs":"https://example.com/docs","models":[{"id":"test","window":1048576,"output":131072,"temperature":1}]});assert!(validate(&[p.clone()]).is_ok());let mut bad=p.clone();bad["headers"]=json!({"Authorization":"not-allowed"});assert!(validate(&[bad]).is_err());let mut bad=p;bad["models"][0]["window"]=json!(-1);assert!(validate(&[bad]).is_err());}
 #[test]fn expected_revision_and_rollback_preserve_unrelated_files(){let dir=std::env::temp_dir().join(format!("lumen-catalog-test-{}-{}",std::process::id(),chrono::Utc::now().timestamp_nanos_opt().unwrap()));std::fs::create_dir_all(&dir).unwrap();let path=dir.join("model-catalog.json");let marker=dir.join("connection-key-and-data.fixture");std::fs::write(&marker,"unchanged synthetic private fixture").unwrap();let providers=vec![json!({"id":"test","name":"Test","baseUrl":"https://example.com/v1","docs":"https://example.com/docs","models":[{"id":"test","window":1048576,"output":131072,"temperature":1}]})];assert_eq!(apply_at(&path,0,providers.clone(),false).unwrap().revision,1);assert!(apply_at(&path,0,vec![],false).is_err());assert_eq!(read(&path).unwrap().providers,providers);assert!(apply_at(&path,1,vec![],true).unwrap().providers.is_empty());assert_eq!(std::fs::read_to_string(marker).unwrap(),"unchanged synthetic private fixture");std::fs::remove_dir_all(&dir).unwrap();}
}
