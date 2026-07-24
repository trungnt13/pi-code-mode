use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::num::NonZeroU32;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use codex_code_mode::InProcessCodeModeSession;
use codex_code_mode_protocol::host::Capability;
use codex_code_mode_protocol::host::CapabilitySet;
use codex_code_mode_protocol::host::CellLimits;
use codex_code_mode_protocol::host::ClientToHost;
use codex_code_mode_protocol::host::EncodedFrame;
use codex_code_mode_protocol::host::FramedReader;
use codex_code_mode_protocol::host::FramedWriter;
use codex_code_mode_protocol::host::HandshakeRejectReason;
use codex_code_mode_protocol::host::HostHello;
use codex_code_mode_protocol::host::HostRequest;
use codex_code_mode_protocol::host::HostResponse;
use codex_code_mode_protocol::host::HostToClient;
use codex_code_mode_protocol::host::MAX_FRAME_BYTES;
use codex_code_mode_protocol::host::ProcessLimits;
use codex_code_mode_protocol::host::ProtocolVersion;
use codex_code_mode_protocol::host::RESOURCE_LIMITS_V1;
use codex_code_mode_protocol::host::RequestId;
use codex_code_mode_protocol::host::SessionId;
use codex_code_mode_protocol::host::SessionLimits;
use codex_code_mode_protocol::host::SupportedProtocolVersions;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::sync::OwnedSemaphorePermit;
use tokio::sync::Semaphore;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use self::delegate::RemoteDelegate;
use self::peer::HostPeer;
use self::peer::OutgoingFrame;

mod delegate;
mod peer;

const MAX_IN_FLIGHT_REQUESTS: usize = 256;
const MAX_ACTIVE_CELLS: usize = 128;
const MAX_OPEN_SESSIONS: usize = 64;
const MAX_COMMITTED_STATE_BYTES_PER_SESSION: u32 = 4 * 1024 * 1024;
const MAX_CELL_HEAP_BYTES: u32 = 64 * 1024 * 1024;
const MAX_CELL_WALL_TIME_MS: u32 = 60_000;
const MAX_CELL_TIMERS: u32 = 16;
const MAX_CELL_OUTPUT_BYTES: u32 = 4 * 1024 * 1024;
const MAX_DELEGATE_RESULT_BYTES: u32 = 4 * 1024 * 1024;
const MAX_TOOL_DEFINITION_BYTES: u32 = 1024 * 1024;
const MAX_RECENT_REQUEST_IDS: usize = 4096;
const MAX_RECENT_SESSION_IDS: usize = 4096;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs one code-mode host connection over the process standard streams.
pub async fn run_stdio() -> Result<()> {
    run(tokio::io::stdin(), tokio::io::stdout()).await
}

