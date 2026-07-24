# Pi code-mode architecture

Status: runtime and package-owned source installer implemented and locally validated on Apple arm64; live paid GPT-5.6 gate remains unrun

Target: published `@earendil-works/pi-coding-agent` 0.81.1  
Package: `pi-code-mode`

## 1. Goal and acceptance boundary

`pi-code-mode` is a standalone Pi extension. Its enabled tool policy implements Codex
`CodeModeOnly`, not mixed `CodeMode`: Pi-callable model tools are reduced to `exec`, `wait`, and
package-owned `request_user_input`.
JavaScript cells can call a bounded set of nested Pi tools without writing those nested calls or
results into Pi transcript. Native provider payload may additionally contain the separately
bounded provider-hosted `web_search` tool; it never becomes a Pi tool call.

Expected provider behavior:

- Only models with API `openai-codex-responses`, provider `openai-codex`, and ID prefix `gpt-5.6`
  activate CodeModeOnly and native freeform `exec`.
- Unsupported models keep exact normal Pi active tools and provider while enabled preference
  remains set.

Extension is off by default. Import and extension load register only `/code-mode`,
`/code-mode-host-install`, and `/code-mode-status`. Disabled load must not register tools, replace
providers, start a host, touch filesystem or network, create a timer, or install an exit hook.

This design depends only on published Pi APIs and package-owned code. It does not import protected
Pi or Codex checkout internals. Protected repositories are source inputs during the relocation and
verification process, never runtime dependencies.

Implementation is accepted only after all gates in section 13 pass. A missing or red gate is
reported as such; it is not converted into a claim.

## 2. Public Pi API boundary

Extension uses these public capabilities:

- `registerCommand` for `/code-mode`, `/code-mode-host-install`, and `/code-mode-status`;
- lazy `registerTool` for `exec`, `wait`, and `request_user_input`;
- `getAllTools`, `getActiveTools`, and `setActiveTools` for conflict detection and activation;
- public coding-tool factories for default nested tools;
- `registerProvider` and `unregisterProvider` for an owned provider overlay;
- current model and `model_select` for transactional activation or normal fallback;
- `session_shutdown` for reload, session switch, and process-shutdown cleanup;
- tool execution context for cancellation, current working directory, and UI reporting.

Public Pi does not expose executable definitions for arbitrary active tools. It also does not let
one extension replay another extension's private `tool_call` or `tool_result` handlers. Unlike
Codex, Pi 0.81.1 also exposes no `DirectModelOnly` classification or generic
`request_user_input` tool. Therefore this package explicitly owns a bounded implementation:

- default nested tools are package-created `read`, `bash`, `edit`, `write`, `grep`, `find`, and
  `ls`;
- SDK/package authors may add complete definitions with
  `createCodeModeExtension({ nestedTools })`;
- nested definitions are copied into an immutable snapshot for each cell;
- third-party registered tools are never discovered, claimed, or invoked by name;
- public `select` and `input` dialogs implement the direct question tool without private APIs;
- extension-owned optional before/after callbacks are the only nested hooks;
- README and API docs must state this boundary.

Every provider tool call presented to Pi remains a standard
`ToolCall.arguments = { code: rawInput }`. Native freeform data is normalized at package-owned
provider boundary. No protected Pi freeform field is required.

## 3. Components and ownership

```text
Pi extension
  ├─ command/controller       enable, disable, status, lifecycle transaction
  ├─ direct Pi tools          exec, wait, request_user_input while active
  ├─ nested-tool adapter      validation, callbacks, cancellation, result conversion
  ├─ fair scheduler           shared parallel batches, exclusive sequential batches
  ├─ cell manager             cell IDs, yield/resume/terminate, limits, cleanup
  ├─ host client              framed local protocol and generation ownership
  ├─ host provisioner         path/hash/size/platform/architecture validation
  └─ provider bridge
       ├─ native overlay      exact OpenAI Codex Responses GPT-5.6 eligibility only
       └─ normal fallback     every unsupported model/provider

local stdio protocol
  └─ operator-built package-owned codex-code-mode-host
       └─ V8 isolate per bounded session/cell lifecycle
```

Controller is sole owner of active-tool replacement, overlay transaction, host generation, and
live cells. One serialized lifecycle mutex prevents overlapping toggle/model/shutdown changes.
Cell operations have separate bounded scheduling and cannot mutate controller ownership.

No component starts work at module scope. Heavy state is created when `/code-mode` first toggles
on; host process is created on first cell, after provision validation.

Current source map:

| Area | Package source |
|---|---|
| dependency-free constants and public structural types | `src/constants.ts`, `src/public-types.ts` |
| inert command/listener facade and serialized lazy loader | `src/index.ts` |
| activated extension lifecycle and provider transaction entry | `src/runtime/extension.ts` |
| native ownership snapshot/install/guarded restore | `src/native/overlay.ts` |
| freeform grammar and replay/output rewrite | `src/native/contract.ts` |
| bounded Codex SSE request and strict event normalization | `src/native/stream.ts` |
| cells, nested tools, scheduler, host protocol | `src/runtime/*` |

## 4. Extension and provider flow

### 4.1 Load while off

1. Store factory options by reference and construct only a small lifecycle mutex and command closure.
2. Register `/code-mode` and `/code-mode-status`.
3. Register lifecycle handlers that do nothing unless controller owns live state.
4. Load only `index` and dependency-free `constants`. Do no UUID, schema, tool snapshot, host,
   filesystem, network, timer, provider, tool, or heavy module-graph work.

`/code-mode-status` is read-only. It reports off/on, claimed-name state, active provider path,
host configuration presence, live/yielded cells, and any unresolved provider collision. It does
not validate or start host. Before first enabling toggle, status, `model_select`, and
`session_shutdown` do not import activated runtime.

### 4.2 Enable transaction

`/code-mode` toggles only when Pi reports agent idle and no lifecycle operation is running. It
enables while off and disables while on.

First enabling toggle imports `src/runtime/extension.ts` inside same serialized lifecycle queue,
then creates UUID ownership marker, schemas, explicit-tool snapshot, and activated runtime.
Concurrent toggle/model/shutdown requests cannot observe or publish half-created engine. A failed module
load keeps facade off and unclaimed with bounded status error. Validation or enable failures after
successful load follow normal transaction and claim rules below.

