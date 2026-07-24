# Code-mode host install plan

## Objective

Add `/code-mode-host-install` so Pi builds, validates, and installs a compatible
`codex-code-mode-host` without modifying or depending on a Codex checkout.

Success means:

- disabled extension load still registers commands only and performs no I/O;
- install builds package-owned, locked Rust source through Cargo;
- staged host proves exact protocol v1 and `resource_limits_v1` contract before activation;
- binary and identity manifest install atomically under Pi agent directory;
- `/code-mode` can resolve installed identity without shell environment variables;
- active or last-known-good host is never replaced by failed build/probe;
- no npm package, downloaded helper, runtime wrapper, or protected checkout is required.

Assumption: “no external dependencies” excludes integration code and source
checkouts. Cargo/rustc and locked Rust registry crates remain build prerequisites.
Literal zero build-tool/network/cache dependency is incompatible with building Rust
inside Pi unless all platform binaries or full Cargo dependency source is shipped.

## Verified current state

- `src/index.ts:62` registers only `/code-mode` and `/code-mode-status`; activated
  runtime is lazy.
- `src/runtime/extension.ts:366` accepts host identity only from complete factory
  options or five `PI_CODE_MODE_HOST_*` variables.
- `src/runtime/host-client.ts:492` requests `resource_limits_v1`;
  `src/runtime/host-client.ts:755` rejects hosts without it.
- Stock Codex at local clean `808d3c2702ce8eae007c457aa930e7c3b68dd5f6`
  advertises no capabilities and has no protocol limit fields.
- Vendored patch is bound to `b5748e6e3cbc3c9831f84aa016486721b4923d1c`,
  SHA-256 `61f8a64ab08a302f7321ac4f1210c4ee1ff3abf4df3b064a6fb588b431a5b024`,
  and changes 27 host/protocol/runtime files.
- Patch applies cleanly to current local Codex because none of its 27 target files
  changed since baseline. This does not prove future compatibility.
- Host/runtime/protocol source is about 680 KiB before lockfile and can likely be
  made standalone: production references to `codex-protocol` use only `ToolName`.
- Existing docs explicitly prohibit automatic build and package-owned host source;
  architecture, trust policy, provenance, and packaging must change together.

## Failure list and invariants

1. Stock or wrapper host advertises compatible shape but does not enforce limits.
   - Activation requires owned source identity plus staged behavioral conformance.
   - Protocol wrapper/sidecar is rejected because it cannot enforce V8 heap,
     pending timers, stored state, or nested-result limits.
2. Build, probe, cancellation, Pi shutdown, or disk failure leaves partial install.
   - Build in staging; atomically publish immutable content-addressed artifact and
     manifest only after every check; retain prior valid artifact.
3. Parallel installs race or replace host used by active code mode.
   - One package-owned install lock; require idle agent and disabled code mode;
     immutable versioned binary paths; reload before new identity becomes active.
4. Installed binary or manifest is tampered with.
   - Manifest binds source revision, lockfile hash, protocol/probe version,
     platform, architecture, binary byte size, and SHA-256. Existing host-client
     validation and private-copy spawn remain mandatory.
5. Disabled path regresses.
   - Installer and host resolver are lazy imports; no module-scope filesystem,
     subprocess, network, timer, or exit-hook work.
6. Upstream Codex update breaks integration.
   - Default build uses package-owned fork, so unrelated checkout updates have no
     effect. Upstream adoption is explicit and separately validated.
7. Package-owned fork goes stale.
   - Record exact copied files and upstream commit. Provide maintainer-only,
     allowlisted sync/provenance script in this repo; never auto-merge or activate
     drift. Full gates are required before updating owned source.

## Prototype decision

Run prototypes in disposable `/tmp` workspaces; commit no prototype or test files.