/// Runs one code-mode host connection over an ordered input/output pair.
async fn run<R, W>(reader: R, writer: W) -> Result<()>
where
    R: AsyncRead + Send + Unpin + 'static,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let mut reader = FramedReader::new(reader);
    let mut writer = FramedWriter::new(writer);
    let Some(resource_limits_selected) = negotiate(&mut reader, &mut writer).await? else {
        return Ok(());
    };

    let (outgoing_tx, mut outgoing_rx) = mpsc::channel::<OutgoingFrame>(/*max_capacity*/ 128);
    let peer = Arc::new(HostPeer::new(outgoing_tx));
    let state = Arc::new(HostState {
        sessions: Mutex::new(HashMap::new()),
        seen_session_ids: Mutex::new(SeenSessionIds::default()),
        requests: Mutex::new(RequestRegistry::default()),
        request_tasks: TaskTracker::new(),
        request_permits: Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS)),
        active_cell_permits: Arc::new(Semaphore::new(MAX_ACTIVE_CELLS)),
        closing: AtomicBool::new(false),
        peer: Arc::clone(&peer),
        resource_limits_selected,
    });
    let writer_disconnected = peer.disconnection_token();
    let writer_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_disconnected.cancelled() => return Ok::<(), anyhow::Error>(()),
                outgoing = outgoing_rx.recv() => {
                    let Some(outgoing) = outgoing else {
                        return Ok(());
                    };
                    if let Err(err) = writer.write_frame(&outgoing.frame).await {
                        if let Some(written_tx) = outgoing.written_tx {
                            let _ = written_tx.send(Err(err.to_string()));
                        }
                        return Err(
                            anyhow::Error::new(err)
                                .context("failed to write code-mode host message")
                        );
                    }
                    if let Some(written_tx) = outgoing.written_tx {
                        let _ = written_tx.send(Ok(()));
                    }
                }
            }
        }
    });
    let writer_peer = Arc::clone(&peer);
    let writer_supervisor = tokio::spawn(async move {
        match writer_task.await {
            Ok(Ok(())) if !writer_peer.is_disconnected() => {
                writer_peer.fail("code-mode writer task exited unexpectedly".to_string());
            }
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                writer_peer.fail(format!("code-mode writer task failed: {err:#}"));
            }
            Err(err) => {
                writer_peer.fail(format!("code-mode writer task failed: {err}"));
            }
        }
    });

    let input_result = async {
        loop {
            let message = tokio::select! {
                _ = peer.disconnected() => break,
                message = reader.read::<ClientToHost>() => message
                    .context("failed to read code-mode client message")?,
            };
            let Some(message) = message else {
                break;
            };
            match message {
                ClientToHost::ClientHello(_) => {
                    anyhow::bail!("received a second code-mode client hello");
                }
                ClientToHost::Request { id, request } => {
                    state.spawn_request(id, request)?;
                }
                ClientToHost::CancelRequest { id } => {
                    state.cancel_request(id);
                }
                ClientToHost::DelegateResponse { id, result } => {
                    peer.complete(id, result.into_result()).await;
                }
            }
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    peer.disconnect();
    if tokio::time::timeout(SHUTDOWN_TIMEOUT, state.disconnect())
        .await
        .is_err()
    {
        peer.fail("timed out shutting down code-mode host state".to_string());
    }
    drop(state);
    tokio::time::timeout(SHUTDOWN_TIMEOUT, writer_supervisor)
        .await
        .context("timed out supervising code-mode writer task")?
        .context("code-mode writer supervisor task failed")?;
    let failure = peer.failure();
    drop(peer);
    input_result?;
    if let Some(failure) = failure {
        anyhow::bail!(failure);
    }
    Ok(())
}

async fn negotiate<R, W>(
    reader: &mut FramedReader<R>,
    writer: &mut FramedWriter<W>,
) -> Result<Option<bool>>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let Some(first_message) = reader
        .read::<ClientToHost>()
        .await
        .context("failed to read code-mode client hello")?
    else {
        return Ok(None);
    };
    let ClientToHost::ClientHello(client_hello) = first_message else {
        writer
            .write(&HostToClient::HandshakeRejected {
                reason: HandshakeRejectReason::InvalidHello {
                    message: "first message must be connection/hello".to_string(),
                },
            })
            .await
            .context("failed to reject invalid code-mode client hello")?;
        return Ok(None);
    };

    let supported_versions = SupportedProtocolVersions::try_new([ProtocolVersion::V1])?;
    if !client_hello
        .supported_versions()
        .contains(ProtocolVersion::V1)
    {
        writer
            .write(&HostToClient::HandshakeRejected {
                reason: HandshakeRejectReason::NoCompatibleVersion { supported_versions },
            })
            .await
            .context("failed to reject incompatible code-mode client")?;
        return Ok(None);
    }

    let resource_limits = Capability::new(RESOURCE_LIMITS_V1)?;
    let host_capabilities = CapabilitySet::try_new([resource_limits.clone()])?;
    if let Some(capability) = client_hello
        .required_capabilities()
        .iter()
        .find(|capability| !host_capabilities.contains(capability))
    {
        writer
            .write(&HostToClient::HandshakeRejected {
                reason: HandshakeRejectReason::MissingRequiredCapability {
                    capability: capability.clone(),
                },
            })
            .await
            .context("failed to reject unsupported code-mode capability")?;
        return Ok(None);
    }

    let selected = client_hello
        .required_capabilities()
        .contains(&resource_limits)
        || client_hello
            .optional_capabilities()
            .contains(&resource_limits);
    let selected_capabilities = if selected {
        CapabilitySet::try_new([resource_limits])?
    } else {
        CapabilitySet::empty()
    };

    let hello = if selected {
        HostHello::with_process_limits(ProtocolVersion::V1, selected_capabilities, process_limits())
    } else {
        HostHello::new(ProtocolVersion::V1, selected_capabilities)
    };
    writer
        .write(&HostToClient::HostHello(hello))
        .await
        .context("failed to write code-mode host hello")?;
    Ok(Some(selected))
}