Unsupported enable stops before preflight: it records enabled preference but performs no host
resolution, validation, name claim, active-tool change, or provider inspection. Supported
preflight, before any package-owned mutation:

1. Read `getAllTools()` and reject if `exec`, `wait`, or `request_user_input` exists and package
   has not claimed it in this extension instance.
2. Snapshot ordered active tool names.
3. Build immutable nested-tool registry from package defaults plus explicit definitions. Reject
   duplicate/reserved names, malformed schemas, or definitions outside configured limits.
4. Resolve five host facts from factory options or explicit environment variables and validate
   local file metadata as defined in section 9. No process starts.
5. Inspect current supported model/provider and read both public registry
   getters, `getRegisteredProviderConfig(providerId)` and
   `getRegisteredNativeProvider(providerId)`, and create the discriminated snapshot defined in
   section 8. A prior native registration is rejected before mutation. For an allowed
   `none`/`config` snapshot, compute the package-owned native overlay.

Commit:

1. On first enable in this extension instance, lazily register retained package tool definitions.
   Each retained definition and parameter schema carries a per-instance package marker. Reread
   `getAllTools()` and require all three direct tools to resolve to package source metadata and
   exact retained schema markers. They remain package-owned until reload because Pi cannot
   unregister tools.
2. Install native provider overlay.
3. Call `setActiveTools(["exec", "wait", "request_user_input"])`, then require the exact ordered
   result.
4. Publish active state only after every verification succeeds.

Any commit failure closes cells/host generation if created, restores still-available prior active
tools in original order, and performs guarded provider restoration. Mode remains disabled. If
tool registration occurred, status reports direct names as claimed until reload even when marker
or active-set verification failed. Tool names already registered cannot be released before reload.
Preflight is arranged so all expected failures occur before lazy name claim.

### 4.3 Model request

Active native path:

```text
model -> OpenAI custom exec raw input
      -> package provider bridge maps to Pi exec({ code: rawInput })
      -> cell manager
```

Native bridge preserves raw JavaScript across outgoing custom-tool declaration, streamed input
deltas, completed calls, replayed assistant messages, and paired custom-tool output. IDs are
validated for uniqueness and correct output pairing. Malformed or incomplete streams fail
explicitly.

### 4.4 Disable and lifecycle teardown

A disabling `/code-mode` toggle, supported-to-unsupported `model_select`,
`session_shutdown`, and package shutdown all use one idempotent active teardown:

1. Stop accepting new `exec`, `wait`, `request_user_input`, and nested calls.
2. Abort active cells and reject pending waiters with a specific disabled/cancelled result.
3. Request bounded session shutdown, then terminate owned host generation if needed.
4. Restore ordered prior active tool names, filtered only for names no longer present in
   `getAllTools()`.
5. Restore provider through ownership check in section 8.
6. Clear per-enable snapshots and report collision state.

Model change preserves enabled preference. Supported-to-unsupported restores normal tools and
provider; unsupported-to-supported snapshots current normal tools and activates automatically.
No cell or nested-tool snapshot crosses an active/fallback boundary.

After first supported activation, registered direct names remain in `getAllTools()` but inactive
while off or in normal fallback. A foreign extension cannot acquire those names until reload.
Before first supported activation, this package owns none. Status distinguishes off, enabled
normal fallback, and enabled active.

## 5. Cell and tool flow

`exec` accepts JavaScript source. Provider bridge supplies raw source and Pi tool boundary
validates exactly one `code` string. It starts a bounded cell or resumes the protocol operation associated with that
outer call. Result is one of:

- completed output;
- yielded state with opaque cell ID and instructions to call `wait`;
- explicit validation, cancellation, limit, host, or nested-tool error.

`wait` accepts yielded cell ID and optional termination request. It observes until completion or
next yield, or terminates that cell. It cannot access a cell from another session/host generation.
Client admission reserves a cell slot before host preparation, nested-tool snapshotting, or frame
construction. `cells + startingCells` never exceeds `maxActiveCells`; excess `exec` calls reject
immediately without a queue. A reservation transfers to the cell map when host reports its cell ID
and releases on every earlier failure. Only one `wait` or terminate operation may be active for a
cell, while `wait` remains outside start admission.

`request_user_input` accepts 1-3 questions, each with 2-3 bounded choices. Public Pi `select` adds
`Other`, and public `input` collects its bounded free-form value. Optional 60-240 second
`autoResolutionMs` applies one shared deadline. Abort propagates through both dialogs. Result text
is the upstream-compatible `{ "answers": { "<id>": { "answers": [...] } } }` JSON shape; an
unanswered timeout or dialog dismissal leaves bounded empty answer arrays.

Inside JavaScript, `tools.<name>(input)` sends a nested request over local protocol:

1. Host validates protocol envelope and bounded IDs.
2. Adapter finds name in cell's immutable registry; unknown names fail.
3. Tool `prepareArguments(raw)` converts raw protocol input into runtime arguments.
4. Adapter validates prepared arguments against tool schema.
5. Optional package-owned before callback may reject or return replacement arguments.
6. Adapter revalidates callback replacement arguments against the same schema.
7. Fair scheduler grants permit: sequential batch is exclusive; explicitly parallel batch uses
   shared permits.
8. Tool executes with cell cancellation signal and captured Pi execution context.
9. Adapter validates runtime result.
10. Optional package-owned after callback may reject or return a replacement result.
11. Adapter revalidates callback replacement result.
12. Output codec applies byte/item/depth limits and returns one bounded protocol result.

A prepare, schema, callback, execution, result-validation, or encoding failure becomes a bounded
error in the outer `exec`/`wait` result. Callback failures stay package-local: they emit no nested
Pi event or transcript entry.

Scheduler is FIFO-fair across queued shared and exclusive groups. New shared work cannot bypass a
waiting exclusive group. Outer `exec` and `wait` bypass nested permits, preventing a yielded cell
from deadlocking its own observer.

All configured limits have finite defaults and checked hard maxima: source/input bytes, protocol
frame bytes, output bytes, structural depth/items, tool calls per cell, concurrent calls, cells,
wall time, idle/yield time, and shutdown grace. Invalid config fails enable preflight. Exact
defaults and maxima become public API constants and must be covered by deterministic probes before
release.

## 6. Transcript behavior

