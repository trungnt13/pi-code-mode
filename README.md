# pi-code-mode

Standalone, bounded JavaScript code mode for Pi 0.81.1. Extension is off by
default. While enabled, model sees only `exec` and `wait`. GPT-5.6 models use
native freeform `exec` only when model API is exactly `openai-codex-responses`,
provider is exactly `openai-codex`, and model ID starts with `gpt-5.6`. Every other model uses function input `{ code: string }`.

Disabled load imports only inert facade and dependency-free constants. UUIDs, schemas, Pi tool
factories, controller, host code, and provider bridge load on first `/code-mode on`. Before that,
`status`, `off`, model change, and shutdown remain lightweight no-ops.

## Install

```sh
npm install
npm run build
pi install /absolute/path/to/pi-code-mode
```

Package works on Node 22.19 or newer and Bun's Node-compatible runtime. No
Bun-only fast path is enabled without benchmark evidence.

## Host

Build host from pinned Codex source using [vendor patch](vendor/codex/codex-code-mode-host.patch).
Patch bounds V8 platform workers by available CPU count (maximum four) and Tokio blocking workers
to current stdin/stdout needs. See [architecture](ARCHITECTURE.md) and
[provenance](PROVENANCE.md) before adding another blocking host operation.
Package includes no host binary, downloader, URL, or automatic build.

Configure all five variables:

```sh
export PI_CODE_MODE_HOST_PATH=/absolute/canonical/path/to/codex-code-mode-host
export PI_CODE_MODE_HOST_SHA256=<64-lowercase-hex>
export PI_CODE_MODE_HOST_SIZE=<decimal-bytes>
export PI_CODE_MODE_HOST_PLATFORM=darwin
export PI_CODE_MODE_HOST_ARCH=arm64
```

Factory users may pass same complete identity:

```ts
import { createCodeModeExtension } from "pi-code-mode";

export default createCodeModeExtension({
  inputMode: "auto",
  host: {
    executablePath: "/absolute/canonical/path/to/codex-code-mode-host",
    sha256: "...",
    sizeBytes: 123,
    platform: "darwin",
    architecture: "arm64",
  },
});
```

`inputMode` accepts:

- `auto` (default): native freeform only for eligible GPT-5.6 OpenAI Codex models.
- `function`: always keep `{ code: string }`; provider registry is untouched.
- `freeform`: require eligible model or reject `/code-mode on` before tool or
  provider mutation.

Native transport matches published Pi 0.81.1 Codex SSE behavior: it posts to `<base>/codex/responses` (default `https://chatgpt.com/backend-api`), derives `chatgpt-account-id` from OAuth JWT, and sets Pi Codex headers. It intentionally uses bounded SSE only. WebSocket and zstd paths are excluded; timeout, cancellation, response callback, retry count, and retry-delay cap remain supported. Required authentication and protocol headers cannot be overridden.

Native enable installs one guarded provider overlay through public Pi APIs.
Disable, model change, and session shutdown restore prior provider config or
absence. If another extension replaces or mutates overlay, code mode leaves
foreign state untouched, disables, and reports ownership collision.

`/code-mode on` validates identity without starting host. First `exec` copies
bytes from validated open file handle to package-owned private `0700` temporary
directory, verifies copied size/hash, and spawns only private copy.

Host receives a fixed minimal environment. POSIX receives `PATH=/usr/bin:/bin`,
`TMPDIR` from runtime temporary-directory API, and `LANG=C.UTF-8`. Windows
receives `SystemRoot` (parent value, or `C:\Windows`), `PATH` set to its
`System32`, and `TEMP`/`TMP` from runtime temporary-directory API. No other
parent variables, including credentials, tokens, and proxies, are inherited.

## Commands

- `/code-mode on`
- `/code-mode off`
- `/code-mode status`

On first successful enable, extension claims `exec` and `wait` until reload
because Pi cannot unregister tools. Disable restores previous active tool order.
If registration throws after it may have recorded either tool, status reports
`partial until reload`; another enable fails until reload.

Public hard bounds include 256 pending host operations, 5 s handshake, 2 s host
close, 1 s cancellation grace, 6 s controller prepare-close, 6 s host-loss
cleanup, 16 KiB outer error, JSON depth 64, and 100,000 JSON values. Native transport also caps requests and SSE streams at 16 MiB, one item/event buffer at 4 MiB, events at 100,000, output items at 4,096, IDs at 8,000 and 1,024 bytes each, headers at 256 entries/64 KiB, OAuth JWTs and provider errors at 16 KiB, and retries at 8. Session `maxDelegateCalls` also caps simultaneous delegate work and shared scheduler concurrency.

## Nested tools

Defaults: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, created with
published Pi factories. `nestedTools` adds explicit definitions. Duplicate,
reserved, or normalization-colliding names fail before activation.

Optional callbacks:

- `beforeNestedTool`: return replacement arguments; replacement is revalidated.
- `afterNestedTool`: return replacement result; replacement is revalidated.

Nested calls and callbacks do not emit Pi nested tool events or transcript
messages. Only outer `exec`/`wait` calls and results enter transcript.

## Security

V8 limits and local host process reduce accidental resource damage. They are not
security sandbox. Nested tools keep filesystem and shell authority. Do not run
untrusted JavaScript or host binaries.