fn process_limits() -> ProcessLimits {
    ProcessLimits {
        max_frame_bytes: nonzero(MAX_FRAME_BYTES as u32),
        max_open_sessions: nonzero(MAX_OPEN_SESSIONS as u32),
        max_committed_state_bytes_per_session: nonzero(MAX_COMMITTED_STATE_BYTES_PER_SESSION),
        max_active_cells: nonzero(MAX_ACTIVE_CELLS as u32),
        max_in_flight_operations: nonzero(MAX_IN_FLIGHT_REQUESTS as u32),
        max_delegate_calls: nonzero(256),
        max_cell_limits: CellLimits {
            heap_bytes: nonzero(MAX_CELL_HEAP_BYTES),
            wall_time_ms: nonzero(MAX_CELL_WALL_TIME_MS),
            pending_timers: nonzero(MAX_CELL_TIMERS),
            output_bytes: nonzero(MAX_CELL_OUTPUT_BYTES),
            delegate_result_bytes: nonzero(MAX_DELEGATE_RESULT_BYTES),
            tool_definition_bytes: nonzero(MAX_TOOL_DEFINITION_BYTES),
        },
    }
}

const fn nonzero(value: u32) -> NonZeroU32 {
    match NonZeroU32::new(value) {
        Some(value) => value,
        None => panic!("resource limit must be positive"),
    }
}

struct HostSession {
    runtime: Arc<InProcessCodeModeSession>,
    limits: Option<SessionLimits>,
    active_cell_permits: Option<Arc<Semaphore>>,
    start_gate: Arc<Semaphore>,
}

impl HostSession {
    async fn acquire_start_gate(&self) -> Result<OwnedSemaphorePermit, String> {
        Arc::clone(&self.start_gate)
            .acquire_owned()
            .await
            .map_err(|_| "code-mode session start gate closed".to_string())
    }
}

struct HostState {
    sessions: Mutex<HashMap<SessionId, HostSession>>,
    seen_session_ids: Mutex<SeenSessionIds>,
    requests: Mutex<RequestRegistry>,
    request_tasks: TaskTracker,
    request_permits: Arc<Semaphore>,
    active_cell_permits: Arc<Semaphore>,
    closing: AtomicBool,
    peer: Arc<HostPeer>,
    resource_limits_selected: bool,
}

impl HostState {
    fn spawn_request(
        self: &Arc<Self>,
        request_id: RequestId,
        request: HostRequest,
    ) -> Result<(), anyhow::Error> {
        let cancellation = self
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .start(request_id, RequestKind::from(&request))?;
        let Ok(permit) = Arc::clone(&self.request_permits).try_acquire_owned() else {
            self.respond(
                request_id,
                Err("code-mode host has too many in-flight requests".to_string()),
            );
            self.finish_request(request_id);
            return Ok(());
        };
        let state = Arc::clone(self);
        let request_task = self.request_tasks.spawn(async move {
            let _permit = permit;
            state
                .handle_request(request_id, request, cancellation)
                .await;
            state.finish_request(request_id);
        });
        self.supervise_request_task(request_task);
        Ok(())
    }

    fn supervise_request_task(&self, task: tokio::task::JoinHandle<()>) {
        let peer = Arc::clone(&self.peer);
        tokio::spawn(async move {
            if let Err(err) = task.await {
                peer.fail(format!("code-mode request task failed: {err}"));
            }
        });
    }

