//! Capability-authenticated loopback bridge for the optional stdio MCP adapter.
//! The renderer owns live buffers and review UI. No filesystem or execution API.
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{oneshot, Notify, Semaphore},
};

const MAX_REQUEST: usize = 512_000;
const MAX_RESPONSE: usize = 12_500_000;
const LEASE: Duration = Duration::from_secs(5);

fn failure() -> AppError {
    AppError::Other("agent:externalUnavailable".into())
}
fn rejected(code: &str) -> Value {
    json!({"error":code})
}

#[derive(Default)]
pub struct ExternalAgentState {
    grants: Mutex<HashMap<String, Arc<Grant>>>,
}

struct Grant {
    id: String,
    token: String,
    active: AtomicBool,
    heartbeat: Mutex<Instant>,
    queue: Mutex<VecDeque<ExternalRequest>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    cancelled: Notify,
}

impl Grant {
    fn new() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            token: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            active: AtomicBool::new(true),
            heartbeat: Mutex::new(Instant::now()),
            queue: Mutex::new(VecDeque::new()),
            pending: Mutex::new(HashMap::new()),
            cancelled: Notify::new(),
        }
    }
    fn available(&self) -> bool {
        self.active.load(Ordering::Acquire) && self.heartbeat.lock().elapsed() < LEASE
    }
    fn revoke(&self) {
        self.active.store(false, Ordering::Release);
        self.queue.lock().clear();
        for (_, sender) in self.pending.lock().drain() {
            let _ = sender.send(rejected("authorizationRevoked"));
        }
        self.cancelled.notify_one();
    }
    fn authenticate(&self, token: &str) -> bool {
        // Keep comparisons independent of the matching prefix.
        token.len() == self.token.len()
            && token
                .bytes()
                .zip(self.token.bytes())
                .fold(0, |diff, (a, b)| diff | (a ^ b))
                == 0
    }
}

