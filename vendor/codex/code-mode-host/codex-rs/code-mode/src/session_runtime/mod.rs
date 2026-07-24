mod types;

use std::collections::HashMap;
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use codex_code_mode_protocol::host::CellLimits;
use serde_json::Value as JsonValue;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

pub(crate) use self::types::CellEvent;
pub(crate) use self::types::CellId;
pub(crate) use self::types::CreateCellRequest;
pub(crate) use self::types::Error;
pub(crate) use self::types::ImageDetail;
pub(crate) use self::types::NestedToolCall;
pub(crate) use self::types::ObserveMode;
pub(crate) use self::types::OutputItem;
pub(crate) use self::types::SessionRuntimeDelegate;
pub(crate) use self::types::ToolDefinition;
pub(crate) use self::types::ToolKind;
pub(crate) use self::types::ToolName;
use crate::TaskFailureHandler;
use crate::cell_actor::CellActor;
use crate::cell_actor::CellError;
use crate::cell_actor::CellEventFuture;
use crate::cell_actor::CellHandle;
use crate::cell_actor::CellHost;
use crate::cell_actor::CellState;
use crate::cell_actor::CellToolCall;
use crate::cell_actor::CompletionCommit;
use crate::runtime::RuntimeLimits;

type RuntimeEventFuture = Pin<Box<dyn Future<Output = Result<CellEvent, Error>> + Send + 'static>>;

/// Owns all cells and shared state for one transport-neutral code-mode session.
pub(crate) struct SessionRuntime<D: SessionRuntimeDelegate> {
    inner: Arc<Inner<D>>,
}

struct Inner<D: SessionRuntimeDelegate> {
    stored_values: Mutex<StoredValues>,
    cells: Mutex<HashMap<CellId, CellHandle>>,
    reserved_cells: Mutex<HashSet<CellId>>,
    cell_tasks: TaskTracker,
    shutdown_token: CancellationToken,
    delegate: Arc<D>,
    task_failure_handler: Option<TaskFailureHandler>,
    next_cell_id: AtomicU64,
    max_committed_state_bytes: Option<usize>,
    max_pending_delegate_calls: Option<usize>,
}

#[derive(Default)]
struct StoredValues {
    values: HashMap<String, JsonValue>,
    bytes: usize,
}

impl<D: SessionRuntimeDelegate> SessionRuntime<D> {
    pub(crate) fn new(delegate: Arc<D>) -> Self {
        Self::new_with_limits(
            delegate, /*task_failure_handler*/ None, /*max_committed_state_bytes*/ None,
            /*max_pending_delegate_calls*/ None,
        )
    }

    pub(crate) fn new_with_task_failure_handler(
        delegate: Arc<D>,
        task_failure_handler: Option<TaskFailureHandler>,
    ) -> Self {
        Self::new_with_limits(
            delegate,
            task_failure_handler,
            /*max_committed_state_bytes*/ None,
            /*max_pending_delegate_calls*/ None,
        )
    }

