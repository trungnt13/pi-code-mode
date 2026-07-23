# Fix remote GitHub installation

## Objective

Make `pi install git:github.com/trungnt13/pi-code-mode` install a valid source-first Pi extension from a clean GitHub clone, without committed build output or install-time compilation.

Success means:

- Pi manifest points to tracked TypeScript source;
- clean remote clone loads directly through Pi's Jiti TypeScript loader;
- installed extension registers `/code-mode`;
- lazy runtime modules resolve from source when code mode is enabled;
- CI exercises Pi's actual Git package flow;
- `dist/` remains ignored and uncommitted.

## Verified current state and root cause

- `package.json` declares Pi entrypoint `./dist/index.js` (`package.json:32-35`).
- `.gitignore` intentionally excludes `dist/` (`.gitignore:2`), and `origin/main` contains no `dist/` files.
- Therefore Pi clones package successfully but cannot find declared extension entrypoint.
- Pi documentation states TypeScript extensions are loaded through Jiti; compilation is not required for extension loading.
- Other installed Pi packages, including `pi-btw`, `pi-multi-agent-v2`, and `pi-cursor-sdk`, declare `./src/index.ts` directly.
- Direct proof in this repository passed:
  - `pi --mode rpc --no-session --no-extensions -e ./src/index.ts` loaded without stderr;
  - RPC `get_commands` returned extension command `code-mode` sourced from `src/index.ts`;
  - RPC prompt `/code-mode status` succeeded and reported `code-mode: off; tools: unclaimed`.
- Jiti successfully resolves existing source imports written with `.js` specifiers, including the lazy import of `./runtime/extension.js` when sourced from TypeScript.

## Chosen approach

Convert package metadata from compiled-library packaging to normal Pi source-extension packaging:

- set `pi.extensions` to `./src/index.ts`;
- keep `dist/` ignored and untracked;
- remove package fields that claim missing compiled Node entrypoints (`main`, `types`, and `exports`);
- make package payload describe tracked source instead of `dist/`;
- retain TypeScript build/typecheck only as developer validation, not installation behavior.

Do not commit generated output. Do not add `prepare`, `postinstall`, or other install-time compilation.

## Affected files

- `package.json` — point Pi at source; remove invalid compiled-library entrypoints; include source in package metadata; add validation scripts.
- `package-lock.json` — synchronize root package metadata if npm updates it.
- `scripts/verify-pi-package.mjs` — deterministic source-package and Pi RPC verifier.
- `.github/workflows/ci.yml` — validate direct source loading and isolated Git installation.
- `README.md` — document GitHub install as primary flow and clarify source-first packaging.
- `.gitignore` — no change expected; `dist/` must remain ignored.

## Implementation steps

1. **Fix Pi package manifest**
   - Change `pi.extensions` from `./dist/index.js` to `./src/index.ts`.
   - Remove `main`, `types`, and `exports` because their targets are intentionally absent from Git package.
   - Change `files` entry from `dist` to `src`; retain vendor and documentation files.
   - Keep Pi core modules in `peerDependencies` as required by Pi package guidance.
   - Keep build output as local developer output only.

2. **Align documented API with package role**
   - Remove or rewrite `import { createCodeModeExtension } from "pi-code-mode"` guidance because package will no longer claim to be a directly importable compiled Node library.
   - Keep `createCodeModeExtension` exported from `src/index.ts` for source-aware Pi composition if useful, documenting an explicit source path only if there is a real supported use case.
   - Treat npm library publication as separate future work requiring a proper publish build, not part of Git-based Pi installation.

3. **Add reusable package verifier**
   - Read `package.json` and assert every `pi.extensions` path exists, is tracked, and ends in supported `.ts` or `.js` extension.
   - Assert manifest has no `main`, `types`, or export target pointing to absent files.
   - Assert `dist/` remains ignored and no `dist/**` file is tracked.
   - Run `npm pack --dry-run --json --ignore-scripts`; assert payload includes `src/index.ts`, all source modules required by it, vendor patch/licenses, README, and license.
   - Launch `src/index.ts` with local Pi in isolated RPC mode using `--offline --no-session --no-extensions`.
   - Send `get_commands`; assert extension command `code-mode` is registered from `src/index.ts`.
   - Send `/code-mode status`; assert success and off/unclaimed notification.
   - Exercise `/code-mode on` without host configuration and assert it reaches expected host-identity validation rather than failing with `Code-mode runtime load failed`; this proves lazy runtime source imports resolve without claiming tools or spawning host.
   - Bound subprocess runtime and include stdout/stderr on failures.