Pi transcript contains only outer model interactions:

```text
assistant tool call: exec, wait, or request_user_input
tool result:          matching direct tool result
```

Nested call arguments, progress, and results travel only between cell manager, adapter, and local
host. They are not emitted as Pi assistant tool calls, Pi tool-result messages, or session entries.
Package-owned callbacks are local callbacks, not Pi extension events.

Nested failures are summarized in outer result with bounded structured details. No nested result
is silently dropped, promoted to transcript, or disguised as success. Provider replay converts
stored standard Pi `exec({ code })` calls back to native custom calls only inside owned overlay,
and maintains one output for each call ID.

## 7. Cancellation, cleanup, and resource rules

Cancellation sources are combined: Pi tool signal, explicit `wait` termination, mode disable,
model/session change, configured deadline, host exit, and protocol failure. First cancellation
closes admission, propagates to nested tools, and settles every pending promise exactly once.
Every accepted delegate promise remains controller-owned until settlement. Shutdown aborts first,
then drains outer operations and delegates under one `CONTROLLER_DELEGATE_DRAIN_MS` deadline before
cell/session cleanup. A timeout is reported as cleanup failure; cancellation cannot stop arbitrary
custom-tool side effects that ignore their `AbortSignal`.

Each enable owns a monotonically unique host generation. Cells and messages carry generation and
session IDs. Late output from an old generation is rejected. Crash handling:

- fail affected active/yielded cells with explicit host-exit error;
- cancel pending nested calls;
- close pipes and waiters;
- immediately invalidate controller session/cells and release generation once; host-loss cleanup
  has a six-second deadline;
- do not silently restart or replay code;
- allow a later explicit `exec` to create a fresh validated generation while still enabled.

Disable/shutdown uses a bounded graceful request followed by process termination. Stream listeners,
abort listeners, timers created for active operations, file descriptors, cells, and callback maps
are removed on every terminal path. There are no permanent process exit hooks.

## 8. Provider bridge and transactional ownership

Native overlay is adapted from `@howaboua/pi-codex-conversion` but is package-owned. It applies
only when current model API is exactly `openai-codex-responses`, provider is exactly
`openai-codex`, and model ID starts with `gpt-5.6`. Every unsupported model/provider remains
untouched with its normal Pi tool surface.

Before overlay:

- call both `getRegisteredProviderConfig(providerId)` and
  `getRegisteredNativeProvider(providerId)`;
- classify prior registration as exactly one of:
  - `{ kind: "none" }` when both getters return `undefined`;
  - `{ kind: "config", value }` when only config getter returns a value;
  - `{ kind: "native", value }` when native getter returns a value;
- reject `native` before any tool, active-set, or provider mutation. This package does not compose
  over or replace a prior native provider registration;
- reject inconsistent state where both getters return values;
- for `none` or `config`, create one package-owned native overlay from effective provider, changing
  only required stream behavior, and retain exact overlay object identity, stream function
  identity, and expected structural/value snapshot of every non-stream field.

While enabled, package does not assume continued ownership. At restore, reread current
registration through both getters. Restore is allowed only when all ownership checks pass:

- native getter returns exact package-owned overlay object by reference identity;
- current overlay stream function is exact retained function by reference identity;
- config getter is absent;
- every current non-stream field matches expected structural/value snapshot.

Each overlay transaction owns an abort controller used by every native request, combined with Pi's
request signal. Restore aborts before provider ownership restoration and drains tracked relay tasks
for at most `NATIVE_OVERLAY_DRAIN_MS`. A stalled relay reports bounded cleanup failure while
provider restoration still follows ownership checks.

For prior `config`, call `registerProvider(providerId, capturedConfig)` with exact captured config.
For prior `none`, call `unregisterProvider(providerId)` and verify both getters are absent. Prior
`native` never reaches commit. If any ownership or post-restore verification differs, another
actor changed provider. Package leaves current provider untouched, disables cells and tool
surface, records collision, and reports it. It never unregisters or overwrites foreign provider
state to force cleanup.

Provider overlay is absent while off or in unsupported normal fallback. Unsupported transitions
do not enter package provider request construction or network access.

Native request transport matches published Pi 0.81.1 Codex SSE contract. It normalizes provider
base URL to `/codex/responses`, defaulting to `https://chatgpt.com/backend-api`; requires bearer
OAuth JWT; extracts `chatgpt_account_id` from claim `https://api.openai.com/auth`; and forces
`chatgpt-account-id`, `originator: pi`, `OpenAI-Beta: responses=experimental`, SSE accept, JSON
content type, Pi user agent, and paired session/request IDs when session ID exists. User headers
cannot replace required authentication or protocol headers. `onPayload` replacement is rerun
through complete native call/output contract before bounded JSON encoding. `onResponse` receives
every HTTP response with bounded headers. Cancellation, timeout, retry count, retry-after cap, and
provider errors have explicit bounds.

Transport intentionally implements SSE only. Published WebSocket and zstd alternatives add
state, dependencies, and decompression risk without a code-mode correctness need. This deviation
is reviewed and public. SSE parser accepts explicit standard SSE fields and a fixed Responses event
allowlist. Unknown fields, event types, output types, reused indices, duplicate or oversized IDs,
missing/wrong/duplicate call outputs, deltas after done, inconsistent completion bytes, wrong
statuses, response ID changes, and events after terminal all fail. Explicit incomplete
tool calls and unsupported incomplete states fail; incomplete message and reasoning states follow
the lifecycle matrix below. Hot deltas use
bounded chunk arrays joined once at completion.

Output-item lifecycle status is type-specific. Custom `exec` requires status absent on added and
done. Function calls allow absent/`in_progress` on add and absent/`completed` on done; explicit
incomplete functions reject. Messages require `in_progress` on add and allow
`completed`/`incomplete` on done. Reasoning allows absent/`in_progress` on add and
absent/`completed`/`incomplete` on done. Hosted web search retains required `in_progress` then
`completed`. Function-arguments done repeats original function name. An explicitly incomplete item
requires an incomplete terminal response.