    pub(crate) fn new_with_limits(
        delegate: Arc<D>,
        task_failure_handler: Option<TaskFailureHandler>,
        max_committed_state_bytes: Option<usize>,
        max_pending_delegate_calls: Option<usize>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                stored_values: Mutex::new(StoredValues::default()),
                cells: Mutex::new(HashMap::new()),
                reserved_cells: Mutex::new(HashSet::new()),
                cell_tasks: TaskTracker::new(),
                shutdown_token: CancellationToken::new(),
                delegate,
                task_failure_handler,
                next_cell_id: AtomicU64::new(1),
                max_committed_state_bytes,
                max_pending_delegate_calls,
            }),
        }
    }

    pub(crate) async fn execute(
        &self,
        request: CreateCellRequest,
        initial_observe_mode: ObserveMode,
    ) -> Result<StartedCell, Error> {
        self.execute_with_limits(request, initial_observe_mode, /*limits*/ None)
            .await
    }

    pub(crate) async fn execute_with_limits(
        &self,
        request: CreateCellRequest,
        initial_observe_mode: ObserveMode,
        limits: Option<CellLimits>,
    ) -> Result<StartedCell, Error> {
        let cell_id = self.reserve_cell().await?;
        self.start_reserved_cell(cell_id, request, initial_observe_mode, limits)
            .await
    }

    pub(crate) async fn reserve_cell(&self) -> Result<CellId, Error> {
        if self.inner.shutdown_token.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        let cell_id = self.allocate_cell_id()?;
        let mut reserved_cells = self.inner.reserved_cells.lock().await;
        if self.inner.shutdown_token.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        reserved_cells.insert(cell_id.clone());
        Ok(cell_id)
    }

    pub(crate) async fn release_reserved_cell(&self, cell_id: &CellId) {
        self.inner.reserved_cells.lock().await.remove(cell_id);
    }

    pub(crate) async fn start_reserved_cell(
        &self,
        cell_id: CellId,
        request: CreateCellRequest,
        initial_observe_mode: ObserveMode,
        limits: Option<CellLimits>,
    ) -> Result<StartedCell, Error> {
        if !self.inner.reserved_cells.lock().await.remove(&cell_id) {
            return Err(Error::MissingCell(cell_id));
        }
        let initial_event = self
            .start_cell(cell_id.clone(), request, initial_observe_mode, limits)
            .await?;
        Ok(StartedCell {
            cell_id,
            initial_event,
        })
    }

    pub(crate) async fn observe(
        &self,
        cell_id: &CellId,
        mode: ObserveMode,
    ) -> Result<CellEvent, Error> {
        self.begin_observe(cell_id, mode).await?.event().await
    }

    pub(crate) async fn begin_observe(
        &self,
        cell_id: &CellId,
        mode: ObserveMode,
    ) -> Result<PendingEvent, Error> {
        let handle = self
            .inner
            .cells
            .lock()
            .await
            .get(cell_id)
            .cloned()
            .ok_or_else(|| Error::MissingCell(cell_id.clone()))?;
        Ok(PendingEvent {
            event: map_actor_event(cell_id.clone(), handle.observe(mode)),
        })
    }

    pub(crate) async fn begin_terminate(&self, cell_id: &CellId) -> Result<PendingEvent, Error> {
        let handle = self
            .inner
            .cells
            .lock()
            .await
            .get(cell_id)
            .cloned()
            .ok_or_else(|| Error::MissingCell(cell_id.clone()))?;
        Ok(PendingEvent {
            event: map_actor_event(cell_id.clone(), handle.terminate()),
        })
    }

    pub(crate) async fn shutdown(&self) -> Result<(), Error> {
        self.begin_shutdown();
        // Taking the registry lock ensures every cell that passed the shutdown
        // check has registered its actor with the tracker before we wait.
        let cells = self.inner.cells.lock().await;
        self.inner.cell_tasks.close();
        drop(cells);
        self.inner.cell_tasks.wait().await;
        Ok(())
    }

    fn allocate_cell_id(&self) -> Result<CellId, Error> {
        self.inner
            .next_cell_id
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |next_cell_id| {
                next_cell_id.checked_add(1)
            })
            .map(|cell_id| CellId::new(cell_id.to_string()))
            .map_err(|_| Error::CellIdSpaceExhausted)
    }

    async fn start_cell(
        &self,
        cell_id: CellId,
        request: CreateCellRequest,
        initial_observe_mode: ObserveMode,
        limits: Option<CellLimits>,
    ) -> Result<RuntimeEventFuture, Error> {
        let stored_values = self.inner.stored_values.lock().await.values.clone();
        let host = Arc::new(RuntimeCellHost {
            cell_id: cell_id.clone(),
            inner: Arc::clone(&self.inner),
        });
        let mut cells = self.inner.cells.lock().await;
        if self.inner.shutdown_token.is_cancelled() {
            return Err(Error::ShuttingDown);
        }
        if cells.contains_key(&cell_id) {
            return Err(Error::DuplicateCell(cell_id));
        }
        let cell_state = Arc::new(CellState::new(self.inner.shutdown_token.child_token()));
        let (handle, initial_event, task) = CellActor::prepare(
            request,
            stored_values,
            host,
            initial_observe_mode,
            cell_state,
            self.inner.task_failure_handler.clone(),
            RuntimeLimits {
                cell: limits,
                committed_state_bytes: self.inner.max_committed_state_bytes,
                pending_delegate_calls: self.inner.max_pending_delegate_calls,
            },
        )
        .map_err(Error::Runtime)?;
        cells.insert(cell_id.clone(), handle);
        let task = self.inner.cell_tasks.spawn(task);
        if let Some(task_failure_handler) = self.inner.task_failure_handler.clone() {
            let failed_cell_id = cell_id.clone();
            let _failure_watcher = self.inner.cell_tasks.spawn(async move {
                if let Err(err) = task.await {
                    task_failure_handler(format!(
                        "code-mode cell {failed_cell_id} task failed: {err}"
                    ));
                }
            });
        }
        drop(cells);
        Ok(map_actor_event(cell_id, initial_event))
    }

    fn begin_shutdown(&self) {
        self.inner.shutdown_token.cancel();
        self.inner.cell_tasks.close();
    }
}

