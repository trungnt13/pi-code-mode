---
description: Research about code-mode based on codex commit 808d3c2702ce8eae007c457aa930e7c3b68dd5f6
---
## What code-mode is

Codex code-mode is a **local JavaScript control layer for tools**.

Without code-mode, model must repeatedly:

1. Call tool.
2. Receive full result in conversation.
3. Reason about result.
4. Call next tool.

With code-mode, model sends one JavaScript program:

```js
const results = await Promise.all(
  files.map(file => tools.exec_command({ cmd: `analyze ${file}` }))
);

const failures = results.filter(result => result.exit_code !== 0);
text({ checked: results.length, failures });
```

V8 handles loops, branching, parallel calls, filtering, and data transformation. Only values emitted through `text`, `image`, `audio`, or related helpers return to model.

So primary purpose is:

- compose several tools into one operation;
- keep intermediate results outside model context;
- use deterministic JavaScript control flow;
- parallelize independent work;
- return only relevant information;
- let long operations continue as resumable cells.

Source describes it directly as “Run JavaScript code to orchestrate/compose tool calls” in [description.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode-protocol/src/description.rs:12).

## Most important boundary

Code-mode does **not** grant extra capabilities.

JavaScript cannot directly read files, execute processes, or access network. It can only request tools already admitted by Codex tool plan. Nested calls return through normal Core tool router, hooks, approval handling, and sandbox rules.

This makes code-mode an orchestration layer, not another shell or privileged runtime.

## Execution flow

```text
model
  │
  │ raw JavaScript
  ▼
exec tool
  │
  │ create cell
  ▼
fresh V8 isolate + OS thread
  │
  ├─ tools.foo(args) ──► normal Codex tool router
  │                         │
  │                         ├─ hooks
  │                         ├─ approval
  │                         ├─ sandbox policy
  │                         └─ tool execution
  │
  │◄──────── structured result / rejected promise
  │
  ├─ text/image/audio ──► model-visible output
  ├─ yield_control() ───► return cell ID, keep running
  └─ completion ────────► commit stored values, destroy isolate
```

Core receives raw source, parses optional pragma, gathers nested tool definitions, creates a cell, opens its dispatch gate, then waits for initial result in [execute_handler.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/code_mode/execute_handler.rs:29).

Each `tools.*` call becomes a normal `ToolCall` tagged with cell ID and runtime tool-call ID in [code-mode/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/code_mode/mod.rs:293). Recursive `tools.exec(...)` is explicitly rejected at line 306.

## Activation modes

Codex has three tool modes:

- `Direct`: model calls tools normally.
- `CodeMode`: model sees code-mode entrypoints alongside normal tools.
- `CodeModeOnly`: most normal tools are hidden from model and accessible only through `tools.*`.

They are defined in [openai_models.rs](/Users/trungnt13/codes/psi/codex/codex-rs/protocol/src/openai_models.rs:310).

Model metadata takes priority. If model metadata has no selector, config features choose `CodeModeOnly`, then `CodeMode`, else `Direct`: [tools/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/mod.rs:64).

Current bundled GPT-5.6 Sol and Terra metadata selects `code_mode_only`: [models.json](/Users/trungnt13/codes/psi/codex/codex-rs/models-manager/models.json:3).

Code-mode and code-mode-only feature flags remain marked under development and default off. Standalone host mode is stable and defaults on: [features/lib.rs](/Users/trungnt13/codes/psi/codex/codex-rs/features/src/lib.rs:860).

`CodeModeOnly` still permits explicit `DirectModelOnly` exceptions such as interaction or platform tools. It does not literally guarantee that only two tools will always be visible: [spec_plan.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/spec_plan.rs:430).

## `exec` contract

`exec` is a custom freeform tool, not a JSON function tool. Input must be raw JavaScript.

Accepted shape:

```js
// @exec: {"yield_time_ms": 30000, "max_output_tokens": 2000}
const result = await tools.exec_command({ cmd: "git status --short" });
text(result.output);
```

Grammar allows:

- plain non-empty source;
- optional first-line `// @exec: ...`;
- newline followed by source.

Grammar is in [execute_spec.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/code_mode/execute_spec.rs:14).

Pragma parser:

- accepts only `yield_time_ms` and `max_output_tokens`;
- rejects unknown fields;
- requires non-negative JS-safe integers;
- strips pragma before compilation;
- rejects empty source.

See [description.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode-protocol/src/description.rs:164).

Defaults:

- initial yield: 10 seconds;
- wait yield: 10 seconds;
- output budget: 10,000 tokens;
- buffered-exec feature changes initial default to 30 seconds.

See [runtime.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode-protocol/src/runtime.rs:11) and [core code-mode/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/code_mode/mod.rs:57).