    async fn handle_request(
        &self,
        request_id: RequestId,
        request: HostRequest,
        cancellation: CancellationToken,
    ) {
        if self.closing.load(Ordering::Acquire) {
            self.respond(
                request_id,
                Err("code-mode host is shutting down".to_string()),
            );
            return;
        }
        match request {
            HostRequest::OpenSession { session_id, limits } => {
                let result = self
                    .open_session(session_id.clone(), limits)
                    .map(|limits| HostResponse::SessionReady { session_id, limits });
                self.respond(request_id, result);
            }
            HostRequest::Execute {
                session_id,
                request,
                limits,
            } => {
                if cancellation.is_cancelled() {
                    self.respond(request_id, Err("code-mode request cancelled".to_string()));
                    return;
                }
                if self.resource_limits_selected != limits.is_some() {
                    self.respond(
                        request_id,
                        Err("resource_limits_v1 requires exact cell limits".to_string()),
                    );
                    return;
                }
                let session = match self.session(&session_id) {
                    Ok(session) => session,
                    Err(err) => {
                        self.respond(request_id, Err(err));
                        return;
                    }
                };
                if let (Some(limits), Some(session_limits)) = (limits, session.limits)
                    && !limits.fits_within(session_limits.max_cell_limits)
                {
                    self.respond(
                        request_id,
                        Err("cell limits exceed session ceilings".to_string()),
                    );
                    return;
                }
                if let Some(limits) = limits {
                    let observed =
                        EncodedFrame::encoded_len(&request.enabled_tools).unwrap_or(usize::MAX);
                    if observed > limits.tool_definition_bytes.get() as usize {
                        self.respond(request_id, Err(format!("resource limit exceeded: code=resource_exhausted resource=tool_definition_bytes limit={} observed={observed}", limits.tool_definition_bytes)));
                        return;
                    }
                }
                let request = match request.try_into() {
                    Ok(request) => request,
                    Err(err) => {
                        self.respond(
                            request_id,
                            Err(format!("invalid code-mode execute request: {err}")),
                        );
                        return;
                    }
                };
                let Ok(active_cell_permit) =
                    Arc::clone(&self.active_cell_permits).try_acquire_owned()
                else {
                    self.respond(
                        request_id,
                        Err("code-mode host has too many active cells".to_string()),
                    );
                    return;
                };
                let session_cell_permit = match &session.active_cell_permits {
                    Some(permits) => match Arc::clone(permits).try_acquire_owned() {
                        Ok(permit) => Some(permit),
                        Err(_) => {
                            self.respond(
                                request_id,
                                Err("code-mode session has too many active cells".to_string()),
                            );
                            return;
                        }
                    },
                    None => None,
                };
                if self.resource_limits_selected {
                    let start_guard = match session.acquire_start_gate().await {
                        Ok(start_guard) => start_guard,
                        Err(err) => {
                            self.respond(request_id, Err(err));
                            return;
                        }
                    };
                    let reserved = match session.runtime.reserve_execute(request, limits).await {
                        Ok(reserved) => reserved,
                        Err(err) => {
                            self.respond(request_id, Err(err));
                            return;
                        }
                    };
                    let cell_id = reserved.cell_id();
                    if self
                        .peer
                        .respond_and_wait(
                            request_id,
                            Ok(HostResponse::ExecutionStarted {
                                cell_id: (&cell_id).into(),
                                limits,
                            }),
                        )
                        .await
                        .is_err()
                    {
                        session.runtime.release_reserved_execute(reserved).await;
                        return;
                    }
                    if cancellation.is_cancelled() {
                        session.runtime.release_reserved_execute(reserved).await;
                        self.peer.initial_error(
                            request_id,
                            "code-mode request cancelled before cell start".to_string(),
                        );
                        return;
                    }
                    match session.runtime.start_reserved_execute(reserved).await {
                        Ok(started) => {
                            drop(start_guard);
                            let initial_response_sent = self.peer.start_cell(
                                session_id,
                                request_id,
                                started,
                                active_cell_permit,
                                session_cell_permit,
                            );
                            let _ = initial_response_sent.await;
                        }
                        Err(err) => self.peer.initial_error(request_id, err),
                    }
                } else {
                    match session.runtime.execute(request).await {
                        Ok(started) => {
                            let cell_id = started.cell_id.clone();
                            self.respond(
                                request_id,
                                Ok(HostResponse::ExecutionStarted {
                                    cell_id: cell_id.into(),
                                    limits: None,
                                }),
                            );
                            let initial_response_sent = self.peer.start_cell(
                                session_id,
                                request_id,
                                started,
                                active_cell_permit,
                                session_cell_permit,
                            );
                            let _ = initial_response_sent.await;
                        }
                        Err(err) => self.respond(request_id, Err(err)),
                    }
                }
            }
            HostRequest::Wait {
                session_id,
                request,
            } => {
                let result = match self.session(&session_id) {
                    Ok(session) => {
                        let pending = if self.resource_limits_selected {
                            let _start_guard = match session.acquire_start_gate().await {
                                Ok(start_guard) => start_guard,
                                Err(err) => {
                                    self.respond(request_id, Err(err));
                                    return;
                                }
                            };
                            session.runtime.begin_wait(request.into()).await
                        } else {
                            session.runtime.begin_wait(request.into()).await
                        };
                        tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => {
                                Err("code-mode request cancelled".to_string())
                            }
                            result = pending => result.map(|outcome| {
                                HostResponse::WaitCompleted {
                                    outcome: outcome.into(),
                                }
                            }),
                        }
                    }
                    Err(err) => Err(err),
                };
                self.respond(request_id, result);
            }
            HostRequest::Terminate {
                session_id,
                cell_id,
            } => {
                let result = match self.session(&session_id) {
                    Ok(session) => {
                        let cell_id = cell_id.into();
                        let pending = if self.resource_limits_selected {
                            let _start_guard = match session.acquire_start_gate().await {
                                Ok(start_guard) => start_guard,
                                Err(err) => {
                                    self.respond(request_id, Err(err));
                                    return;
                                }
                            };
                            session.runtime.begin_terminate(cell_id).await
                        } else {
                            session.runtime.begin_terminate(cell_id).await
                        };
                        pending.await.map(|outcome| HostResponse::WaitCompleted {
                            outcome: outcome.into(),
                        })
                    }
                    Err(err) => Err(err),
                };
                self.respond(request_id, result);
            }
            HostRequest::ShutdownSession { session_id } => {
                let session = self
                    .sessions
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&session_id);
                let result = match session {
                    Some(session) => match session.runtime.shutdown().await {
                        Ok(()) => {
                            self.peer.wait_for_session_cells(&session_id).await;
                            Ok(HostResponse::SessionClosed { session_id })
                        }
                        Err(err) => Err(err),
                    },
                    None => Err(format!("unknown code-mode session {session_id}")),
                };
                self.respond(request_id, result);
            }
        }
    }

    fn open_session(
        &self,
        session_id: SessionId,
        limits: Option<SessionLimits>,
    ) -> Result<Option<SessionLimits>, String> {
        if self.resource_limits_selected != limits.is_some() {
            return Err("resource_limits_v1 requires exact session limits".to_string());
        }
        if let Some(limits) = limits
            && !limits.fits_within(process_limits())
        {
            return Err("session limits exceed process ceilings".to_string());
        }
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        if sessions.contains_key(&session_id) {
            return Err(format!(
                "code-mode session ID `{session_id}` is already open"
            ));
        }
        if self.resource_limits_selected && sessions.len() >= MAX_OPEN_SESSIONS {
            return Err("code-mode host has too many open sessions".to_string());
        }
        if self.closing.load(Ordering::Acquire) {
            return Err("code-mode host is shutting down".to_string());
        }
        if !self
            .seen_session_ids
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remember(session_id.clone())
        {
            return Err(format!("code-mode session ID `{session_id}` was reused"));
        }
        let delegate = Arc::new(RemoteDelegate::new(
            session_id.clone(),
            Arc::clone(&self.peer),
            limits.map(|limits| limits.max_delegate_calls.get() as usize),
        ));
        let peer = Arc::downgrade(&self.peer);
        let task_failure_handler = Arc::new(move |reason| {
            if let Some(peer) = peer.upgrade() {
                peer.fail(reason);
            }
        });
        let runtime = match limits {
            Some(limits) => {
                InProcessCodeModeSession::with_delegate_task_failure_handler_and_state_limit(
                    delegate,
                    task_failure_handler,
                    limits.max_committed_state_bytes.get() as usize,
                    limits.max_delegate_calls.get() as usize,
                )
            }
            None => InProcessCodeModeSession::with_delegate_and_task_failure_handler(
                delegate,
                task_failure_handler,
            ),
        };
        sessions.insert(
            session_id,
            HostSession {
                runtime: Arc::new(runtime),
                limits,
                active_cell_permits: limits
                    .map(|limits| Arc::new(Semaphore::new(limits.max_active_cells.get() as usize))),
                start_gate: Arc::new(Semaphore::new(1)),
            },
        );
        Ok(limits)
    }

    fn session(&self, session_id: &SessionId) -> Result<HostSession, String> {
        self.sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session_id)
            .map(|session| HostSession {
                runtime: Arc::clone(&session.runtime),
                limits: session.limits,
                active_cell_permits: session.active_cell_permits.clone(),
                start_gate: Arc::clone(&session.start_gate),
            })
            .ok_or_else(|| format!("unknown code-mode session {session_id}"))
    }

    fn respond(&self, id: RequestId, result: Result<HostResponse, String>) {
        self.peer.respond(id, result);
    }

    fn cancel_request(&self, request_id: RequestId) {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .cancel(request_id);
    }

    fn finish_request(&self, request_id: RequestId) {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .finish(request_id);
    }

    async fn disconnect(&self) {
        self.closing.store(true, Ordering::Release);
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .cancel_all();
        self.request_tasks.close();
        self.request_tasks.wait().await;
        let sessions = self
            .sessions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in sessions {
            let _ = session.runtime.shutdown().await;
        }
    }
}