/// Returned only to the authorizing renderer. Never persisted or logged.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalConnection {
    document_id: String,
    port: u16,
    token: String,
    adapter_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRequest {
    id: String,
    method: String,
    arguments: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    token: String,
    method: String,
    arguments: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalArguments {
    document_id: String,
    version: u64,
    snapshot_id: String,
    proposal: crate::commands::agent::Proposal,
}

/// Node's entry-point resolver cannot reliably open Windows verbatim paths.
/// This converts only the known absolute resource path; it does not resolve
/// caller-controlled paths or change the application's filesystem policy.
fn node_resource_path(path: &str, windows: bool) -> String {
    if !windows {
        return path.to_owned();
    }
    let Some(rest) = path.strip_prefix(r"\\?\") else {
        return path.to_owned();
    };
    if rest
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"UNC\"))
    {
        return format!(r"\\{}", &rest[4..]);
    }
    let bytes = rest.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
    {
        return rest.to_owned();
    }
    path.to_owned()
}

fn valid_arguments(method: &str, arguments: &Value) -> bool {
    let Some(fields) = arguments.as_object() else {
        return false;
    };
    match method {
        "read_document" => fields.keys().all(|key| key == "documentId"),
        "get_review_result" => {
            fields.len() == 2
                && fields
                    .keys()
                    .all(|key| matches!(key.as_str(), "documentId" | "proposalId"))
                && fields
                    .get("proposalId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        }
        "propose_edit" => {
            let Ok(args) = serde_json::from_value::<ProposalArguments>(arguments.clone()) else {
                return false;
            };
            let proposal = args.proposal;
            !args.document_id.is_empty()
                && args.version > 0
                && args.version <= 9_007_199_254_740_991
                && uuid::Uuid::parse_str(&args.snapshot_id).is_ok()
                && !proposal.title.trim().is_empty()
                && proposal.title.len() <= 300
                && proposal.old_text.is_none()
                && proposal.new_text.is_none()
                && !proposal.changes.is_empty()
                && proposal.changes.len() <= 32
                && proposal
                    .changes
                    .iter()
                    .map(|change| change.new_text.len())
                    .sum::<usize>()
                    <= 240_000
                && proposal.changes.iter().all(|change| {
                    change.old_text != change.new_text
                        && change.anchor.as_ref().map_or(true, |anchor| {
                            anchor.snapshot_id == args.snapshot_id
                                && anchor.from <= anchor.to
                                && anchor.to <= 2_000_000
                        })
                })
        }
        _ => false,
    }
}

#[tauri::command]
pub async fn cmd_agent_external_grant(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ExternalAgentState>,
) -> AppResult<ExternalConnection> {
    let adapter_path = app
        .path()
        .resource_dir()
        .map_err(|_| failure())?
        .join("markcaptain-mcp.mjs")
        .to_string_lossy()
        .into_owned();
    let adapter_path = node_resource_path(&adapter_path, cfg!(windows));
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| failure())?;
    let port = listener.local_addr().map_err(|_| failure())?.port();
    let grant = Arc::new(Grant::new());
    if let Some(old) = state
        .grants
        .lock()
        .insert(window.label().into(), grant.clone())
    {
        old.revoke();
    }
    let result = ExternalConnection {
        document_id: grant.id.clone(),
        port,
        token: grant.token.clone(),
        adapter_path,
    };
    tauri::async_runtime::spawn(serve(listener, grant));
    Ok(result)
}

#[tauri::command]
pub fn cmd_agent_external_revoke(
    window: WebviewWindow,
    state: State<'_, ExternalAgentState>,
    document_id: String,
) {
    let mut grants = state.grants.lock();
    if grants
        .get(window.label())
        .is_some_and(|grant| grant.id == document_id)
    {
        if let Some(grant) = grants.remove(window.label()) {
            grant.revoke();
        }
    }
}

fn owned(state: &ExternalAgentState, label: &str, document_id: &str) -> AppResult<Arc<Grant>> {
    state
        .grants
        .lock()
        .get(label)
        .filter(|grant| grant.id == document_id && grant.available())
        .cloned()
        .ok_or_else(failure)
}

#[tauri::command]
pub fn cmd_agent_external_take(
    window: WebviewWindow,
    state: State<'_, ExternalAgentState>,
    document_id: String,
) -> AppResult<Vec<ExternalRequest>> {
    let grant = owned(&state, window.label(), &document_id)?;
    *grant.heartbeat.lock() = Instant::now();
    let requests = grant.queue.lock().drain(..).collect();
    Ok(requests)
}

#[tauri::command]
pub fn cmd_agent_external_reply(
    window: WebviewWindow,
    state: State<'_, ExternalAgentState>,
    document_id: String,
    request_id: String,
    result: Value,
) -> AppResult<()> {
    let grant = owned(&state, window.label(), &document_id)?;
    if serde_json::to_vec(&result).map_err(|_| failure())?.len() > MAX_RESPONSE {
        return Err(failure());
    }
    if let Some(sender) = grant.pending.lock().remove(&request_id) {
        let _ = sender.send(result);
    }
    Ok(())
}

pub fn revoke_window(app: &AppHandle, label: &str) {
    if let Some(grant) = app
        .state::<ExternalAgentState>()
        .grants
        .lock()
        .remove(label)
    {
        grant.revoke();
    }
}

async fn serve(listener: TcpListener, grant: Arc<Grant>) {
    let connections = Arc::new(Semaphore::new(4));
    loop {
        tokio::select! {
            _ = grant.cancelled.notified() => break,
            _ = tokio::time::sleep(LEASE) => { if !grant.available() { grant.revoke(); break; } },
            connection = listener.accept() => {
                let Ok((stream, peer)) = connection else { break; };
                if !peer.ip().is_loopback() { continue; }
                let Ok(permit) = connections.clone().try_acquire_owned() else { continue; };
                let session = grant.clone();
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let _ = tokio::time::timeout(Duration::from_secs(10), connection_request(stream, session)).await;
                });
            }
        }
    }
}