| Prototype | Probe | Decision |
|---|---|---|
| strict patch of supplied Codex clone | exact patch, locked release build, handshake | bootstrap evidence only; reject as default because 27-file drift needs manual rebase |
| standalone package-owned Rust fork | extract patched host/code-mode/protocol, replace sole `ToolName` dependency, locked release build, conformance | chosen if build and contract pass |
| stock-first capability adoption | build current stock, prove client rejection; define future conformance gate | future maintainer path only |
| stock protocol wrapper | analysis already proves in-isolate limits impossible | reject; no code prototype |

If standalone extraction cannot build without pulling broad Codex internals, stop
and revise plan instead of silently selecting weaker host semantics.

## Chosen design

### Package-owned host source

- Add a small Rust workspace under `vendor/codex/code-mode-host/` containing
  production source from patched `code-mode-host`, `code-mode`, and
  `code-mode-protocol`.
- Preserve upstream Codex crate names, module tree, file layout, public boundaries,
  and source organization. Do not trim remote-session paths or rewrite runtime
  structure merely to reduce package size.
- Replace `codex_protocol::ToolName` with an equivalent local protocol type; do
  this through the smallest compatibility crate or import change that preserves
  upstream structure. Do not vendor unrelated Codex workspace crates.
- Pin direct crate versions and commit a standalone `Cargo.lock`.
- Preserve Apache-2.0 attribution and add file-level upstream provenance.
- Keep current patch as historical/bootstrap evidence until standalone source
  equivalence is recorded; do not apply it during normal install.

### Installer

- Register `/code-mode-host-install` in inert facade.
- Handler requires no arguments, idle agent, and disabled code mode; it lazy-loads
  `src/host-install.ts`.
- Resolve package source with `import.meta.url` and install root from public Pi
  `getAgentDir()`.
- Run `cargo build --locked --release` without a shell, with explicit manifest and
  target directories. Stream bounded diagnostics and show status through Pi UI.
- Own and terminate build subprocess on failure/shutdown; never mask nonzero exit.
- Hash and inspect staged executable, then run bounded protocol and resource
  conformance probes.
- Publish to
  `<agent-dir>/bin/pi-code-mode/hosts/<sha256>/codex-code-mode-host[.exe]`;
  atomically replace `current.json` only after fsync/rename checks.
- Preserve last-known-good content-addressed host and report `/reload` requirement.

### Runtime resolution

Host identity precedence:

1. complete factory `host`;
2. complete five-variable environment identity;
3. strictly parsed package-owned `current.json`.

Partial explicit configuration remains an error and never falls through. Installed
manifest resolution is lazy during enable, then existing canonical-path, platform,
architecture, size, SHA-256, private-copy, minimal-environment, handshake, and
limit-echo checks remain unchanged.

### Upstream sync

- Add maintainer script under `scripts/` that accepts a local Codex checkout,
  checks clean exact commit, copies only allowlisted source files into staging,
  records upstream blob hashes, and emits a reviewable diff.
- Script never edits Codex, never activates output, and never uses fuzzy/three-way
  patching.
- Future stock host may replace owned fork only after same behavioral probe suite
  passes. Capability advertisement alone is insufficient.

## Affected artifacts

- `ARCHITECTURE.md`: command flow, source ownership, build trust, atomic install,
  update policy, failure modes, acceptance gates.
- `README.md`: prerequisites, `/code-mode-host-install`, reload/use flow, limits.
- `PROVENANCE.md`, `THIRD_PARTY_NOTICES.md`: copied source and lock provenance.
- `package.json`: include host source; keep zero normal dependencies.
- `src/index.ts`: inert command registration and shared lifecycle lock.
- `src/host-install.ts`: lazy installer, build process, staging, lock, hashing,
  manifest publication, bounded UI diagnostics.
- `src/installed-host.ts`: strict manifest schema and lazy identity resolution.
- `src/runtime/extension.ts`: precedence and installed-host fallback.
- `scripts/verify-pi-package.mjs`: command/payload/disabled-load assertions.
- `scripts/sync-code-mode-host.mjs`: maintainer-only upstream import.
- `vendor/codex/code-mode-host/**`: standalone owned Rust source, manifests,
  lockfile, and provenance map.