#[derive(Clone, Copy)]
enum RequestKind {
    OpenSession,
    Execute,
    Wait,
    Terminate,
    ShutdownSession,
}

impl RequestKind {
    fn from(request: &HostRequest) -> Self {
        match request {
            HostRequest::OpenSession { .. } => Self::OpenSession,
            HostRequest::Execute { .. } => Self::Execute,
            HostRequest::Wait { .. } => Self::Wait,
            HostRequest::Terminate { .. } => Self::Terminate,
            HostRequest::ShutdownSession { .. } => Self::ShutdownSession,
        }
    }

    fn is_cancellable(self) -> bool {
        matches!(self, Self::Execute | Self::Wait)
    }
}

struct ActiveRequest {
    kind: RequestKind,
    cancellation: CancellationToken,
}

#[derive(Default)]
struct RequestRegistry {
    active: HashMap<RequestId, ActiveRequest>,
    recent: HashSet<RequestId>,
    recent_order: VecDeque<RequestId>,
}

impl RequestRegistry {
    fn start(
        &mut self,
        request_id: RequestId,
        kind: RequestKind,
    ) -> Result<CancellationToken, anyhow::Error> {
        if self.active.contains_key(&request_id) || self.recent.contains(&request_id) {
            anyhow::bail!("duplicate code-mode request ID {request_id:?}");
        }
        let cancellation = CancellationToken::new();
        self.active.insert(
            request_id,
            ActiveRequest {
                kind,
                cancellation: cancellation.clone(),
            },
        );
        Ok(cancellation)
    }

    fn cancel(&self, request_id: RequestId) {
        if let Some(request) = self.active.get(&request_id)
            && request.kind.is_cancellable()
        {
            request.cancellation.cancel();
        }
    }

    fn finish(&mut self, request_id: RequestId) {
        if self.active.remove(&request_id).is_none() {
            return;
        }
        self.recent.insert(request_id);
        self.recent_order.push_back(request_id);
        while self.recent_order.len() > MAX_RECENT_REQUEST_IDS {
            if let Some(expired) = self.recent_order.pop_front() {
                self.recent.remove(&expired);
            }
        }
    }

    fn cancel_all(&self) {
        for request in self.active.values() {
            request.cancellation.cancel();
        }
    }
}

#[derive(Default)]
struct SeenSessionIds {
    ids: HashSet<SessionId>,
    order: VecDeque<SessionId>,
}

impl SeenSessionIds {
    fn remember(&mut self, session_id: SessionId) -> bool {
        if !self.ids.insert(session_id.clone()) {
            return false;
        }
        self.order.push_back(session_id);
        while self.order.len() > MAX_RECENT_SESSION_IDS {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
