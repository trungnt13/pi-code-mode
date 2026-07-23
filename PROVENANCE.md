# Provenance

## Codex host

- Baseline: `b5748e6e3cbc3c9831f84aa016486721b4923d1c`
- Patch: `vendor/codex/codex-code-mode-host.patch`
- Patch SHA-256:
  `61f8a64ab08a302f7321ac4f1210c4ee1ff3abf4df3b064a6fb588b431a5b024`
- Validated host SHA-256:
  `9086dd45be73059b29af03b88fff361d65dcd39ee2ec59f2e7079563386ad914`
- Build:
  `cargo build --locked --release -p codex-code-mode-host --target aarch64-apple-darwin`
- Build location: disposable clean clone with patch applied

Package never ships executable host.

Patch keeps V8's process-wide platform worker count CPU-aware and bounded to four. Host uses a
current-thread Tokio runtime with two blocking workers, matching its stdin and serialized stdout
consumers. New blocking-pool consumers require a cap review and fresh resource, cancellation,
backpressure, and throughput gates.

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

Transport behavior was cross-checked against published `@earendil-works/pi-ai` 0.81.1 distribution (`dist/api/openai-codex-responses.js` and `dist/openai-prompt-cache.js`): endpoint construction, OAuth account claim, required headers, session headers, SSE framing, timeout, retry, and callback behavior. Package implements this boundary directly with bounded platform `fetch`; it has no direct OpenAI SDK dependency. It deliberately excludes published WebSocket and zstd alternatives. Runtime uses only published Pi APIs.