async fn connection_request(stream: TcpStream, grant: Arc<Grant>) -> std::io::Result<()> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut wire = Vec::new();
    // fill_buf avoids unbounded allocation before discovering an oversized line.
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return Ok(());
        }
        let len = chunk
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(chunk.len(), |pos| pos + 1);
        if wire.len() + len > MAX_REQUEST {
            return Ok(());
        }
        wire.extend_from_slice(&chunk[..len]);
        let complete = chunk[len - 1] == b'\n';
        reader.consume(len);
        if complete {
            break;
        }
    }
    let result = match serde_json::from_slice::<WireRequest>(&wire) {
        Ok(request) if grant.authenticate(&request.token) && grant.available() => {
            dispatch(&grant, request).await
        }
        _ => rejected("unauthorized"),
    };
    // Revocation wins over a renderer response already in flight.
    let result = if grant.available() {
        result
    } else {
        rejected("authorizationRevoked")
    };
    let mut response = serde_json::to_vec(&result)?;
    if response.len() > MAX_RESPONSE {
        response = serde_json::to_vec(&rejected("responseTooLarge"))?;
    }
    response.push(b'\n');
    write.write_all(&response).await
}

async fn dispatch(grant: &Grant, request: WireRequest) -> Value {
    if !matches!(
        request.method.as_str(),
        "read_document" | "propose_edit" | "get_review_result"
    ) || !request.arguments.is_object()
    {
        return rejected("invalidRequest");
    }
    if request
        .arguments
        .get("documentId")
        .is_some_and(|id| id.as_str() != Some(&grant.id))
        || request.method != "read_document"
            && request.arguments.get("documentId").and_then(Value::as_str) != Some(&grant.id)
    {
        return rejected("wrongDocument");
    }
    if !valid_arguments(&request.method, &request.arguments) {
        return rejected("invalidRequest");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = grant.pending.lock();
        if !grant.available() {
            return rejected("authorizationRevoked");
        }
        if pending.len() >= 8 {
            return rejected("busy");
        }
        pending.insert(id.clone(), sender);
        grant.queue.lock().push_back(ExternalRequest {
            id: id.clone(),
            method: request.method,
            arguments: request.arguments,
        });
    }
    let result = tokio::time::timeout(Duration::from_secs(5), receiver).await;
    grant.pending.lock().remove(&id);
    grant.queue.lock().retain(|item| item.id != id);
    match result {
        Ok(Ok(value)) if grant.available() => value,
        _ => rejected("rendererUnavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_adapter_paths_preserve_platform_absolute_path_forms() {
        assert_eq!(
            node_resource_path(
                r"\\?\C:\Program Files\MarkCaptain\markcaptain-mcp.mjs",
                true
            ),
            r"C:\Program Files\MarkCaptain\markcaptain-mcp.mjs"
        );
        assert_eq!(
            node_resource_path(r"\\?\UNC\server\share\markcaptain-mcp.mjs", true),
            r"\\server\share\markcaptain-mcp.mjs"
        );
        assert_eq!(
            node_resource_path(r"C:\Apps\markcaptain-mcp.mjs", true),
            r"C:\Apps\markcaptain-mcp.mjs"
        );
        assert_eq!(
            node_resource_path(r"\\server\share\markcaptain-mcp.mjs", true),
            r"\\server\share\markcaptain-mcp.mjs"
        );
        assert_eq!(
            node_resource_path("/usr/share/markcaptain/markcaptain-mcp.mjs", false),
            "/usr/share/markcaptain/markcaptain-mcp.mjs"
        );
        assert_eq!(
            node_resource_path(r"\\?\C:\markcaptain-mcp.mjs", false),
            r"\\?\C:\markcaptain-mcp.mjs"
        );
    }
    fn request(grant: &Grant, method: &str, arguments: Value) -> WireRequest {
        WireRequest {
            token: grant.token.clone(),
            method: method.into(),
            arguments,
        }
    }

    #[tokio::test]
    async fn scope_and_revoke_are_enforced() {
        let grant = Arc::new(Grant::new());
        assert!(!grant.authenticate("incorrect"));
        assert_eq!(
            dispatch(
                &grant,
                request(&grant, "propose_edit", json!({"documentId":"other"}))
            )
            .await,
            rejected("wrongDocument")
        );
        assert_eq!(
            dispatch(&grant, request(&grant, "shell", json!({}))).await,
            rejected("invalidRequest")
        );
        let worker = grant.clone();
        let task = tokio::spawn(async move {
            dispatch(&worker, request(&worker, "read_document", json!({}))).await
        });
        tokio::task::yield_now().await;
        grant.revoke();
        assert_eq!(task.await.expect("join"), rejected("rendererUnavailable"));
        assert!(grant.queue.lock().is_empty());
        assert!(grant.pending.lock().is_empty());
    }

    #[test]
    fn window_ownership_and_expired_lease_are_enforced() {
        let state = ExternalAgentState::default();
        let grant = Arc::new(Grant::new());
        state.grants.lock().insert("first".into(), grant.clone());
        assert!(owned(&state, "second", &grant.id).is_err());
        assert!(owned(&state, "first", "other-document").is_err());
        *grant.heartbeat.lock() = Instant::now() - Duration::from_secs(6);
        assert!(owned(&state, "first", &grant.id).is_err());
    }

    #[test]
    fn proposal_arguments_have_bounded_strict_structure() {
        let snapshot = uuid::Uuid::new_v4().to_string();
        let valid = json!({"documentId":"document","version":1,"snapshotId":snapshot,"proposal":{"title":"Review","changes":[{"oldText":"same","newText":"changed","anchor":{"snapshotId":snapshot,"from":5,"to":9}}]}});
        assert!(valid_arguments("propose_edit", &valid));
        let mut invalid = valid.clone();
        invalid["proposal"]["save"] = json!(true);
        assert!(!valid_arguments("propose_edit", &invalid));
        let mut invalid = valid.clone();
        invalid["proposal"]["changes"][0]["anchor"]["to"] = json!(4);
        assert!(!valid_arguments("propose_edit", &invalid));
        let mut invalid = valid.clone();
        invalid["proposal"]["changes"] = json!(vec![valid["proposal"]["changes"][0].clone(); 33]);
        assert!(!valid_arguments("propose_edit", &invalid));
        let mut invalid = valid.clone();
        invalid["version"] = json!(0);
        assert!(!valid_arguments("propose_edit", &invalid));
        assert!(!valid_arguments(
            "read_document",
            &json!({"path":"/etc/passwd"})
        ));
    }

    #[tokio::test]
    async fn actual_tcp_authenticates_and_brokers_renderer_reply() {
        let grant = Arc::new(Grant::new());
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let worker = grant.clone();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            connection_request(stream, worker).await.expect("serve");
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client
            .write_all(
                format!(
                    "{}\n",
                    json!({"token":grant.token,"method":"read_document","arguments":{}})
                )
                .as_bytes(),
            )
            .await
            .expect("write");
        let queued = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(request) = grant.queue.lock().pop_front() {
                    break request;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("request queued");
        assert_eq!(queued.method, "read_document");
        grant
            .pending
            .lock()
            .remove(&queued.id)
            .expect("pending")
            .send(json!({"markdown":"unsaved 😃","version":1}))
            .expect("reply");
        let mut response = String::new();
        BufReader::new(client)
            .read_line(&mut response)
            .await
            .expect("read");
        assert_eq!(
            serde_json::from_str::<Value>(&response).expect("json")["markdown"],
            "unsaved 😃"
        );
        task.await.expect("join");
        assert!(grant.pending.lock().is_empty());
    }

    #[tokio::test]
    async fn actual_tcp_rejects_invalid_capability_without_queuing() {
        let grant = Arc::new(Grant::new());
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind");
        let address = listener.local_addr().expect("address");
        let worker = grant.clone();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            connection_request(stream, worker).await.expect("serve");
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client
            .write_all(b"{\"token\":\"wrong\",\"method\":\"read_document\",\"arguments\":{}}\n")
            .await
            .expect("write");
        let mut response = String::new();
        BufReader::new(client)
            .read_line(&mut response)
            .await
            .expect("read");
        assert_eq!(
            serde_json::from_str::<Value>(&response).expect("json"),
            rejected("unauthorized")
        );
        task.await.expect("join");
        assert!(grant.queue.lock().is_empty());
    }
}