impl<D: SessionRuntimeDelegate> Drop for SessionRuntime<D> {
    fn drop(&mut self) {
        self.begin_shutdown();
    }
}

/// A cell admitted by [`SessionRuntime::execute`].
pub(crate) struct StartedCell {
    pub(crate) cell_id: CellId,
    initial_event: RuntimeEventFuture,
}

impl StartedCell {
    pub(crate) async fn initial_event(self) -> Result<CellEvent, Error> {
        self.initial_event.await
    }
}

/// An admitted observation that has not reached its requested frontier yet.
pub(crate) struct PendingEvent {
    event: RuntimeEventFuture,
}

impl PendingEvent {
    pub(crate) async fn event(self) -> Result<CellEvent, Error> {
        self.event.await
    }
}

struct RuntimeCellHost<D: SessionRuntimeDelegate> {
    cell_id: CellId,
    inner: Arc<Inner<D>>,
}

impl<D: SessionRuntimeDelegate> CellHost for RuntimeCellHost<D> {
    async fn invoke_tool(
        &self,
        invocation: CellToolCall,
        cancellation_token: CancellationToken,
    ) -> Result<JsonValue, String> {
        self.inner
            .delegate
            .invoke_tool(
                NestedToolCall {
                    cell_id: self.cell_id.clone(),
                    runtime_tool_call_id: invocation.id,
                    tool_name: invocation.name,
                    tool_kind: invocation.kind,
                    input: invocation.input,
                },
                cancellation_token,
            )
            .await
    }

    async fn notify(
        &self,
        call_id: String,
        text: String,
        cancellation_token: CancellationToken,
    ) -> Result<(), String> {
        self.inner
            .delegate
            .notify(call_id, self.cell_id.clone(), text, cancellation_token)
            .await
    }

    async fn commit_completion(
        &self,
        stored_value_writes: HashMap<String, JsonValue>,
        mut event: CellEvent,
        pending_initial_yield_items: Option<Vec<OutputItem>>,
        cell_state: Arc<CellState>,
    ) -> CompletionCommit {
        let cancellation_token = cell_state.cancellation_token();
        let mut stored_values = tokio::select! {
            biased;
            _ = cancellation_token.cancelled() => {
                return CompletionCommit::Rejected(event);
            }
            stored_values = self.inner.stored_values.lock() => stored_values,
        };
        let observed =
            stored_value_writes
                .iter()
                .fold(stored_values.bytes, |bytes, (key, value)| {
                    let old_size = stored_values
                        .values
                        .get(key)
                        .map_or(0, |value| entry_size(key, value));
                    bytes
                        .saturating_sub(old_size)
                        .saturating_add(entry_size(key, value))
                });
        let commit_writes = match self.inner.max_committed_state_bytes {
            Some(limit) if observed > limit => {
                if let CellEvent::Completed { error_text, .. } = &mut event {
                    *error_text = Some(format!(
                        "resource limit exceeded: code=resource_exhausted resource=committed_state_bytes limit={limit} observed={observed}"
                    ));
                }
                false
            }
            _ => true,
        };
        cell_state.commit_completion(event, pending_initial_yield_items, || {
            if commit_writes {
                stored_values.values.extend(stored_value_writes);
                stored_values.bytes = observed;
            }
        })
    }

    async fn closed(&self) {
        self.inner.cells.lock().await.remove(&self.cell_id);
        self.inner.delegate.cell_closed(&self.cell_id);
    }
}

fn entry_size(key: &str, value: &JsonValue) -> usize {
    key.len().saturating_add(json_size(value))
}

struct CountingWriter(usize);

impl std::io::Write for CountingWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(buffer.len());
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn json_size(value: &JsonValue) -> usize {
    let mut writer = CountingWriter(0);
    serde_json::to_writer(&mut writer, value).map_or(usize::MAX, |()| writer.0)
}

fn map_actor_event(cell_id: CellId, event: CellEventFuture) -> RuntimeEventFuture {
    Box::pin(async move { event.await.map_err(|error| actor_error(&cell_id, error)) })
}

fn actor_error(cell_id: &CellId, error: CellError) -> Error {
    match error {
        CellError::Busy => Error::BusyObserver(cell_id.clone()),
        CellError::AlreadyTerminating => Error::AlreadyTerminating(cell_id.clone()),
        CellError::Closed => Error::ClosedCell(cell_id.clone()),
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