## JavaScript environment

Each cell receives a fresh V8 isolate on a fresh OS thread: [runtime/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/mod.rs:73).

Source compiles as async ES module named `exec_main.mjs`, so top-level `await` works: [module_loader.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/module_loader.rs:9).

Unavailable:

- Node APIs;
- direct filesystem access;
- direct network access;
- `console`;
- `Atomics`;
- `SharedArrayBuffer`;
- `WebAssembly`;
- static or dynamic imports.

Globals are removed or installed in [globals.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/globals.rs:15). All imports are rejected in [module_loader.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/module_loader.rs:164).

V8 platform is initialized once per process. JIT is enabled by default; callers can request `--jitless` only before first initialization: [v8_init.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/v8_init.rs:16).

## Nested tools

`tools` contains callable functions for every enabled nested tool. `ALL_TOOLS` contains metadata:

```ts
Array<{ name: string; description: string }>
```

Both are constructed from same enabled set in [globals.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/globals.rs:52).

Calling a nested tool:

1. Converts first argument to JSON.
2. Creates V8 promise.
3. Allocates `tool-N` runtime ID.
4. Emits tool event.
5. Core dispatches normal tool call.
6. Result resolves promise; handler failure rejects it.

Implementation: [callbacks.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/callbacks.rs:14), [module_loader.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/module_loader.rs:66).

Function tools require object input. Freeform tools require string input: [core code-mode/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/code_mode/mod.rs:335).

Independent calls can run concurrently:

```js
const [status, tests] = await Promise.all([
  tools.exec_command({ cmd: "git status --short" }),
  tools.exec_command({ cmd: "cargo test" }),
]);
```

Parallel behavior is covered end-to-end in [code_mode.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/tests/suite/code_mode.rs:1023).

Nested results remain JavaScript values. Only emitted values enter model-facing output. This is code-mode’s main context-saving property. Tests verify large nested output can remain intact in JS before final output truncation: [code_mode.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/tests/suite/code_mode.rs:1191).

## Tool visibility

Tool plan excludes these from nested surface:

- `DirectModelOnly` tools;
- hidden tools;
- configured excluded namespaces.

Planning logic is in [spec_plan.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/spec_plan.rs:453).

Deferred tools may be omitted from prompt description but remain present in `tools` and `ALL_TOOLS`. This avoids loading huge tool descriptions into model context. Model can search metadata and call by computed name.

Namespace config supports:

- `excluded_tool_namespaces`: unavailable to code-mode;
- `direct_only_tool_namespaces`: only visible as direct model tools.

See [feature_configs.rs](/Users/trungnt13/codes/psi/codex/codex-rs/features/src/feature_configs.rs:7).

Tool names are normalized into valid JavaScript identifiers; invalid characters become `_`: [description.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode-protocol/src/description.rs:331).

## Output helpers

Available globals:

- `text(value)`: emits text; objects use `JSON.stringify`.
- `image(value, detail?)`: emits image.
- `audio(value)`: emits audio.
- `generatedImage(result)`: emits generated image and optional hint.
- `notify(value)`: injects intermediate output into active model turn.
- `exit()`: successful early termination.
- `yield_control()`: asks actor to return current output while continuing.
- `setTimeout` / `clearTimeout`.
- `store` / `load`.
- `tools`.
- `ALL_TOOLS`.

Definitions are documented in [description.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode-protocol/src/description.rs:24).

Important details:

- `text(undefined)` becomes `"undefined"`.
- Circular or otherwise unstringifiable objects cause script error.
- Emitted output before later script failure is preserved.
- `exit()` uses private exception sentinel treated as success.
- `notify()` requires non-empty text.
- Pending timers and unawaited promises do not keep script alive.

Callbacks: [callbacks.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/callbacks.rs:75).

`setTimeout` currently creates one sleeping OS thread per timer. `clearTimeout` removes callback but does not cancel sleeper thread: [timers.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/timers.rs:12). This is a notable performance limitation.

## Images and audio

Images must use `data:` URIs or individual MCP image blocks. HTTP(S) URLs and other schemes are rejected. Default detail is `high`; supported details are `auto`, `low`, `high`, and `original`: [value.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/value.rs:44).

Audio follows same principle: `data:` URI, `{audio_url}`, or raw MCP audio block; other schemes are rejected: [value.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/value.rs:188).

`generatedImage` emits image first, then optional `output_hint` text: [callbacks.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/runtime/callbacks.rs:153).

Core sanitizes requested image detail against model capability before returning it: [core code-mode/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/code_mode/mod.rs:245).

## Yielding, waiting, and cells

A script becomes a cell immediately. If it does not finish before yield deadline, `exec` returns:

