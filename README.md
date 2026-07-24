# pi-code-mode

Standalone, bounded JavaScript code mode for Pi 0.81.1. Extension is off by
default. While enabled, model sees only `exec` and `wait`. GPT-5.6 models use
native freeform `exec` only when model API is exactly `openai-codex-responses`,
provider is exactly `openai-codex`, and model ID starts with `gpt-5.6`. Every other model uses function input `{ code: string }`.

Disabled load imports only inert facade and dependency-free constants. UUIDs, schemas, Pi tool
factories, controller, host code, and provider bridge load when `/code-mode` first enables the
extension. Before that, status, model change, and shutdown remain lightweight no-ops.

## Install

Install directly from GitHub:

```sh
pi install git:github.com/trungnt13/pi-code-mode
```

Pin a tag or commit when reproducibility matters:

```sh
pi install git:github.com/trungnt13/pi-code-mode@<tag-or-commit>
```

Pi loads `src/index.ts` directly through its TypeScript extension loader. No
manual dependency install or build is required. Restart Pi or run `/reload`,
then use `/code-mode-host-install` once to build, probe, and install host. Run
`/reload` again after successful host install. Code mode remains off until
`/code-mode` successfully toggles it on.

For local development:

```sh
npm install
npm run check
pi install /absolute/path/to/pi-code-mode
```

Package works on Node 22.19 or newer and Bun's Node-compatible runtime. No
Bun-only fast path is enabled without benchmark evidence.

## Host

Recommended setup inside Pi:

```text
/code-mode-host-install
/reload
/code-mode
```

Installer verifies package-owned source against provenance map, runs locked
release Cargo build without shell or Codex checkout, probes protocol and
resource-limit contract, then publishes executable by content hash and
atomically replaces `current.json` under Pi agent directory. Failed build,
probe, or publish leaves prior manifest active. Cargo/rustc and locked
registry/V8 artifacts are build prerequisites. First build may need network;
offline builds are not claimed. Package includes source and lockfile, but no
host binary, downloader, or URL.

Source preserves patched upstream `code-mode-host`, `code-mode`, and
`code-mode-protocol` trees, including remote-session paths and tests. Historical
[vendor patch](vendor/codex/codex-code-mode-host.patch) remains bootstrap and
review evidence; normal build does not apply it or need Codex checkout. See
[architecture](ARCHITECTURE.md) and [provenance](PROVENANCE.md) before changing
host source or adding blocking work.

Maintainers can prepare a review-only candidate from a clean exact Codex checkout:

```sh
npm run sync:host -- --codex /path/to/codex --commit <40-hex-commit> --output /new/output/path
```

Output must not exist and must remain outside checkout, package, and Pi agent
directories. Command validates current vendored preimage, copies complete
allowlisted upstream trees plus local standalone scaffold inputs, and writes
immutable `current-preimage/` and `candidate/` trees, hash report, and binary
diff. Run it without concurrent package edits; final preimage revalidation
rejects detected changes. It never applies patch, regenerates lockfile, changes
vendor source, or activates candidate.

Factory host identity remains highest-precedence advanced override. Otherwise,
complete five-variable environment identity overrides installed manifest.
Partial environment identity fails and never falls through. Configure all five:

```sh
export PI_CODE_MODE_HOST_PATH=/absolute/canonical/path/to/codex-code-mode-host
export PI_CODE_MODE_HOST_SHA256=<64-lowercase-hex>
export PI_CODE_MODE_HOST_SIZE=<decimal-bytes>
export PI_CODE_MODE_HOST_PLATFORM=darwin
export PI_CODE_MODE_HOST_ARCH=arm64
```

With neither explicit source configured, runtime strictly validates installed
`current.json`, executable path, mode, size, hash, platform, and architecture.
Current build, installer, and raw lifecycle evidence covers Apple arm64 only.

Advanced repository-local wrappers may import `createCodeModeExtension` from
`src/index.ts` and pass the same complete identity. This Git package is a Pi
source extension, not a compiled Node library.

`inputMode` accepts:

- `auto` (default): native freeform only for eligible GPT-5.6 OpenAI Codex models.
- `function`: always keep `{ code: string }`; provider registry is untouched.
- `freeform`: require eligible model or reject an enabling `/code-mode` toggle
  before tool or provider mutation.

Native transport matches published Pi 0.81.1 Codex SSE behavior: it posts to `<base>/codex/responses` (default `https://chatgpt.com/backend-api`), derives `chatgpt-account-id` from OAuth JWT, and sets Pi Codex headers. It intentionally uses bounded SSE only. WebSocket and zstd paths are excluded; timeout, cancellation, response callback, retry count, and retry-delay cap remain supported. Required authentication and protocol headers cannot be overridden.

Native enable installs one guarded provider overlay through public Pi APIs.
Disable, model change, and session shutdown restore prior provider config or
absence. If another extension replaces or mutates overlay, code mode leaves
foreign state untouched, disables, and reports ownership collision.

An enabling `/code-mode` toggle validates identity without starting host. First
`exec` copies bytes from validated open file handle to package-owned private `0700` temporary
directory, verifies copied size/hash, and spawns only private copy.

Host receives a fixed minimal environment. POSIX receives `PATH=/usr/bin:/bin`,
`TMPDIR` from runtime temporary-directory API, and `LANG=C.UTF-8`. Windows
receives `SystemRoot` (parent value, or `C:\Windows`), `PATH` set to its
`System32`, and `TEMP`/`TMP` from runtime temporary-directory API. No other
parent variables, including credentials, tokens, and proxies, are inherited.

## Commands

- `/code-mode` toggles code mode on or off.
- `/code-mode-host-install` builds, probes, and installs package-owned host; reload is required.
- `/code-mode-status` reports current state without changing it.

On first successful enabling toggle, extension claims `exec` and `wait` until
reload because Pi cannot unregister tools. A disabling toggle restores previous active tool order.
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