Streamed text and reasoning lifecycle is per content part, not per output item. Message
`output_text` and `refusal` parts are keyed by `content_index`; reasoning summary parts by
`summary_index`; raw reasoning parts by `content_index`. Optional part-added, value-done, and
part-done markers are independent and validate exact item, index, family, and accumulated payload
when present; part-done does not require an earlier part-added marker.
Duplicate markers, part-added after any delta or value marker (including empty payloads), a delta
after its matching part is done, skipped/reopened indices, and item completion with inconsistent
aggregate bytes fail. Starting next monotonically increasing index seals prior part even when
optional done markers are absent; later events for sealed indices fail.
A later distinct part may use another family. Message parts concatenate exactly. Reasoning summary
and raw-content parts preserve Pi's two-newline part separator without a trailing separator.
Custom and function input-done values may authoritatively extend their streamed prefix when delta
events were omitted; missing bounded suffix bytes emit as a final tool-call delta. Non-prefix
completion values fail. Their output-item-done values apply the same rule and can finalize calls
when optional input-done or arguments-done markers are absent.

Published Pi 0.81.1 fixtures can emit `response.output_item.done` without
`response.output_text.done` or `response.content_part.done`, so those markers remain optional.
Completed reasoning accepts validated summary-text parts or reasoning-text content parts, in that
order of preference, then streamed content. Terminal reasoning output may backfill only missing
`encrypted_content` for an already observed exact reasoning item ID, and duplicate terminal
reasoning IDs fail even when their payloads are identical.

Terminal aliases are equivalent only after validating response body status: `completed` and
`incomplete` are accepted, including `response.done` carrying `incomplete`; failed, cancelled,
unknown, duplicate, regressive queued, and post-terminal events fail. Queued may repeat only before
the first in-progress phase; once in-progress is observed, later queued events fail even before
output begins.

Replay first uses Pi's published model-aware message transform. Cross-model signed/redacted
thinking and provider signatures are removed or converted using Pi rules; paired tool call/result
identity is normalized; same provider/API replay to another model omits provider item IDs. Text
IDs over 64 characters are deterministically hashed, and only `commentary` or `final_answer`
phases survive; empty signed text IDs use generated fallback IDs. A remaining same-model reasoning
signature must be valid bounded JSON object; malformed JSON and non-object values fail.
Vision-capable models retain tool-result images as `input_image` parts alongside text; other image
paths use Pi placeholders.

Pi stores provider tool identity as `callId|itemId`; `|` is therefore reserved and rejected in
either provider wire ID, and replay rejects any stored identity with more than one delimiter
instead of truncating it. Native payload validation requires exactly one custom `exec` grammar,
one function `wait`, and one function `request_user_input` as Pi-callable tools. A post-build
payload hook may add at most one exact
provider-hosted `web_search` entry with boolean `external_web_access`; duplicates, extra fields,
names, and every other hosted tool fail. Replayed exec arguments contain exactly `code`. Each
tool output must occur after its matching call in transcript order; parallel calls may be
followed by their outputs in any order. Provider output accepts custom calls only for `exec` and
function calls only for `wait` and `request_user_input`.

Hosted `web_search_call` items consume the same output-index and item-ID budgets but never create
Pi tool calls or pending results. Optional progress events must advance without duplicates or
regression, and item completion is mandatory before terminal response. URL-citation annotation
events must target a live matching `output_text` part and use contiguous annotation indexes.
Their exact URL citation shape is validated, then omitted because Pi text content has no
annotation field. Other hosted items, annotations, and events remain unsupported.

During streaming, Pi delta events carry exact new bytes, while mutable partial message blocks may
remain stale until matching done/item completion. This is deliberate: rebuilding accumulated
strings on every delta is quadratic. Final blocks and emitted end events contain exact joined
content. Consumers that need live text must consume delta events.

Retry behavior follows published Pi Codex SSE rules: `retry-after-ms` takes precedence over
`retry-after`; 429 delays are capped by `maxRetryDelayMs`; quota, balance, budget, and billing 429
responses are terminal; transient HTTP and network failures remain retryable within hard retry
count. Pending SSE reads are raced against one abort promise. Abort cancels reader with exact
reason, settles pending read, removes listener, and releases reader lock.

Public native hard maxima are: 100,000 events; 4,096 output items; 8,000 IDs; 1,024 bytes per ID;
4 MiB per line/event/item buffer; 16 MiB raw stream, accumulated content, and request; 16 KiB JWT
and provider error; 256 headers and 64 KiB header bytes; 8 retries. These are exported from
`src/constants.ts`, exposed publicly by `src/index.ts`, and max-plus-one probed outside committed
source.

## 9. Host trust, provisioning, and protocol

Host is package-built and local-only. Package owns standalone Rust workspace at
`vendor/codex/code-mode-host/codex-rs/`; it ships no executable, downloader, or default URL.
`/code-mode-host-install` validates every vendored file against pinned provenance, runs locked
release Cargo build without shell, probes exact protocol/resource contract, publishes executable
into immutable content-hash directory, and atomically replaces strict `current.json`. Cargo/rustc
and artifacts required by locked registry and V8 dependency graph are build prerequisites.
Network or populated Cargo caches may be required; offline builds are not claimed.

Runtime identity precedence is complete factory options, complete five-variable environment, then
strict installed manifest:

- `PI_CODE_MODE_HOST_PATH`
- `PI_CODE_MODE_HOST_SHA256`
- `PI_CODE_MODE_HOST_SIZE`
- `PI_CODE_MODE_HOST_PLATFORM`
- `PI_CODE_MODE_HOST_ARCH`

One explicit source supplies all five values; partial factory options or partial environment
configuration fail without installed fallback. Installed manifest must have exact schema fields,
package/source/probe identity, protocol version, sole `resource_limits_v1` capability, current
platform/architecture, and canonical content-derived executable path. All paths must be absolute,
canonical, regular, local file paths. URL, PATH lookup, shell command, symlink final target,
directory, device, socket, and FIFO are rejected.

Before each spawn, provisioner opens source file once without executing it and validates:

- expected platform and architecture equal current runtime;
- positive decimal size equals opened source handle size;
- source handle is a regular file.

Provisioner then creates a package-owned temporary directory with mode `0700`, exclusively creates
a private non-executable file in it, and copies bytes only from the already validated open source
handle. It hashes copied bytes and requires copied size and lowercase SHA-256 to equal configured
values, calls file `fsync`, changes private copy to mode `0700`, and syncs directory metadata where
runtime supports it. Any mismatch or I/O failure closes handles and removes private directory.