4. **Wire validation scripts**
   - Add `verify:package` for package verifier.
   - Add aggregate `check` running lint, typecheck, and package verification.
   - Keep `build` available for local emit inspection but exclude it from installation and package validity requirements.

5. **Add clean-checkout CI**
   - Use Node `22.19.x` and `npm ci`.
   - Run `npm run check` from fresh checkout.
   - Create isolated `PI_CODING_AGENT_DIR`.
   - Run Pi install through a local `file://` Git URL for checked-out repository, exercising Git clone/package discovery rather than `-e` alone.
   - Start Pi RPC with isolated settings and no unrelated extensions, then assert installed package exposes `/code-mode` and status works.
   - Keep smoke test offline and avoid any model request or host process startup.

6. **Update installation documentation**
   - Primary command: `pi install git:github.com/trungnt13/pi-code-mode`.
   - Optional pinned command using commit or tag ref.
   - State no manual `npm install` or `npm run build` is required for Pi installation.
   - Explain extension starts off and `/code-mode status` works immediately.
   - Keep host build and five identity environment variables as separate prerequisites for `/code-mode on`.
   - Retain local development commands under contributor instructions.

7. **Final verification and remote handoff**
   - Confirm final diff contains no `dist/` files.
   - Run aggregate checks.
   - Run isolated Pi Git-install smoke test.
   - Inspect package dry-run contents for complete source tree and no caches, credentials, host binary, or `node_modules`.
   - After commit is pushed, run real network smoke test with `pi install git:github.com/trungnt13/pi-code-mode@<commit-or-tag>` in isolated config.

## Validation and acceptance checks

1. `package.json` declares `"pi": { "extensions": ["./src/index.ts"] }`.
2. `git ls-files src/index.ts` succeeds.
3. `git check-ignore dist/index.js` confirms `dist/` stays ignored.
4. `git ls-files 'dist/**'` returns nothing.
5. `npm ci` succeeds on Node 22.19.x.
6. `npm run lint` passes.
7. `npm run typecheck` passes.
8. Package verifier confirms complete source payload and no dangling manifest entrypoints.
9. Direct Pi RPC source load registers `/code-mode`; status succeeds.
10. Lazy runtime import reaches host validation without runtime-load failure.
11. Isolated `pi install` through Git URL loads installed package and registers `/code-mode`.
12. Real GitHub install at pushed commit/tag repeats check 11.

## Risks and edge cases

- `.js` specifiers inside TypeScript depend on Pi/Jiti resolution. Direct tests already prove facade loading; verifier must also cover lazy runtime import to prevent regressions.
- Removing compiled package exports means ordinary Node consumers cannot use `import ... from "pi-code-mode"`. That is intentional for a Pi extension package; npm-library support would require a separate release design.
- Successful extension installation does not provide required native host binary. README must keep installation and host provisioning distinct.
- Pi compatibility remains pinned to current `0.81.1` development dependencies. Broader compatibility is outside this packaging fix.
- Implementation must not push, tag, publish, or modify user Pi settings unless separately requested. Real GitHub smoke test remains pending until changes are pushed.

## Assumptions

- Repository is primarily a Pi package, not a general Node library.
- GitHub repository remains `github.com/trungnt13/pi-code-mode`.
- Pi's supported TypeScript/Jiti loading behavior is part of target runtime contract.

## Completion note

Implemented on July 23, 2026. Package now loads `src/index.ts` directly, compiled entrypoint metadata is removed, README documents GitHub installation, and CI/verifier cover direct source loading, lazy runtime resolution, clean-clone installation, and pushed GitHub commit installation. Local lint, typecheck, build, package verification, `npm ci`, and isolated clean-clone install checks passed. Real GitHub install remains pending until these changes are committed and pushed.