No new committed test files. Temporary deterministic probes live outside repo.

## Ordered implementation

1. Prototype strict patched build, stock rejection, and standalone extraction in
   `/tmp`; record exact commands, outputs, artifact hashes, sizes, and blockers.
2. Update `ARCHITECTURE.md` first with proven design and any prototype-driven
   deviation.
3. Add standalone Rust source, local `ToolName`, locked manifest, notices, and
   provenance; prove package-owned build.
4. Implement strict installed-host manifest reader and resolution precedence.
5. Implement lazy installer with lifecycle coordination, bounded diagnostics,
   cancellation/cleanup, staged conformance, immutable artifact, and atomic
   manifest publish.
6. Register command without adding disabled-load I/O.
7. Add maintainer sync script and exact preimage/provenance checks.
8. Update README, provenance, notices, package verifier, and package payload.
9. Run acceptance probes cheapest-first; repair first failure before continuing.
10. Independent blind review receives plan, final diff, and command outputs.

## Pre-registered validation

1. `npm run lint`
2. `npm run typecheck`
3. `npm run build`
4. `npm run verify:package`
5. `npm pack --dry-run --json --ignore-scripts`
   - contains standalone source/lock/provenance;
   - contains no binary, `target`, cache, or prototype artifact.
6. Disabled import trace
   - registers three commands only;
   - zero filesystem, network, subprocess, timer, tool/provider, and exit-hook work.
7. Temporary Pi RPC probe
   - `/code-mode-host-install` appears;
   - bad args, busy agent, enabled mode, missing Cargo, build failure, and
     concurrent install fail explicitly.
8. Clean staging build with package source only; protected Codex checkout moved
   outside module/source resolution.
9. Staged-host conformance
   - protocol v1 and exact `resource_limits_v1`;
   - process ceilings and exact session/cell echoes;
   - above-ceiling requests rejected;
   - heap/output/timer/state/delegate/session/cell/process bounds exercised;
   - deadline/cancellation/cleanup and post-rejection usability pass.
10. Atomicity fault matrix
    - terminate/fail at each build, probe, fsync, rename, and manifest step;
    - prior manifest/binary remains valid;
    - parallel install yields one winner and no partial artifact.
11. Tamper matrix
    - malformed/incomplete manifest, wrong hash/size/platform/arch, symlink,
      path escape, replaced binary, and partial explicit environment all reject.
12. End-to-end
    - install, `/reload`, `/code-mode`, one direct cell, one nested call,
      disable, cleanup;
    - record exact binary hash/size, Rust versions, platform, architecture,
      thread/FD counts, and remaining unrun platform/performance gates.

## Risks and limits

- Fork ownership means security and upstream bug fixes require explicit sync.
- First Cargo build may download locked crates and V8 artifacts unless already
  cached; offline support is not claimed without vendored dependency evidence.
- Current correctness/performance evidence is Apple arm64. Other targets remain
  unverified until their matrix runs.
- Full resource conformance can be slow; it is still required before first
  activation of a newly built source identity.
- Arbitrary future Codex source cannot be auto-merged safely. Integration remains
  usable through owned source; adopting upstream changes stays a reviewed task.

## Implementation validation note

- `maxInFlightOperations=256` cannot be saturated through valid protocol-v1
  workloads: global active cells cap at 128, each cell permits one observer, and
  execute and wait observers cannot overlap for one cell. Its exact advertised
  field/value remains validated, but runtime saturation is unrun.
- Maintainer sync command is implemented at `scripts/sync-code-mode-host.mjs`.
  It passed clean exact-HEAD import, source-status preservation, complete Git
  blob/hash report, dirty/mismatch/existing/protected-output rejection, and
  current-preimage tamper rejection. Captured-current and candidate trees each
  contain exact 72-file inputs; concurrent scaffold mutation preserved captured
  report bytes, failed final guard, and removed output. Windows runtime,
  offline-first-build, live-paid, global active-cell saturation, and
  max-in-flight saturation remain unrun.