Spawn uses only exact private-copy path and argument vector, never source path or shell. Source
handle is closed after copy. Private copy and directory are removed after host exit and on every
startup, enable, disable, or shutdown failure; cleanup never follows user-controlled children or
symlinks. Environment is explicit and minimal: POSIX gets only `PATH=/usr/bin:/bin`, runtime
`TMPDIR`, and `LANG=C.UTF-8`; Windows gets only `SystemRoot` (parent value or `C:\Windows`),
`PATH=<SystemRoot>\System32`, and runtime `TEMP`/`TMP`. Credentials, tokens, proxies, and every
other parent variable are excluded. Protocol uses bounded framed messages over stdio,
strict request/response IDs, method allowlist, maximum frame size, finite pending-request count,
and explicit malformed-frame failure. Stderr is separately bounded and used only for diagnostics.

V8 isolate limits, deadlines, and process boundaries reduce accidental damage. They are not a
security sandbox: nested tools intentionally retain their granted filesystem and shell authority.
Users must not run untrusted JavaScript or untrusted host binaries.

Package-owned host source:

- copied from patched Codex checkout commit:
  `808d3c2702ce8eae007c457aa930e7c3b68dd5f6`
- patch baseline commit: `b5748e6e3cbc3c9831f84aa016486721b4923d1c`
- scoped patch SHA-256:
  `61f8a64ab08a302f7321ac4f1210c4ee1ff3abf4df3b064a6fb588b431a5b024`
- workspace: `vendor/codex/code-mode-host/codex-rs/Cargo.toml`
- preserved upstream crates and paths:
  `code-mode-host`, `code-mode`, `code-mode-protocol`, and `utils/cargo-bin`
- compatibility boundary: local `codex-protocol` contains only exact upstream `ToolName`, which is
  the sole production API these crates use from broad Codex protocol internals
- build:
  `cargo build --manifest-path vendor/codex/code-mode-host/codex-rs/Cargo.toml --locked --release -p codex-code-mode-host`

All modules, remote-session paths, tests, crate names, and file layout in the three selected source
trees remain byte-identical to patched upstream source. A machine-readable provenance map records
copied and locally authored files. The historical patch remains bootstrap/review evidence; normal
builds do not apply it or require a Codex checkout.

Package tarball must contain standalone source, lockfile, patch, provenance, license, and notice,
never executable host, Cargo target, registry cache, installer staging, or prototype artifact.
Current build, installer, and raw protocol lifecycle evidence is Apple arm64 only.

## 10. Bun and Node runtime paths

Node correctness is baseline. Shared implementation uses standard TypeScript/JavaScript runtime
APIs and Node-compatible process/stream behavior. Bun may select a package-owned fast path only
at runtime and only for an operation covered by identical correctness fixtures.

Initial performance run `/tmp/pi-code-mode-perf-20260723T111204-r1` failed disabled startup:
baseline 406.913 ms versus candidate 526.226 ms, delta +119.313 ms with 95% CI
[115.264, 123.606], and +45.86 MiB RSS. Root cause was static entry imports of Pi tool factories,
TypeBox, controller, protocol, host/process code, plus eager UUID/schema/tool snapshots. Lazy
facade split removes that graph. Independent protocol reruns later in this section decide the gate.

Same run passed retained RSS, FD, and thread checks but reported small positive heap slope. A
temporary 7,030-cell diagnostic build sampled after 30 cells, after 5,000 more, and twenty
100-cell windows. Controller operations/cells/loss cleanup/error collections and abort listeners
were always zero. Host pending/execution/delegate/gap collections were always zero; one session
handler and one stdout/stderr/error/exit listener remained constant. Window heap was U-shaped and
ended 48,624 bytes below first window; OLS slope was +179 bytes per 100 cells.

Independent rerun `/tmp/pi-code-mode-perf-20260723T114300-r2` reported +1,758 bytes heap per
100 cells with 95% CI [+357, +3,155] and +15,559 bytes parent RSS with 95% CI
[+12,190, +18,911]. A controlled diagnostic matrix then isolated benchmark observation from
package work. Two repeats each of pure async work, direct host session with and without one
long-lived abort signal, controller with empty tools, and packed extension with default tools all
had heap-slope confidence intervals containing zero when external process statistics were not
collected. Adding the exact benchmark `statz` observation to pure async work reproduced +2,155
bytes per 100 cells with CI [+1,645, +2,660] and +2,142 with CI [+1,631, +2,648].

Heap snapshots at 5,000 and 7,000 operations found no growth in Promise, Map, Set,
AbortController, or AbortSignal counts. Twenty observation windows added 22 ordinary objects in
the pure control and 41 in the extension control, matching retained sample records: one record
per pure window and one record plus its nested child record per extension window. Both gained 40
heap-number nodes. The benchmark keeps prior records in `windows`, so each following `heapUsed`
sample measures earlier observation records. A disposable one-variable build that flattened the
host write promise chain still measured +1,848 bytes with CI [+383, +3,290] and +1,819 with CI
[+356, +3,272]. RSS slopes varied in sign and size across controls and A/B repeats, without a
consistent package-retention signature.

Evidence is in `/tmp/pi-code-mode-leak-diagnostics`. No package runtime change is justified.
Independent performance acceptance requires a corrected observer that does not retain prior
window records in the measured heap, followed by a fresh gate run. This changes measurement
ownership, not resource thresholds.

Corrected run `/tmp/pi-code-mode-perf-20260723T115000-r3` removed retained observation records.
It still reported +1,594 bytes heap per 100 cells with 95% CI [+176, +2,993], while its trace
dropped and then plateaued. Eight repeated corrected controls did not reproduce growth: direct
host with one immutable seven-tool set, with and without a signal; controller with no tools; and
packed extension with default tools each ran twice, and every heap confidence interval contained
zero. Separate 5,000-cell and 7,000-cell extension processes differed by only 3,096 heap bytes.
Counts were identical for Object, Function, Promise, Map, Set, AbortController, AbortSignal,
Array, ArrayBuffer, Uint8Array, and Buffer. A disposable cwd-keyed default-tool cache also had
both heap intervals contain zero and did not improve on current behavior, so it was rejected.

