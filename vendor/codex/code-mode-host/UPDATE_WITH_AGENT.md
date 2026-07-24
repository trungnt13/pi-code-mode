# Update package-owned Codex code-mode host

Investigate a newer Codex commit, write a decision-complete update plan, then
implement only upstream changes relevant to `pi-code-mode`.

Treat this file as the full task packet. Do not update blindly, copy all Codex
changes, or rewrite host in another language.

Run this instruction through `./run-agent-update.sh CODEX_CHECKOUT TARGET_COMMIT`
from this directory. Runner appends canonical checkout, target commit, and
isolated review-output paths to this instruction.

## Goal

Update package-owned standalone Rust host while preserving current Codex layout,
bounded `resource_limits_v1` contract, installer guarantees, and zero runtime
dependency on a Codex checkout. Keep upstream-shaped files as close to Codex as
possible. Include security fixes, correctness fixes, protocol changes,
dependency changes, and measured resource/performance fixes that affect:

- `codex-rs/code-mode-host`;
- `codex-rs/code-mode`;
- `codex-rs/code-mode-protocol`;
- retained `codex-rs/utils/cargo-bin`;
- retained `codex-rs/protocol/src/tool_name.rs`;
- standalone manifests, lockfile, provenance, installer, and host client when
  needed by those selected changes.

Exclude unrelated Codex CLI, UI, app-server, models, configuration, rollout,
authentication, provider, and repository-wide refactors unless selected host
code cannot build or remain correct without a small explicit adaptation.

## Required workflow

1. Read `ARCHITECTURE.md` sections covering host installation, provenance, and
   sync; `PROVENANCE.md`; `.agents/plan/code-mode-host-install.md`;
   `scripts/sync-code-mode-host.mjs`; `src/host-install.ts`;
   `src/installed-host.ts`; host client handshake/limits; current patch; and
   `vendor/codex/code-mode-host/provenance.json`.
2. Record current package commit, protected Codex HEAD/status, pinned source
   commit, patch baseline/hash, lock hash, provenance hash, and all existing
   unrelated workspace changes. Never edit or clean the protected Codex
   checkout. Never revert user changes.
3. Require a clean local Codex checkout at an exact reviewed 40-character
   target commit. Use:

   ```sh
   npm run sync:host -- \
     --codex /absolute/path/to/codex \
     --commit <target-commit> \
     --output /new/external/review-directory
   ```

   Output must remain outside Codex, package source, and Pi agent directory.
   Inspect `sync-report.json`, `current-vendor-to-candidate.diff`,
   `current-preimage/`, `candidate/`, and `REVIEW.txt`.
4. Investigate upstream history from current pinned commit to target commit,
   restricted first to selected roots/files. For every changed commit or
   coherent hunk, classify it as:
   - **pick**: required security, correctness, protocol, build, cancellation,
     I/O, resource-bound, or proven performance change;
   - **adapt**: relevant but needs minimal standalone/package integration;
   - **skip**: unrelated or expands scope without host benefit.

   Record exact commit, file, reason, dependencies, and evidence for every pick
   or adapt. Record concise reasons for skipped nearby changes so future agents
   can audit selection. Follow dependencies only as far as required for a
   compiling, behaviorally correct standalone host.
5. Before editing, save a repo-local plan under `.agents/plan/`. Plan must state
   selected upstream changes, rejected changes, invariants, exact files,
   migration order, expected patch/provenance changes, failure modes, and
   pre-registered validation. Get user approval if any choice changes protocol,
   limits, security posture, supported platforms, package dependencies, or
   install behavior.
6. Implement from a disposable copy or external staging directory. Never use a
   fuzzy or three-way patch. Reapply current local host changes deliberately
   against target source, resolve each conflict by understanding upstream
   behavior, and regenerate a reviewable patch against exact target baseline.
   Copy only selected complete upstream trees plus documented standalone
   scaffold. Preserve upstream crate/module/test/remote-session structure.
7. Keep local deviations minimal and explicit:
   - patched upstream trees must be byte-identical to reviewed patched staging;
   - broad `codex-protocol` stays reduced to exact required compatibility source
     unless evidence proves more is needed;
   - package adds no normal npm dependency;
   - runtime/install never reads or builds from external Codex checkout;
   - no stock-host fallback without exact required capability and limit proof;
   - V8 limits reduce accidental damage only and are never described as a
     security sandbox.
8. Regenerate standalone manifests and `Cargo.lock` only after reviewing new
   dependency needs. Refresh patch, source commit, patch baseline, patch SHA,
   lock SHA, provenance file map/classifications/sizes/hashes, TypeScript pinned
   constants, sync-script preimage constants, notices, and documentation
   together. Old installed manifest must reject incompatible source identity;
   successful new install must require `/reload`.
9. Validate cheapest-first and stop at first failure:
   - script syntax, formatting, lint, typecheck, build, package verifier, and
     `git diff --check`;
   - sync command positive and negative path/preimage cases;
   - exact provenance coverage and byte comparison against reviewed patched
     staging;
   - `cargo build --locked --release` using package source only;
   - isolated `/code-mode-host-install` with package-owned snapshot only;
   - protocol v1 handshake with exact `resource_limits_v1`;
   - process/session/cell ceiling rejection and deterministic runtime resource
     probes;
   - cancellation, child cleanup, bounded output/frame/deadline behavior,
     symlink/path rejection, atomic manifest commit, and post-commit warnings;
   - installed fallback, direct cell, nested call, disable, and cleanup;
   - package dry run includes all source/provenance/license files and no binary,
     `target`, cache, staging, sync output, or prototype artifact;
   - protected Codex HEAD/status and unrelated package changes remain exact.
10. Obtain independent read-only review for security, concurrency, process
    lifecycle, resource limits, performance, provenance, and sync safety.
    Repair every blocking finding before completion.

## Completion report

Report:

- target Codex commit and old/new patch, lock, provenance, and built-host hashes;
- picked/adapted/skipped upstream changes with exact reasons;
- files changed and local deviations retained or removed;
- exact validation commands and results;
- installed artifact platform/architecture/size;
- protected Codex and package integrity evidence;
- remaining unrun gates such as Windows, offline-first build, paid live model,
  global cell saturation, or protocol-unreachable in-flight saturation.

Do not claim completion when build/protocol/resource/provenance gates fail. Do
not commit, publish, or activate output unless user explicitly requests it.
