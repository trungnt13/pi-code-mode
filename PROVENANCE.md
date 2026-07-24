# Provenance

## Codex host

- Standalone workspace:
  `vendor/codex/code-mode-host/codex-rs/Cargo.toml`
- Copied patched checkout:
  `808d3c2702ce8eae007c457aa930e7c3b68dd5f6`
- Patch baseline: `b5748e6e3cbc3c9831f84aa016486721b4923d1c`
- Patch: `vendor/codex/codex-code-mode-host.patch`
- Patch SHA-256:
  `61f8a64ab08a302f7321ac4f1210c4ee1ff3abf4df3b064a6fb588b431a5b024`
- Standalone lock SHA-256:
  `ad36b876206bf917d3519d621738e5c225ab90b6417d3dac28d88c05c8447a98`
- Prototype Apple-arm64 release host SHA-256:
  `b13dd2df260404f0a39e781b0756359f5a9750bb159836e6e3bd90d7d0878aae`
- Prototype release host size: `72583864` bytes
- Build:
  `cargo build --manifest-path vendor/codex/code-mode-host/codex-rs/Cargo.toml --locked --release -p codex-code-mode-host`
- Prototype toolchain: rustc 1.94.1, Cargo 1.94.1, Apple arm64
- Machine-readable file map:
  `vendor/codex/code-mode-host/provenance.json`

Package owns complete patched upstream `code-mode-host`, `code-mode`, and
`code-mode-protocol` trees. Their crate names, modules, files, tests, and
remote-session structure remain byte-identical to patched disposable source.
Exact upstream `utils/cargo-bin` test helper is retained.

Production source used only `codex_protocol::ToolName` from broad Codex protocol
crate. Standalone workspace therefore keeps a minimal `codex-protocol`
compatibility crate: `tool_name.rs` is exact upstream source; local manifest and
`lib.rs` expose it. Root workspace manifest and independently generated lockfile
are local structural deviations. Every copied or local file, source path,
classification, size, and SHA-256 is recorded in machine-readable map.

Cargo/rustc and locked registry/V8 artifacts remain build prerequisites.
Network or populated Cargo caches may be required. Offline support is not
claimed. Package ships no executable host.

Maintainer sync command:

```sh
npm run sync:host -- --codex /path/to/codex --commit <40-hex-commit> --output /new/output/path
```

Command requires clean checkout at exact requested commit and validates every
current provenance-mapped byte plus patch digest before creating output. It
discovers complete selected upstream trees from commit tree, records Git blob
IDs and content SHA-256, retains only classified local standalone scaffolds,
and emits captured `current-preimage/`, candidate, review report, and diff from
same verified bytes. Command requires no concurrent package edits and
revalidates full package preimage before success. Candidate is never merged,
patched, locked, built, or activated automatically.

Agent-as-software workflow lives with host source:
`vendor/codex/code-mode-host/UPDATE_WITH_AGENT.md` is sole task instruction and
`vendor/codex/code-mode-host/run-agent-update.sh` validates target checkout,
creates isolated review output, and runs instruction through Codex CLI:

```sh
vendor/codex/code-mode-host/run-agent-update.sh \
  /path/to/codex <40-hex-commit>
```

Workflow is source-repository maintenance software and is excluded from package
payload.

Patch keeps V8's process-wide platform worker count CPU-aware and bounded to four. Host uses a
current-thread Tokio runtime with two blocking workers, matching its stdin and serialized stdout
consumers. New blocking-pool consumers require a cap review and fresh resource, cancellation,
backpressure, and throughput gates.

Package installer rerun on Apple arm64 produced release SHA-256
`fa02384c575fed33cf041bf8a80563fa5b44e5a9c97a7bdf8ab36afd285fea9f`
(72,620,776 bytes) and proved locked release build plus raw protocol v1 lifecycle:
`resource_limits_v1`, process ceilings, exact session/cell limit echoes,
open/execute/cell cleanup/shutdown, and clean exit. This evidence covers Apple
arm64 only.

## Relocated Pi work

Source evidence is archived outside package under
`.agents/archive/pi-code-mode-relocation`. Pi baseline:
`ecb9410c5c5c3f8c0f0f444f386043276b9f0d3a`. Archived tracked diff SHA-256:
`5b07ba51d52858898a72df7d76a55353c9a7c14d64010f13a1a3977009fbab0a`.

Adapted modules:

- bounded frame/protocol client;
- host generation, cancellation, and cleanup;
- shared/exclusive fair scheduler;
- cell/controller flow and bounded output handling.

Runtime imports only public npm packages. Protected Pi and Codex checkouts are
not module-resolution inputs.

## Native OpenAI provider bridge

- Source project: `@howaboua/pi-codex-conversion`
- Repository: `https://github.com/IgorWarzocha/howaboua-pi-stuff`
- Commit: `3d55dffaf22a47854f568d3d2d742b979cfbc55f`
- License: MIT, Copyright (c) 2026 Igor Warzocha
- Reviewed source: `src/providers/code-mode-proxy-provider.ts`,
  `src/adapter/code-mode-contract.ts`, and `src/providers/openai-responses/stream.ts`
- Adaptation: package-owned `src/native/contract.ts`, `src/native/overlay.ts`,
  and `src/native/stream.ts`, narrowed to `openai-codex` +
  `openai-codex-responses` + `gpt-5.6*`.

Transport behavior was cross-checked against published `@earendil-works/pi-ai` 0.81.1 distribution (`dist/api/openai-codex-responses.js` and `dist/openai-prompt-cache.js`): endpoint construction, OAuth account claim, required headers, session headers, SSE framing, timeout, retry, and callback behavior. Package implements this boundary directly with bounded platform `fetch`; it has no direct OpenAI SDK dependency. It deliberately excludes published WebSocket and zstd alternatives. Runtime imports only public Pi APIs.

`src/native/transform-messages.ts` copies
`packages/ai/src/api/transform-messages.ts` from `@earendil-works/pi-ai`
0.81.1, adapting its type import to Pi's public package entry point and adding
one behavior-equivalent loop syntax change for this package's stricter
TypeScript settings.
Upstream source SHA-256:
`cf309c00b943bc0a90ccaabb185730a3f27a3c92de6696ada3155b0185904161`.