The r3 child changed from 12 to 13 threads at window eight. Disposable atomic instrumentation
showed 104 of 200 terminal responses arrived before their cell runtime thread exited, but every
runtime exited within the next 1 ms. Later thread-identity sampling disproved the initial V8
explanation. Four fixed V8 workers already existed before the first cell and retained the same
thread IDs. Each persistent increase was a Tokio blocking-pool thread with a stack ending in
`tokio::io::blocking::Buf::read_from` and the host stdin read. Runtime started/exited counters
were equal, runtime and timer in-flight counters were zero, and no other production
`spawn_blocking` or `block_in_place` consumer existed.

The corrected observer still does not isolate parent heap from its own system-statistics work.
Two fresh pure-async processes using the same preallocated numeric buffers and the same per-window
`ps` and `lsof` calls each measured +3,964 bytes per 100 operations with CI
[+2,986, +4,938]. The r3 pure-async control omits those calls and runs after the extension phase
has already exercised Node child-process code. Two final worker-count-four runs through the
unchanged r3 observer likewise reported positive heap intervals despite stable package-only
controls and snapshots. Future acceptance must either warm and control the complete observer or
collect heap in a process that does not run system-statistics commands. It must retain the same
resource thresholds.

Disposable release-host A/B tested explicit worker counts 1, 2, and 4 against default 0 on an
eight-core Apple M2. Count four was the best tested point on that machine: two corrected
7,000-cell runs kept child threads stable, heap confidence intervals contained zero, and child
RSS slopes were +1.71 KiB per 100 cells in both runs versus +3.15 and +2.38 KiB for default.
Repeated p95 latency remained equivalent: empty cell 0.83/0.67 ms versus default 0.78/0.79 ms;
nested no-op 0.96/0.94 ms versus 0.95/0.94 ms; eight parallel 20 ms calls 32.24/31.34 ms versus
33.09/32.50 ms.

Fixed four workers would oversubscribe smaller machines, so it is not the shipped rule. The host
uses `available_parallelism`, clamps the reported value to 1 through 4, and falls back to one
worker when detection fails. Temporary helper tests cover reported values 1, 2, 4, 8, and 64 plus
failure. On the measured M2 this selects four and is behaviorally identical to the tested
fixed-four host.

Heavy validation alternated default and candidate order for 200 measured batches after 30
warmups, retained every raw sample, and used four and eight simultaneous cells across enough
sessions. Workloads compiled 1,200 generated functions, allocated and reduced 16 MiB per cell,
or mixed both. Candidate-minus-default paired mean confidence intervals included zero in all
eight-cell workloads. Four-cell compile and mixed means differed by +0.6% and +2.1%; their narrow
positive intervals are statistically detectable but not materially meaningful. Worst candidate
p95 change was +9.5% for four-cell mixed work; eight-cell compile and mixed p95 improved by 3.9%
and 3.3%. Candidate threads were consistently lower, while RSS varied by workload and run, so
no universal memory or throughput claim is made.

Four final 7,000-cell V8-candidate runs kept child threads constant at nine or ten within each
run. Three child RSS slopes were +2.78 to +2.90 KiB per 100 cells; one run had a single 672 KiB
step and failed the RSS slope gate. Two comparison runs with default workers had low RSS slopes
but one repeated the r3 thread transition. These runs support the CPU-aware V8 cap's lower,
bounded worker count, but do not prove thread-count determinism or deterministic RSS.

The r4 external observer also multiplied slopes by 100 even though each regression x-step was
already one 100-cell window. Corrected units leave both Pi-parent RSS upper confidence bounds
below one 16 KiB page and both heap confidence intervals containing zero. Candidate-one host RSS
still exceeded one page and its host thread count changed from 9 to 10. A fresh observer using
the corrected unit then isolated the host-thread issue.

Tokio's default blocking pool grows on demand and retires idle workers. Direct idle probing
therefore observed 8 threads before a 12-second idle period, 7 after idle retirement, and 9 after
the next request, while input, output, EOF, and cleanup remained correct. This replacement is
bounded behavior, not retained per-cell state, but it violates the acceptance rule requiring
stable sampled thread counts. The host now builds its current-thread Tokio runtime explicitly
with `max_blocking_threads(2)`. Two is the invariant: this host has exactly two known steady
blocking consumers, Tokio stdin and serialized Tokio stdout. Any future `spawn_blocking`,
`block_in_place`, Tokio filesystem or DNS use, extra stdio handle, or other blocking-pool
consumer must revisit this cap and rerun cancellation, backpressure, resource, and throughput
gates.

Two final corrected 7,000-cell cap-two runs kept host threads and FDs constant at 8 and 13 across
all 20 windows. Parent heap confidence intervals were [-1,523, +884] and [-1,539, +909] bytes per
100 cells. Parent RSS upper bounds were 1,917 and 7,836 bytes; host RSS upper bounds were 5,741
and 3,302 bytes, all below one 16 KiB page. Parent retained RSS was 13.36 MiB and 12.69 MiB.
Final heavy compile/allocation A/B retained all 200 alternating samples per workload and found no
material throughput or p95 regression. Exact evidence is under
`/tmp/pi-code-mode-cap2-final-evidence`.

Independent rerun under `/tmp/pi-code-mode-cap2-independent-20260723` installed a fresh packed
artifact and repeated both corrected 7,000-cell trials. Parent heap confidence intervals were
[-1,339, +1,058] and [-1,345, +1,025] bytes per 100 cells. Parent RSS upper bounds were 3,730 and
15,613 bytes; host RSS upper bounds were 5,437 and 5,628 bytes. All remained below one independently
reported 16 KiB page. Parent and host FD/thread counts stayed fixed at 49/21 and 13/8. Retained
parent RSS was 15.05 MiB and 15.02 MiB.

Fresh repaired-package disabled/off-path rerun under
`/tmp/pi-code-mode-disabled-20260723T122500` used a newly built and packed artifact, 30 warmups,
200 alternating pairs, and 10,000 bootstrap resamples. Disabled startup mean delta was +1.761 ms
with 95% CI [-0.161, +4.018] ms against a 396.595 ms baseline; the gate bound was 7.932 ms.
RSS mean delta was +52,920 bytes with 95% CI [-16,896, +120,641], below the 2 MiB gate.
Code-mode-off normal-path mean delta was +0.000317 ms with 95% CI
[-0.000081, +0.001057], which includes zero. Both gates pass. Measured tarball SHA-256 was
`239ee2cbaca4de913bb1dd1f02a00d49521711ed9e2975d9c55d358cb2e8fbaf`; later documentation-only
packing may change archive identity without changing measured JavaScript.