```text
Script running with cell ID 17
```

Script continues in background. Model later calls `wait` with that cell ID.

`wait` can:

- observe until another yield;
- receive only output emitted since previous observation;
- retrieve buffered completion;
- terminate cell with `terminate: true`.

Only one active observer is allowed per cell. Competing observer receives busy error.

Public response types are `Yielded`, `Terminated`, and `Result`: [runtime.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode-protocol/src/runtime.rs:65).

Cell phases are:

```text
Running
  → Terminating
  → Terminated
or
Running
  → Completed
  → CompletionClaimed
  → Tombstone
```

State machine and terminal linearization are in [cell_actor/types.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/cell_actor/types.rs:99).

`yield_control()` sends a yield request but does not pause JavaScript itself. Actor returns accumulated output if a yield observer exists: [cell_actor/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/cell_actor/mod.rs:371).

Unknown or already-closed cells return model-visible `exec cell … not found`: [service.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/service.rs:412).

## Persistent values

Each session owns a JSON map. Every fresh cell receives a clone: [session_runtime/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/session_runtime/mod.rs:39).

`store(key, value)`:

- requires JSON-serializable data;
- updates cell-local view immediately;
- records write set;
- commits writes only after normal cell completion.

`load(key)` returns stored value or `undefined`.

Terminated cells do not commit pending writes. Concurrent cells merge only keys each wrote: [session_runtime/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/session_runtime/mod.rs:273).

Persistence is:

- shared across cells and turns in one Codex thread;
- isolated between sessions;
- memory-only;
- lost when session ends.

It does not preserve JavaScript closures, objects, promises, or isolate state.

## Process isolation and IPC

Default stable host mode launches `codex-code-mode-host` and multiplexes logical sessions through one child process: [thread_manager.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/thread_manager.rs:377).

Missing host executable falls back to in-process V8. Other host connection errors are surfaced: [remote_session.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/remote_session.rs:73).

Wire format:

- 4-byte little-endian length;
- JSON payload;
- 64 MiB maximum frame.

See [codec.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode-protocol/src/host/codec.rs:11).

Host limits:

- 256 in-flight requests;
- 128 active cells;
- 4,096 recent request IDs;
- 4,096 recent session IDs;
- 128-frame outbound queue.

See [code-mode-host/lib.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode-host/src/lib.rs:41).

Separate process gives crash and memory-address-space isolation from main Codex process. It is not evidence of a full operating-system sandbox. No explicit CPU deadline, isolate heap quota, or source-size limit exists in current code. Infinite CPU loops require termination; V8 isolate termination handles that case.

## Error and cancellation rules

- Nested handler errors reject JS promises and can be caught with `try/catch`.
- Unhandled JS error marks outer `exec` failed.
- Output emitted before error remains.
- Runtime thread panic becomes cell error.
- Termination cancels nested tool and notification callbacks before terminal response.
- Session shutdown cancels all cells and waits for actor tasks.
- Dropped observer does not consume buffered output.
- Natural completion racing termination is resolved through cell state lock.
- Store writes commit only if completion wins race.

Representative contracts: [service_contract_tests.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/service_contract_tests.rs:273), [cell_actor/tests.rs](/Users/trungnt13/codes/psi/codex/codex-rs/code-mode/src/cell_actor/tests.rs:278).

## Output budgets

There are separate limits:

1. Nested tool limit controls value returned into JavaScript.
2. `// @exec: {"max_output_tokens": ...}` controls final emitted `exec` output.
3. `wait.max_tokens` controls that wait call’s output delta.
4. Conversation history may apply another later truncation.

Core prepends status and rounded wall time, then truncates text/media output: [core code-mode/mod.rs](/Users/trungnt13/codes/psi/codex/codex-rs/core/src/tools/code_mode/mod.rs:199).

This separation is intentional: JavaScript can inspect large intermediate results and emit a compact summary without forcing full data into model context.

## Practical judgment

Code-mode is best for:

- fan-out tool calls;
- filtering large results;
- multi-step workflows with clear branches;
- retries and conditional execution;
- aggregating MCP results;
- keeping noisy intermediate output away from model;
- long operations requiring resumable polling.

Direct tools remain better for:

- one simple call;
- actions needing immediate human approval or interaction;
- cases where JavaScript adds no useful control flow.

Main current weaknesses:

- experimental activation semantics;
- fresh V8 isolate and OS thread cost per cell;
- one sleeping OS thread per timer;
- no visible V8 heap or CPU quota;
- process fallback reduces crash isolation when host binary is missing;
- approval inheritance is clear from normal router path, but code-mode-specific approval integration tests are absent;
- no dedicated history fork/replay contract found.