Cancellation evidence is deliberately separate. Under a fixed eight-cell queued-load probe,
the uncapped r4 host timed out 4 of 10 cancellations; cap two and cap three each timed out 1 of
10, with nearly identical medians and maxima. Cap three therefore adds a steady thread without
proven cancellation benefit and is rejected. Cap two also passed a confirmed running-cell
termination under the same active load. The remaining queued timeout is not masked: synchronous
V8 isolate startup waits on `isolate_handle_rx.recv()` on the current Tokio thread, so extreme
startup contention can delay processing a cancellation. Final running-cell evidence first
confirmed both load controllers held four active cells, then confirmed target JavaScript invoked
a nested `started` tool before abort. Termination completed in 1.20 ms, all eight loads and three
closes fulfilled, host stayed at eight threads, and child cleanup was observed. Moving
initialization off the Tokio thread was considered but rejected from this patch because
cancellation-safe ownership and cleanup need a separate design and full review.

Final direct stdio probes accepted 12 MiB input and a 3 MiB encoded output. A separate probe
paused the parent stdout reader for 250 ms; the 3 MiB response remained pending, resumed
successfully, and kept eight host threads. Host exited cleanly on input EOF and surfaced broken
stdout as a nonzero `Broken pipe` failure. A 12-second idle probe observed 8 threads before idle,
7 after worker retirement, and 8 after successful reuse. This documents expected replacement
outside continuous acceptance windows; both 7,000-cell runs remained constant at eight.

The vendor patch therefore selects two independent bounds: a CPU-aware V8 worker cap, not a
universal fixed-four optimum, and a two-worker Tokio blocking pool matching current stdio
consumers. It does not join cell threads, prewarm with fake work, disable JIT, increase
cancellation grace, or alter any resource threshold. Evidence is in
`/tmp/pi-code-mode-r3-diagnostics`, `/tmp/pi-code-mode-r4-heavy-cpu-aware.json`,
`/tmp/pi-code-mode-r5-cancel-r4.json`, `/tmp/pi-code-mode-r5-cancel-ab.json`, and the fresh
independent directories recorded above.

Rules:

- no runtime-specific work while disabled;
- lazy imports for host/process-heavy modules;
- bounded buffers, no repeated full-buffer concatenation in hot framing/output paths;
- immutable tool lookup maps per cell;
- no JSON stringify/parse cycle where protocol data is already validated and bounded;
- select Bun path by capability, not user-agent assumption;
- keep shared Node path if Bun result misses section 13 threshold or changes behavior.

“Bun-compatible” is a correctness claim. “Faster on Bun” is made only from recorded benchmark
protocol. No Bun-only path is retained based on intuition or a single timing run.

## 11. Source provenance and sync

Artifacts copied during relocation record:

| Source | Provenance | Package use |
|---|---|---|
| Codex standalone host trees | patched Codex commit, per-file hashes, and structural classification in `vendor/codex/code-mode-host/provenance.json` | normal source build |
| minimal `codex-protocol` compatibility crate | exact upstream `ToolName` plus local manifest/export | avoids unrelated Codex internals |
| Codex host patch | pinned baseline and digest in section 9 | bootstrap/history evidence |
| Codex license/notice | Apache-2.0 upstream files | redistribution attribution |
| bounded host protocol/client modules | owned protected Pi work, archived hashes | adapted package runtime |
| provider overlay | `@howaboua/pi-codex-conversion` commit `3d55dffaf22a47854f568d3d2d742b979cfbc55f` | MIT-attributed native bridge |

Relocation process, before protected cleanup:

1. Record protected HEADs, full diff hashes, and per-file hashes.
2. Archive full binary diffs and every owned untracked file outside protected repositories.
3. Copy scoped patch, license, notice, and reusable TypeScript modules into package.
4. Prove copied patch SHA-256 equals live scoped Codex diff.
5. Record source path, source commit, source hash, destination hash, license, and local adaptation.
6. Reverse only archived owned hunks; fail on overlap instead of forcing.
7. Delete owned untracked files only when current hashes equal archived hashes.
8. Compare unrelated pre/post diff bytes and prove no owned code-mode changes remain.

Upstream host sync is explicit and allowlisted. Start from a clean reviewed Codex commit, apply or
replace the historical patch without three-way or fuzzy merging, copy complete selected trees,
regenerate per-file hashes and standalone lock, inspect every structural deviation, then run the
locked release build and full behavioral/resource gates. Normal install/runtime never reads,
fetches, or resolves modules from a Codex checkout.

`npm run sync:host -- --codex PATH --commit 40HEX --output NEW_PATH` prepares
only first review stage. It verifies exact clean checkout and current vendored
preimage, reads complete allowlisted trees from Git blobs, carries classified
local scaffold files as explicit inputs, snapshots full verified current
preimage, and emits machine report plus binary no-index diff from captured
bytes. Output must be new and outside checkout/package/agent roots. Run without
concurrent package edits; full preimage is revalidated before success. Script
never applies historical patch, regenerates lock, edits vendor, or activates
candidate.

## 12. Failure modes and trade-offs

| Failure | Required behavior |
|---|---|
| direct tool conflict before first supported activation | reject without registration or removal |
| enable while agent busy | reject; no partial mutation |
| incomplete/invalid host facts | reject before tool/provider mutation |
| host hash/size/platform/arch mismatch | reject before spawn |
| provider has incompatible custom stream | reject native enable; leave provider unchanged |
| provider changed while overlay active | leave foreign state untouched, disable, report collision |
| unsupported enable/model | keep normal tools/provider; skip host resolution |
| malformed/duplicate provider call IDs | explicit stream failure; no corrupt replay |
| invalid nested input/output | bounded explicit outer error |
| cell/tool limit | cancel affected work and report exact limit |
| host crash/protocol violation | fail cells, clean generation, never silent replay |
| reload/model/session switch | bounded teardown and guarded restore |
| prior active tool disappeared | restore remaining names in original order, report omission |
| cleanup exceeds grace | terminate owned host, settle waiters, report forced cleanup |

Accepted trade-offs:

- Public Pi cannot expose arbitrary third-party tools or private hooks; explicit definitions are
  safer but less transparent.
- Public Pi has no Codex-style direct-only exposure metadata. The extension cannot automatically
  preserve future direct-only exceptions; each needs an explicit public Pi contract and reviewed
  integration.
- Native OpenAI support duplicates a small provider boundary and creates upstream sync work.
- Native stream supports Responses message, reasoning, function-call, custom-call, and narrowly
  bounded hosted web-search items needed by Pi code mode. New server-native output item kinds
  require explicit reviewed support.
- Pi cannot unregister lazy tool names, so first supported activation reserves them until reload.
- Restoring saved active list intentionally discards tool-surface changes attempted while package
  exclusively owned enabled surface.
- Local package-owned host setup costs Cargo/rustc, registry/V8 artifacts, build time, and
  platform-specific validation, but removes binary download and checkout dependency.
- Maintaining a source fork requires explicit upstream security and bug-fix review.
- V8 resource controls limit mistakes; they do not make code execution safe against hostile code.
- Live GPT-5.6 behavior cannot be claimed without credentials and approved paid runs.
- Windows host integration is unrun; current build and process evidence are Apple aarch64 only.

## 13. Acceptance gates

No test files are committed unless user requests them. Deterministic probes may use temporary
files outside package source and must be reproducible.

### 13.1 Build and packaging

- Typecheck, build, lint, and package dry-run pass.
- Vendored workspace builds with `cargo build --locked --release` without a Codex checkout.
- Raw host probe proves protocol v1, exact `resource_limits_v1`, process limits, session/cell limit
  echoes, open/execute/shutdown lifecycle, cell cleanup, and clean process exit.
- Packed artifact contains standalone source/lock/provenance, patch, license, and notice; no
  executable host, `target`, registry cache, or prototype artifact.
- Clean-room install runs outside workspace against published Pi 0.81.1 with protected checkout
  absent from module resolution.

### 13.2 Disabled and lifecycle correctness

- Disabled import records zero tool registration, provider overlay, spawn, filesystem, network,
  timer, and exit-hook events; it registers exactly three commands listed in section 1.
- First and repeated toggle cycles restore exact active-tool order.
- Tool-name fixtures cover allowed state (all names absent, then all package source/schema
  markers resolve and exact active list is `["exec", "wait", "request_user_input"]`) and excluded state (any name
  already resolves to a foreign definition). Excluded definitions are neither registered over nor
  removed. Marker/active-list verification failure restores prior state, remains disabled, and
  reports names claimed until reload.
- Provider snapshot fixtures cover all three discriminants: `none` installs owned overlay and
  restores absence; `config` installs owned overlay and restores exact captured config; `native`
  rejects before any mutation. Fixtures call both public registry getters before and after each
  step.
- Provider enable/disable toggles, model change, reload, and session switch restore exact prior `none`/`config`
  registration only when native object identity, retained stream identity, absent config, and
  expected non-stream structural/value comparison all pass.
- Collision fixture changes provider while enabled and proves foreign state remains byte/value and
  identity untouched.
- In-place collision fixture retrieves owned native object through
  `getRegisteredNativeProvider(providerId)`, mutates its stream, models, auth, and metadata in
  place, then proves teardown treats it as foreign and leaves same mutated object and fields
  untouched.
- Nested fixtures prove exact order:
  `prepareArguments(raw) -> input schema -> before -> replacement input schema -> execute ->
  runtime result schema -> after -> replacement result schema -> bounded encode`. Callback
  failure produces only bounded outer error and no nested Pi event/transcript entry.
- Cancellation, yield/wait, terminate, crash, replay, every limit, and cleanup pass.
- Host fixture replaces source path after its handle opens and proves spawned bytes come only from
  validated private copy; private file is `0700`, source path is never spawned, and temporary
  artifacts are removed after success and every failure.
- Transcript fixture contains only outer `exec`/`wait`/`request_user_input` calls and results.

### 13.3 Provider fixtures

- Native request, streamed raw-code deltas, completed call, replay, and custom output pairing
  preserve exact JavaScript.
- Duplicate IDs, cancellation, malformed stream termination, and unsupported native functions
  fail before corrupt state or network work.

### 13.4 Provenance and protected cleanup

- Copied host patch hash equals recorded digest and applies to recorded Codex baseline.
- Selected vendored source trees compare byte-identical with patched recorded source.
- Every vendored workspace file has source classification and SHA-256 in machine-readable
  provenance.
- Protected Pi and Codex worktrees contain no remaining owned code-mode diff.
- Unrelated protected changes have byte-identical pre/post diffs.

### 13.5 Performance protocol

Record machine, OS, CPU, RAM, power state, load, Bun/Node/Rust versions, release-host exact path,
SHA-256, size, and build command.

Run on AC power with load average below logical core count; record that macOS affinity is
unavailable. Use:

- fixed seed `0x5eed1234`;
- 30 warmups;
- 200 alternating paired samples;
- no outlier removal;
- monotonic clock;
- 10,000-replicate fixed-x residual bootstrap 95% confidence interval.

Compare packed clean-room extension with exact published Pi 0.81.1 baseline. Keep raw JSON,
command, environment, baseline package SHA, and report.

Performance gates:

- disabled import/startup: wall regression below `max(2%, 2 ms)` and RSS regression below 2 MiB;
- code-mode-off normal tool path: confidence interval includes zero;
- adapter empty-cell p95 overhead below `max(10%, 2 ms)`;
- ten nested no-op calls: added p95 below 5 ms total;
- eight parallel 20 ms calls: p95 below 35 ms;
- Bun-only path retained only when paired p95 improves by at least `max(5%, 0.2 ms)` over shared
  path with no correctness loss;
- after 5,000 warm cells, sample 20 windows of 100 cells: retained memory below 32 MiB; FD and
  thread counts stable; parent heap-used slope confidence interval includes zero; RSS slope
  confidence interval includes zero or upper bound is at most one reported OS page per 100 cells;
- live 20-run GPT-5.6 gate passes before any default-enablement proposal.

## 14. Review and completion

Implementation files may be added only after independent review accepts this architecture.
Completion requires independent final correctness/performance review, protected-repository cleanup
proof, and explicit reporting of every red or unrun gate.
