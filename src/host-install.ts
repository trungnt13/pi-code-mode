import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_LIMITS, type SessionLimits } from "./constants.js";
import {
	createInstalledHostManifest,
	ensureCanonicalHostInstallRoot,
	HOST_LOCK_SHA256,
	HOST_PATCH_SHA256,
	HOST_PROVENANCE_SHA256,
	HOST_RESOURCE_CAPABILITY,
	HOST_SOURCE_COMMIT,
	hostExecutableName,
} from "./installed-host.js";
import type { HostIdentity } from "./runtime/host-client.js";

export interface HostInstallResult {
	executablePath: string;
	sha256: string;
	sizeBytes: number;
	warnings: string[];
}

const STATUS_KEY = "pi-code-mode-host-install";
const DIAGNOSTIC_BYTES = 64 * 1024;
const SOURCE_FILE_BYTES = 128 * 1024 * 1024;
const PROBE_FRAME_BYTES = 16 * 1024 * 1024;
const PROBE_FRAME_COUNT = 1024;
const PROBE_SESSION_CEILING = 128;
const PROBE_OPERATION_MS = 10_000;
const PROBE_TOTAL_MS = 60_000;
const PROCESS_PROBE_TOTAL_MS = 45_000;
const TERMINATE_GRACE_MS = 2_000;
const PROBE_TEXT = "pi-code-mode host install probe";

export async function installCodeModeHost(
	context: ExtensionCommandContext,
	signal: AbortSignal,
): Promise<HostInstallResult> {
	try {
		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		const vendorRoot = join(packageRoot, "vendor", "codex", "code-mode-host");
		const sourceWorkspace = join(vendorRoot, "codex-rs");
		let lockOwned = false;
		let staging: string | undefined;
		let result: HostInstallResult | undefined;
		let failure: unknown;
		let committed = false;
		const warnings: string[] = [];
		let lockPath: string | undefined;
		try {
			throwIfAborted(signal);
			context.ui.setStatus(STATUS_KEY, "code-mode host: preparing canonical install root");
			const installRoot = await ensureCanonicalHostInstallRoot();
			lockPath = join(installRoot, ".install.lock");
			try {
				await mkdir(lockPath, { mode: 0o700 });
				lockOwned = true;
			} catch (error) {
				if (hasCode(error, "EEXIST")) {
					throw new Error(
						`Code-mode host install lock exists at ${lockPath}. Confirm no installer or Cargo process is running, then remove this lock directory manually.`,
					);
				}
				throw error;
			}
			throwIfAborted(signal);
			staging = await mkdtemp(join(installRoot, ".staging-"));
			await chmod(staging, 0o700);
			context.ui.setStatus(STATUS_KEY, "code-mode host: snapshotting and verifying package source");
			const workspace = await snapshotVendoredSource(packageRoot, vendorRoot, sourceWorkspace, staging, signal);
			const targetDirectory = join(staging, "target");
			await runCargoBuild(workspace, targetDirectory, context, signal);
			const stagedExecutable = join(targetDirectory, "release", hostExecutableName());
			const stagedIdentity = await inspectExecutable(stagedExecutable, signal);
			context.ui.setStatus(STATUS_KEY, "code-mode host: validating staged protocol");
			await probeStagedHost(stagedExecutable, signal);
			throwIfAborted(signal);
			context.ui.setStatus(STATUS_KEY, "code-mode host: publishing verified artifact");
			const executablePath = await publishExecutable(installRoot, stagedExecutable, stagedIdentity, signal);
			const identity: HostIdentity = { ...stagedIdentity, executablePath };
			throwIfAborted(signal);
			const manifestResult = await publishManifest(installRoot, createInstalledHostManifest(identity), signal);
			committed = manifestResult.committed;
			warnings.push(...manifestResult.warnings);
			result = { ...identity, warnings };
		} catch (error) {
			failure = error;
		}

		const cleanupErrors: unknown[] = [];
		if (staging) {
			try {
				await rm(staging, { recursive: true, force: true });
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (lockOwned && lockPath) {
			try {
				await rmdir(lockPath);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (failure !== undefined && committed)
			warnings.push(`Installed manifest is active, but finalization failed: ${errorMessage(failure)}`);
		if (cleanupErrors.length && committed) {
			warnings.push(
				...cleanupErrors.map((error) => `Installed manifest is active, but cleanup failed: ${errorMessage(error)}`),
			);
		}
		if (failure !== undefined && !committed) {
			if (cleanupErrors.length) {
				throw new AggregateError([failure, ...cleanupErrors], "Code-mode host install and cleanup failed");
			}
			throw failure;
		}
		if (cleanupErrors.length && !committed)
			throw new AggregateError(cleanupErrors, "Code-mode host install cleanup failed");
		if (!result) throw new Error("Code-mode host install completed without a result");
		return { ...result, warnings };
	} finally {
		context.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function snapshotVendoredSource(
	packageRoot: string,
	vendorRoot: string,
	sourceWorkspace: string,
	staging: string,
	signal: AbortSignal,
): Promise<string> {
	const provenancePath = join(vendorRoot, "provenance.json");
	const provenance = await readAndHashRegularFile(provenancePath, SOURCE_FILE_BYTES, signal, true);
	if (provenance.sha256 !== HOST_PROVENANCE_SHA256) {
		throw new Error(
			`Package-owned host provenance checksum mismatch: expected ${HOST_PROVENANCE_SHA256}, received ${provenance.sha256}`,
		);
	}
	const lock = await readAndHashRegularFile(join(sourceWorkspace, "Cargo.lock"), SOURCE_FILE_BYTES, signal);
	if (lock.sha256 !== HOST_LOCK_SHA256) {
		throw new Error(`Package-owned host lock checksum mismatch: expected ${HOST_LOCK_SHA256}, received ${lock.sha256}`);
	}
	const patch = await readAndHashRegularFile(
		join(packageRoot, "vendor", "codex", "codex-code-mode-host.patch"),
		SOURCE_FILE_BYTES,
		signal,
	);
	if (patch.sha256 !== HOST_PATCH_SHA256) {
		throw new Error(
			`Package-owned host patch checksum mismatch: expected ${HOST_PATCH_SHA256}, received ${patch.sha256}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(provenance.bytes.toString("utf8"));
	} catch (error) {
		throw new Error(`Package-owned host provenance is invalid JSON: ${errorMessage(error)}`);
	}
	const root = requireRecord(parsed, "host provenance");
	if (root.schema_version !== 1) throw new Error("Package-owned host provenance schema is incompatible");
	const source = requireRecord(root.source, "host provenance source");
	if (source.copied_checkout_commit !== HOST_SOURCE_COMMIT || source.patch_sha256 !== HOST_PATCH_SHA256) {
		throw new Error("Package-owned host provenance source identity is incompatible");
	}
	if (!Array.isArray(root.files) || root.files.length === 0) {
		throw new Error("Package-owned host provenance file map is empty");
	}
	const expectedPaths = new Set<string>();
	const expectedFiles = new Map<string, { sha256: string; sizeBytes: number }>();
	for (const item of root.files) {
		throwIfAborted(signal);
		const entry = requireRecord(item, "host provenance file entry");
		if (
			typeof entry.path !== "string" ||
			typeof entry.sha256 !== "string" ||
			!Number.isSafeInteger(entry.size_bytes) ||
			(entry.size_bytes as number) < 1
		) {
			throw new Error("Package-owned host provenance file entry is invalid");
		}
		if (expectedPaths.has(entry.path)) throw new Error(`Duplicate host provenance path: ${entry.path}`);
		expectedPaths.add(entry.path);
		const candidate = resolve(vendorRoot, entry.path);
		if (
			!isWithin(vendorRoot, candidate) ||
			!entry.path.startsWith("codex-rs/") ||
			relative(vendorRoot, candidate).replaceAll("\\", "/") !== entry.path
		) {
			throw new Error(`Host provenance path escapes workspace: ${entry.path}`);
		}
		expectedFiles.set(entry.path, { sha256: entry.sha256, sizeBytes: entry.size_bytes as number });
	}
	const snapshotVendorRoot = join(staging, "source");
	const snapshotWorkspace = join(snapshotVendorRoot, "codex-rs");
	await mkdir(snapshotWorkspace, { recursive: true, mode: 0o700 });
	for (const [entryPath, expected] of expectedFiles) {
		throwIfAborted(signal);
		const source = resolve(vendorRoot, entryPath);
		const destination = resolve(snapshotVendorRoot, entryPath);
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await copyRegularFile(source, destination, expected.sizeBytes, signal);
	}
	const actualPaths = await listWorkspaceFiles(snapshotWorkspace, snapshotVendorRoot, signal);
	if (
		actualPaths.size !== expectedPaths.size ||
		[...actualPaths].some((path) => !expectedPaths.has(path)) ||
		[...expectedPaths].some((path) => !actualPaths.has(path))
	) {
		throw new Error("Package-owned host workspace files do not match provenance map");
	}
	for (const [entryPath, expected] of expectedFiles) {
		const actual = await readAndHashRegularFile(resolve(snapshotVendorRoot, entryPath), SOURCE_FILE_BYTES, signal);
		if (actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256) {
			throw new Error(`Package-owned host snapshot mismatch: ${entryPath}`);
		}
	}
	return snapshotWorkspace;
}

async function listWorkspaceFiles(workspace: string, vendorRoot: string, signal: AbortSignal): Promise<Set<string>> {
	const files = new Set<string>();
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			throwIfAborted(signal);
			if (directory === workspace && entry.name === "target") continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Package-owned host workspace contains symlink: ${path}`);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) files.add(path.slice(vendorRoot.length + 1).replaceAll("\\", "/"));
			else throw new Error(`Package-owned host workspace contains unsupported entry: ${path}`);
		}
	};
	await visit(workspace);
	return files;
}

async function runCargoBuild(
	workspace: string,
	targetDirectory: string,
	context: ExtensionCommandContext,
	signal: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	const manifest = join(workspace, "Cargo.toml");
	const args = [
		"build",
		"--locked",
		"--release",
		"-p",
		"codex-code-mode-host",
		"--manifest-path",
		manifest,
		"--target-dir",
		targetDirectory,
	];
	const diagnostics = new BoundedTail(DIAGNOSTIC_BYTES);
	const decoder = new StringDecoder("utf8");
	let latestStatus = "starting Cargo";
	const child = spawn("cargo", args, {
		cwd: workspace,
		detached: process.platform !== "win32",
		env: { ...process.env, CARGO_TERM_COLOR: "never" },
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const onOutput = (chunk: Buffer): void => {
		diagnostics.append(chunk);
		const text = decoder.write(chunk);
		const line = text
			.split(/\r?\n/)
			.map((item) => item.trim())
			.filter(Boolean)
			.at(-1);
		if (line) latestStatus = line.slice(0, 180);
		context.ui.setStatus(STATUS_KEY, `code-mode host build: ${latestStatus}`);
	};
	child.stdout?.on("data", onOutput);
	child.stderr?.on("data", onOutput);
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const terminate = (): void => {
		terminateProcess(child, "SIGTERM");
		killTimer ??= setTimeout(() => terminateProcess(child, "SIGKILL"), TERMINATE_GRACE_MS);
	};
	signal.addEventListener("abort", terminate, { once: true });
	let outcome: { code: number | null; signal: NodeJS.Signals | null };
	try {
		outcome = await waitForChild(child);
	} catch (error) {
		if (signal.aborted) throw withDiagnostics(abortReason(signal), diagnostics.text());
		throw withDiagnostics(new Error(`Failed to start Cargo: ${errorMessage(error)}`), diagnostics.text());
	} finally {
		signal.removeEventListener("abort", terminate);
		if (killTimer) clearTimeout(killTimer);
		decoder.end();
	}
	if (signal.aborted) throw withDiagnostics(abortReason(signal), diagnostics.text());
	if (outcome.code !== 0) {
		throw withDiagnostics(
			new Error(`Cargo build failed (${outcome.code ?? outcome.signal ?? "unknown"})`),
			diagnostics.text(),
		);
	}
}

async function probeStagedHost(executable: string, signal: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const stderr = new BoundedTail(DIAGNOSTIC_BYTES);
	const child = spawn(executable, [], {
		detached: process.platform !== "win32",
		env: minimalProbeEnvironment(),
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
	const frames = decodeFrames(child);
	let totalTimer: ReturnType<typeof setTimeout> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const terminate = (): void => {
		terminateProcess(child, "SIGTERM");
		killTimer ??= setTimeout(() => terminateProcess(child, "SIGKILL"), TERMINATE_GRACE_MS);
	};
	const onAbort = (): void => terminate();
	signal.addEventListener("abort", onAbort, { once: true });
	totalTimer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, PROBE_TOTAL_MS);
	let completed = false;
	try {
		await writeFrame(child, {
			type: "connection/hello",
			supportedVersions: [1],
			requiredCapabilities: [HOST_RESOURCE_CAPABILITY],
			optionalCapabilities: [],
		});
		const hello = requireRecord(await nextFrame(frames), "host hello");
		if (
			hello.type !== "connection/ready" ||
			hello.selectedVersion !== 1 ||
			!Array.isArray(hello.capabilities) ||
			hello.capabilities.length !== 1 ||
			hello.capabilities[0] !== HOST_RESOURCE_CAPABILITY
		) {
			throw new Error("Staged code-mode host returned incompatible hello");
		}
		const processLimits = validateProcessLimits(hello.processLimits);
		const limits = boundedProbeLimits(processLimits);
		let operationId = 1;
		const sessionCeilings = [
			["maxActiveCells", "maxActiveCells"],
			["maxDelegateCalls", "maxDelegateCalls"],
			["maxCommittedStateBytes", "maxCommittedStateBytesPerSession"],
		] as const;
		for (const [sessionKey, processKey] of sessionCeilings) {
			const rejectedLimits = cloneSessionLimits(limits);
			rejectedLimits[sessionKey] = aboveCeiling(processLimits[processKey], processKey);
			await assertRejectedOperation(
				child,
				frames,
				operationId++,
				"session/open",
				{ sessionId: `install-probe-rejected-${sessionKey}`, limits: rejectedLimits },
				"session limits exceed process ceilings",
			);
		}
		for (const cellKey of cellLimitKeys()) {
			const rejectedLimits = cloneSessionLimits(limits);
			rejectedLimits.maxCellLimits[cellKey] = aboveCeiling(
				processLimits.maxCellLimits[cellKey],
				`maxCellLimits.${cellKey}`,
			);
			await assertRejectedOperation(
				child,
				frames,
				operationId++,
				"session/open",
				{ sessionId: `install-probe-rejected-${cellKey}`, limits: rejectedLimits },
				"session limits exceed process ceilings",
			);
		}

		const openId = operationId++;
		await writeFrame(child, operation(openId, "session/open", { sessionId: "install-probe", limits }));
		const opened = requireOkValue(await readOperationResponse(frames, openId), "session/open");
		if (opened.type !== "session/ready" || opened.sessionId !== "install-probe" || !jsonEqual(opened.limits, limits)) {
			throw new Error("Staged code-mode host returned invalid session limit echo");
		}

		for (const cellKey of cellLimitKeys()) {
			const rejectedCellLimits = { ...limits.maxCellLimits };
			rejectedCellLimits[cellKey] = aboveCeiling(limits.maxCellLimits[cellKey], `session ${cellKey}`);
			await assertRejectedOperation(
				child,
				frames,
				operationId++,
				"session/execute",
				{
					sessionId: "install-probe",
					request: probeExecuteRequest("text('rejected');"),
					limits: rejectedCellLimits,
				},
				"cell limits exceed session ceilings",
			);
		}

		// Saturating the global active-cell ceiling would require 128 live V8 isolates. Exact
		// process admission is exercised above; an isolated per-session concurrency probe runs below.
		await assertRuntimeResourceError(
			child,
			frames,
			operationId++,
			limits.maxCellLimits,
			`text("x".repeat(${limits.maxCellLimits.outputBytes + 1}));`,
			"output_bytes",
		);
		await assertRuntimeResourceError(
			child,
			frames,
			operationId++,
			limits.maxCellLimits,
			"setTimeout(() => {}, 1000); setTimeout(() => {}, 1000);",
			"pending_timers",
		);
		await assertRuntimeResourceError(
			child,
			frames,
			operationId++,
			limits.maxCellLimits,
			"while (true) {}",
			"wall_time_ms",
		);
		await assertRuntimeResourceError(
			child,
			frames,
			operationId++,
			limits.maxCellLimits,
			`store("probe", "x".repeat(${limits.maxCommittedStateBytes + 1}));`,
			"committed_state_bytes",
		);
		await assertRuntimeResourceError(
			child,
			frames,
			operationId++,
			limits.maxCellLimits,
			'notify("one"); notify("two");',
			"delegate_calls",
		);
		await assertRuntimeResourceError(
			child,
			frames,
			operationId++,
			limits.maxCellLimits,
			"await tools.probe({});",
			"delegate_result_bytes",
			[probeToolDefinition()],
			"x".repeat(limits.maxCellLimits.delegateResultBytes + 1),
		);
		const toolDefinitionLimits = { ...limits.maxCellLimits, toolDefinitionBytes: 32 };
		await assertRejectedOperation(
			child,
			frames,
			operationId++,
			"session/execute",
			{
				sessionId: "install-probe",
				request: probeExecuteRequest("await tools.probe({});", [probeToolDefinition()]),
				limits: toolDefinitionLimits,
			},
			"resource limit exceeded: code=resource_exhausted resource=tool_definition_bytes",
		);

		const normalId = operationId++;
		await writeFrame(
			child,
			operation(normalId, "session/execute", {
				sessionId: "install-probe",
				request: probeExecuteRequest(`text(${JSON.stringify(PROBE_TEXT)});`),
				limits: limits.maxCellLimits,
			}),
		);
		let started: Record<string, unknown> | undefined;
		let initial: Record<string, unknown> | undefined;
		for (let count = 0; count < 8 && (!started || !initial); count++) {
			const frame = requireRecord(await nextFrame(frames), "execute response");
			if (frame.type === "cell/closed") continue;
			if (frame.type === "operation/response" && frame.id === normalId) {
				started = requireOkValue(requireRecord(frame.result, "execute result"), "session/execute");
			} else if (frame.type === "execute/initialResponse" && frame.id === normalId) {
				initial = requireOkValue(requireRecord(frame.result, "initial response result"), "initial response");
			} else {
				throw new Error("Staged code-mode host returned unexpected execute frame");
			}
		}
		if (
			!started ||
			started.type !== "execution/started" ||
			typeof started.cellId !== "string" ||
			!jsonEqual(started.limits, limits.maxCellLimits)
		) {
			throw new Error("Staged code-mode host returned invalid cell limit echo");
		}
		validateInitialResponse(initial, started.cellId);

		const shutdownId = operationId++;
		await writeFrame(child, operation(shutdownId, "session/shutdown", { sessionId: "install-probe" }));
		let closed: Record<string, unknown> | undefined;
		for (let count = 0; count < 4 && !closed; count++) {
			const frame = requireRecord(await nextFrame(frames), "shutdown response");
			if (frame.type === "cell/closed") continue;
			if (frame.type !== "operation/response" || frame.id !== shutdownId) {
				throw new Error("Staged code-mode host returned unexpected shutdown frame");
			}
			closed = requireOkValue(requireRecord(frame.result, "shutdown result"), "session/shutdown");
		}
		if (!closed || closed.type !== "session/closed" || closed.sessionId !== "install-probe") {
			throw new Error("Staged code-mode host returned invalid session shutdown");
		}
		child.stdin?.end();
		const outcome = await waitForChildWithTimeout(child, PROBE_OPERATION_MS);
		if (outcome.code !== 0) {
			throw new Error(`Staged code-mode host did not exit cleanly (${outcome.code ?? outcome.signal ?? "unknown"})`);
		}
		if (stderr.text()) throw new Error(`Staged code-mode host wrote stderr:\n${stderr.text()}`);
		completed = true;
		if (totalTimer) {
			clearTimeout(totalTimer);
			totalTimer = undefined;
		}
		await probeAdvertisedProcessBounds(executable, processLimits, signal);
	} catch (error) {
		if (signal.aborted) throw withDiagnostics(abortReason(signal), stderr.text());
		if (timedOut) throw withDiagnostics(new Error("Staged code-mode host probe timed out"), stderr.text());
		throw withDiagnostics(error instanceof Error ? error : new Error(errorMessage(error)), stderr.text());
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (totalTimer) clearTimeout(totalTimer);
		if (!completed && child.exitCode === null && child.signalCode === null) {
			terminate();
			try {
				await waitForChildWithTimeout(child, TERMINATE_GRACE_MS + 1_000);
			} catch {
				terminateProcess(child, "SIGKILL");
			}
		}
		if (killTimer) clearTimeout(killTimer);
	}
}

interface IsolatedProbe {
	child: ChildProcess;
	frames: AsyncGenerator<unknown>;
	stderr: BoundedTail;
	dispose(): void;
	close(): Promise<void>;
}

async function probeAdvertisedProcessBounds(
	executable: string,
	processLimits: ProcessLimits,
	signal: AbortSignal,
): Promise<void> {
	if (processLimits.maxOpenSessions > PROBE_SESSION_CEILING) {
		throw new Error(`Staged code-mode host advertises unprobeable maxOpenSessions ${processLimits.maxOpenSessions}`);
	}
	const suiteAbort = new AbortController();
	let timedOut = false;
	const onAbort = (): void => suiteAbort.abort(abortReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	const timer = setTimeout(() => {
		timedOut = true;
		suiteAbort.abort(new Error("Staged code-mode host advertised-process probe suite timed out"));
	}, PROCESS_PROBE_TOTAL_MS);
	try {
		const suiteSignal = suiteAbort.signal;
		await probeFrameCeiling(executable, processLimits.maxFrameBytes, suiteSignal);
		await probeOpenSessionCeiling(executable, processLimits, suiteSignal);
		await probeActiveCellCeiling(executable, processLimits, suiteSignal);
		// Protocol v1 cannot hold 256 valid operations concurrently: global active cells cap at 128,
		// each cell permits one observer, and execute/wait observers cannot overlap on one cell.
		// Exact maxInFlightOperations shape/value validation remains mandatory above.
		await probeHeapCeiling(executable, processLimits, suiteSignal);
		await probeFreshNormalHost(executable, processLimits, suiteSignal);
	} catch (error) {
		if (signal.aborted) throw abortReason(signal);
		if (timedOut) {
			throw new Error("Staged code-mode host advertised-process probe suite timed out", { cause: error });
		}
		throw error;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

async function openIsolatedProbe(executable: string, signal: AbortSignal): Promise<IsolatedProbe> {
	throwIfAborted(signal);
	const stderr = new BoundedTail(DIAGNOSTIC_BYTES);
	const child = spawn(executable, [], {
		detached: process.platform !== "win32",
		env: minimalProbeEnvironment(),
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
	const frames = decodeFrames(child);
	const onAbort = (): void => {
		try {
			terminateProcess(child, "SIGTERM");
		} catch {
			// The owning probe path performs bounded termination and reports cleanup failure.
		}
	};
	const onChildError = (): void => {};
	child.on("error", onChildError);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		await writeFrame(child, {
			type: "connection/hello",
			supportedVersions: [1],
			requiredCapabilities: [HOST_RESOURCE_CAPABILITY],
			optionalCapabilities: [],
		});
		const ready = requireRecord(await nextFrame(frames), "isolated host hello");
		if (ready.type !== "connection/ready") throw new Error("Isolated staged host rejected probe hello");
	} catch (error) {
		signal.removeEventListener("abort", onAbort);
		child.removeListener("error", onChildError);
		try {
			await terminateChildBounded(child);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Isolated staged host open and cleanup failed");
		}
		throw error;
	}
	const dispose = (): void => {
		signal.removeEventListener("abort", onAbort);
		child.removeListener("error", onChildError);
	};
	return {
		child,
		frames,
		stderr,
		dispose,
		async close(): Promise<void> {
			try {
				const outcomePromise = waitForChildWithTimeout(child, PROBE_OPERATION_MS);
				child.stdin?.end();
				const outcome = await outcomePromise;
				if (outcome.code !== 0) {
					throw new Error(`Isolated staged host exited abnormally (${outcome.code ?? outcome.signal ?? "unknown"})`);
				}
				if (stderr.text()) throw new Error(`Isolated staged host wrote stderr:\n${stderr.text()}`);
			} finally {
				dispose();
			}
		},
	};
}

async function abandonIsolatedProbe(probe: IsolatedProbe): Promise<void> {
	probe.dispose();
	await terminateChildBounded(probe.child);
}

async function failIsolatedProbe(error: unknown, probe: IsolatedProbe): Promise<never> {
	try {
		await abandonIsolatedProbe(probe);
	} catch (cleanupError) {
		throw new AggregateError([error, cleanupError], "Isolated staged host probe and cleanup failed");
	}
	throw error;
}

async function probeFrameCeiling(executable: string, maximum: number, signal: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	if (maximum >= 0xffff_ffff) throw new Error("Staged code-mode host frame ceiling cannot be exceeded");
	const stderr = new BoundedTail(DIAGNOSTIC_BYTES);
	const child = spawn(executable, [], {
		detached: process.platform !== "win32",
		env: minimalProbeEnvironment(),
		shell: false,
		stdio: ["pipe", "ignore", "pipe"],
		windowsHide: true,
	});
	child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
	const onAbort = (): void => {
		try {
			terminateProcess(child, "SIGTERM");
		} catch {
			// The frame probe's finalizer performs bounded termination.
		}
	};
	const onChildError = (): void => {};
	child.on("error", onChildError);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	const header = Buffer.alloc(4);
	header.writeUInt32LE(maximum + 1);
	let completed = false;
	let failure: unknown;
	try {
		await writeBytes(child, header);
		const outcome = await waitForChildWithTimeout(child, PROBE_OPERATION_MS);
		const diagnostic = stderr.text();
		if (outcome.code === 0 || !diagnostic.includes(`frame length ${maximum + 1} exceeds ${maximum} bytes`)) {
			throw new Error("Staged code-mode host did not enforce advertised maxFrameBytes");
		}
		completed = true;
	} catch (error) {
		failure = error;
	} finally {
		signal.removeEventListener("abort", onAbort);
		child.removeListener("error", onChildError);
	}
	let cleanupFailure: unknown;
	if (!completed) {
		try {
			await terminateChildBounded(child);
		} catch (error) {
			cleanupFailure = error;
		}
	}
	if (failure !== undefined) {
		if (cleanupFailure !== undefined) {
			throw new AggregateError([failure, cleanupFailure], "Frame-ceiling probe and cleanup failed");
		}
		throw failure;
	}
	if (cleanupFailure !== undefined) throw cleanupFailure;
}

async function probeOpenSessionCeiling(
	executable: string,
	processLimits: ProcessLimits,
	signal: AbortSignal,
): Promise<void> {
	const probe = await openIsolatedProbe(executable, signal);
	const limits = boundedProbeLimits(processLimits);
	try {
		for (let index = 0; index < processLimits.maxOpenSessions; index++) {
			const id = index + 1;
			await writeFrame(probe.child, operation(id, "session/open", { sessionId: `open-ceiling-${index}`, limits }));
			requireOkValue(await readOperationResponse(probe.frames, id), "open-session ceiling");
		}
		await assertRejectedOperation(
			probe.child,
			probe.frames,
			processLimits.maxOpenSessions + 1,
			"session/open",
			{ sessionId: "open-ceiling-extra", limits },
			"too many open sessions",
		);
		for (let index = 0; index < processLimits.maxOpenSessions; index++) {
			const id = processLimits.maxOpenSessions + 2 + index;
			await writeFrame(probe.child, operation(id, "session/shutdown", { sessionId: `open-ceiling-${index}` }));
			requireOkValue(await readOperationResponse(probe.frames, id), "open-session cleanup");
		}
		await probe.close();
	} catch (error) {
		await failIsolatedProbe(error, probe);
	}
}

async function startPendingCell(probe: IsolatedProbe, limits: SessionLimits, executeId: number): Promise<string> {
	await writeFrame(probe.child, operation(executeId - 1, "session/open", { sessionId: "pending", limits }));
	requireOkValue(await readOperationResponse(probe.frames, executeId - 1), "pending session/open");
	await writeFrame(
		probe.child,
		operation(executeId, "session/execute", {
			sessionId: "pending",
			request: probeExecuteRequest("yield_control(); await new Promise(() => {});"),
			limits: limits.maxCellLimits,
		}),
	);
	let cellId: string | undefined;
	let initial = false;
	for (let count = 0; count < 4 && (!cellId || !initial); count++) {
		const frame = requireRecord(await nextFrame(probe.frames), "pending cell start");
		if (frame.type === "operation/response" && frame.id === executeId) {
			const started = requireOkValue(requireRecord(frame.result, "pending execute result"), "pending execute");
			if (typeof started.cellId !== "string") throw new Error("Pending cell omitted identity");
			cellId = started.cellId;
		} else if (frame.type === "execute/initialResponse" && frame.id === executeId) {
			requireOkValue(requireRecord(frame.result, "pending initial result"), "pending initial response");
			initial = true;
		} else {
			throw new Error("Pending cell returned unexpected frame");
		}
	}
	if (!cellId || !initial) throw new Error("Pending cell did not reach yielded state");
	return cellId;
}

async function probeActiveCellCeiling(
	executable: string,
	processLimits: ProcessLimits,
	signal: AbortSignal,
): Promise<void> {
	const probe = await openIsolatedProbe(executable, signal);
	const limits = boundedProbeLimits(processLimits);
	limits.maxActiveCells = 1;
	try {
		const cellId = await startPendingCell(probe, limits, 2);
		await assertRejectedOperation(
			probe.child,
			probe.frames,
			3,
			"session/execute",
			{
				sessionId: "pending",
				request: probeExecuteRequest("text('extra');"),
				limits: limits.maxCellLimits,
			},
			"session has too many active cells",
		);
		await writeFrame(probe.child, operation(4, "session/terminate", { sessionId: "pending", cellId }));
		requireOkValue(await readOperationResponse(probe.frames, 4), "pending cell terminate");
		await writeFrame(probe.child, operation(5, "session/shutdown", { sessionId: "pending" }));
		requireOkValue(await readOperationResponse(probe.frames, 5), "active-cell cleanup");
		await probe.close();
	} catch (error) {
		await failIsolatedProbe(error, probe);
	}
}

async function probeHeapCeiling(executable: string, processLimits: ProcessLimits, signal: AbortSignal): Promise<void> {
	const lowHeap = Math.min(8 * 1024 * 1024, processLimits.maxCellLimits.heapBytes);
	if (lowHeap >= processLimits.maxCellLimits.heapBytes) {
		throw new Error("Staged code-mode host heap ceiling is too small for differential probe");
	}
	const source = 'const values=[]; for(let i=0;i<500000;i++) values.push({i}); text("heap-ok");';
	const probe = await openIsolatedProbe(executable, signal);
	const limits = boundedProbeLimits(processLimits);
	limits.maxCellLimits.heapBytes = lowHeap;
	try {
		await writeFrame(probe.child, operation(1, "session/open", { sessionId: "heap", limits }));
		requireOkValue(await readOperationResponse(probe.frames, 1), "heap session/open");
		await writeFrame(
			probe.child,
			operation(2, "session/execute", {
				sessionId: "heap",
				request: probeExecuteRequest(source),
				limits: limits.maxCellLimits,
			}),
		);
		requireOkValue(await readOperationResponse(probe.frames, 2), "heap execute");
		const outcome = await waitForChildWithTimeout(probe.child, PROBE_OPERATION_MS);
		const diagnostic = probe.stderr.text();
		if (
			outcome.code === 0 ||
			(!diagnostic.includes("JavaScript heap out of memory") && !diagnostic.includes("Reached heap limit"))
		) {
			throw new Error("Staged code-mode host low-heap process lacked heap-specific exhaustion evidence");
		}
		probe.dispose();
	} catch (error) {
		await failIsolatedProbe(error, probe);
	}
	await executeIsolatedResult(executable, processLimits, source, "heap-ok", signal);
}

async function probeFreshNormalHost(
	executable: string,
	processLimits: ProcessLimits,
	signal: AbortSignal,
): Promise<void> {
	await executeIsolatedResult(executable, processLimits, `text(${JSON.stringify(PROBE_TEXT)});`, PROBE_TEXT, signal);
}

async function executeIsolatedResult(
	executable: string,
	processLimits: ProcessLimits,
	source: string,
	expectedText: string,
	signal: AbortSignal,
): Promise<void> {
	const probe = await openIsolatedProbe(executable, signal);
	const limits = boundedProbeLimits(processLimits);
	limits.maxCellLimits.heapBytes = processLimits.maxCellLimits.heapBytes;
	try {
		await writeFrame(probe.child, operation(1, "session/open", { sessionId: "normal", limits }));
		requireOkValue(await readOperationResponse(probe.frames, 1), "isolated normal session/open");
		await writeFrame(
			probe.child,
			operation(2, "session/execute", {
				sessionId: "normal",
				request: probeExecuteRequest(source),
				limits: limits.maxCellLimits,
			}),
		);
		let initial: Record<string, unknown> | undefined;
		for (let count = 0; count < 4 && !initial; count++) {
			const frame = requireRecord(await nextFrame(probe.frames), "isolated normal execute");
			if (frame.type === "cell/closed") continue;
			if (frame.type === "operation/response" && frame.id === 2) {
				requireOkValue(requireRecord(frame.result, "isolated execute result"), "isolated execute");
			} else if (frame.type === "execute/initialResponse" && frame.id === 2) {
				initial = requireOkValue(requireRecord(frame.result, "isolated initial result"), "isolated initial");
			}
		}
		const result = requireRecord(initial?.Result, "isolated normal result");
		if (result.error_text !== null || !jsonEqual(result.content_items, [{ type: "input_text", text: expectedText }])) {
			throw new Error("Isolated staged host normal execution failed");
		}
		await writeFrame(probe.child, operation(3, "session/shutdown", { sessionId: "normal" }));
		requireOkValue(await readOperationResponse(probe.frames, 3), "isolated normal shutdown");
		await probe.close();
	} catch (error) {
		await failIsolatedProbe(error, probe);
	}
}

async function publishExecutable(
	installRoot: string,
	stagedExecutable: string,
	identity: Omit<HostIdentity, "executablePath">,
	signal: AbortSignal,
): Promise<string> {
	throwIfAborted(signal);
	const hostsRoot = join(installRoot, "hosts");
	try {
		await mkdir(hostsRoot, { mode: 0o700 });
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error;
	}
	const hostsInfo = await lstat(hostsRoot);
	if (!hostsInfo.isDirectory() || hostsInfo.isSymbolicLink()) {
		throw new Error("Code-mode host store must be a real directory");
	}
	const canonicalHostsRoot = await realpath(hostsRoot);
	if (canonicalHostsRoot !== hostsRoot) throw new Error("Code-mode host store path is redirected");
	const contentDirectory = join(canonicalHostsRoot, identity.sha256);
	const executable = join(contentDirectory, hostExecutableName());
	if (await pathExists(contentDirectory)) {
		await validatePublishedExecutable(contentDirectory, executable, identity);
		return executable;
	}
	const temporaryDirectory = join(canonicalHostsRoot, `.publish-${randomUUID()}`);
	await mkdir(temporaryDirectory, { mode: 0o700 });
	const temporaryExecutable = join(temporaryDirectory, hostExecutableName());
	let published = false;
	try {
		const source = await open(stagedExecutable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const destination = await open(
			temporaryExecutable,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			0o600,
		);
		try {
			await copyHandle(source, destination, identity.sizeBytes, signal);
			await destination.chmod(0o700);
			await destination.sync();
		} finally {
			await destination.close();
			await source.close();
		}
		await syncDirectory(temporaryDirectory);
		throwIfAborted(signal);
		try {
			await rename(temporaryDirectory, contentDirectory);
			published = true;
		} catch (error) {
			if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) throw error;
			await validatePublishedExecutable(contentDirectory, executable, identity);
		}
		await syncDirectory(canonicalHostsRoot);
		await validatePublishedExecutable(contentDirectory, executable, identity);
		return executable;
	} finally {
		if (!published) await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function publishManifest(
	installRoot: string,
	manifest: ReturnType<typeof createInstalledHostManifest>,
	signal: AbortSignal,
): Promise<{ committed: boolean; warnings: string[] }> {
	throwIfAborted(signal);
	const temporary = join(installRoot, `.current-${randomUUID()}.json`);
	const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	let handleOpen = true;
	let renamed = false;
	let failure: unknown;
	try {
		await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handleOpen = false;
		await syncDirectory(installRoot);
		throwIfAborted(signal);
		await rename(temporary, join(installRoot, "current.json"));
		renamed = true;
		await syncDirectory(installRoot);
	} catch (error) {
		failure = error;
	}
	const cleanupErrors: unknown[] = [];
	if (handleOpen) {
		try {
			await handle.close();
		} catch (error) {
			if (!hasCode(error, "EBADF")) cleanupErrors.push(error);
		}
	}
	if (!renamed) {
		try {
			await rm(temporary, { force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	if (failure !== undefined) {
		if (renamed) {
			return {
				committed: true,
				warnings: [`Installed manifest is active, but directory durability sync failed: ${errorMessage(failure)}`],
			};
		}
		if (cleanupErrors.length) {
			throw new AggregateError([failure, ...cleanupErrors], "Code-mode host manifest publish and cleanup failed");
		}
		throw failure;
	}
	if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Code-mode host manifest cleanup failed");
	return { committed: true, warnings: [] };
}

async function validatePublishedExecutable(
	contentDirectory: string,
	executable: string,
	identity: Omit<HostIdentity, "executablePath">,
): Promise<void> {
	const canonicalDirectory = await realpath(contentDirectory);
	if (canonicalDirectory !== contentDirectory) throw new Error("Existing code-mode host content path is not canonical");
	const entries = await readdir(contentDirectory);
	if (entries.length !== 1 || entries[0] !== hostExecutableName()) {
		throw new Error("Existing code-mode host content directory has unexpected entries");
	}
	const actual = await inspectExecutable(executable);
	if (
		actual.sha256 !== identity.sha256 ||
		actual.sizeBytes !== identity.sizeBytes ||
		actual.platform !== identity.platform ||
		actual.architecture !== identity.architecture
	) {
		throw new Error("Existing code-mode host content identity mismatch");
	}
}

async function inspectExecutable(path: string, signal?: AbortSignal): Promise<Omit<HostIdentity, "executablePath">> {
	if (signal) throwIfAborted(signal);
	const canonical = await realpath(path);
	if (canonical !== path) throw new Error("Code-mode host executable path is not canonical");
	const file = await readAndHashRegularFile(path, Number.MAX_SAFE_INTEGER, signal);
	if (process.platform !== "win32" && (file.mode & 0o111) === 0) {
		throw new Error("Code-mode host executable lacks execute mode");
	}
	return {
		sha256: file.sha256,
		sizeBytes: file.sizeBytes,
		platform: process.platform,
		architecture: process.arch,
	};
}

async function readAndHashRegularFile(
	path: string,
	maximumBytes: number,
	signal?: AbortSignal,
	includeBytes = false,
): Promise<{ bytes: Buffer; sha256: string; sizeBytes: number; mode: number }> {
	if (signal) throwIfAborted(signal);
	const canonical = await realpath(path);
	if (canonical !== path) throw new Error(`Expected canonical regular file: ${path}`);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`Expected regular file: ${path}`);
		if (info.size < 1 || info.size > maximumBytes) throw new Error(`File has invalid size: ${path}`);
		const hash = createHash("sha256");
		const chunks: Buffer[] = [];
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let total = 0;
		for (;;) {
			if (signal) throwIfAborted(signal);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > info.size) throw new Error(`File grew while hashing: ${path}`);
			const chunk = buffer.subarray(0, bytesRead);
			if (includeBytes) chunks.push(Buffer.from(chunk));
			hash.update(chunk);
		}
		if (total !== info.size) throw new Error(`File changed while hashing: ${path}`);
		return {
			bytes: includeBytes ? Buffer.concat(chunks, total) : Buffer.alloc(0),
			sha256: hash.digest("hex"),
			sizeBytes: total,
			mode: info.mode,
		};
	} finally {
		await handle.close();
	}
}

async function copyHandle(
	source: Awaited<ReturnType<typeof open>>,
	destination: Awaited<ReturnType<typeof open>>,
	expectedBytes: number,
	signal: AbortSignal,
): Promise<void> {
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let total = 0;
	for (;;) {
		throwIfAborted(signal);
		const { bytesRead } = await source.read(buffer, 0, buffer.length, total);
		if (bytesRead === 0) break;
		let written = 0;
		while (written < bytesRead) {
			const result = await destination.write(buffer, written, bytesRead - written, total + written);
			if (result.bytesWritten === 0) throw new Error("Code-mode host publish write made no progress");
			written += result.bytesWritten;
		}
		total += bytesRead;
		if (total > expectedBytes) throw new Error("Code-mode host changed while publishing");
	}
	if (total !== expectedBytes) throw new Error("Code-mode host size changed while publishing");
}

async function copyRegularFile(
	sourcePath: string,
	destinationPath: string,
	expectedBytes: number,
	signal: AbortSignal,
): Promise<void> {
	const canonical = await realpath(sourcePath);
	if (canonical !== sourcePath) throw new Error(`Expected canonical package-owned source file: ${sourcePath}`);
	const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	const destination = await open(destinationPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		const info = await source.stat();
		if (!info.isFile() || info.size !== expectedBytes) {
			throw new Error(`Package-owned host source size mismatch while snapshotting: ${sourcePath}`);
		}
		await copyHandle(source, destination, expectedBytes, signal);
		await destination.sync();
	} finally {
		await destination.close();
		await source.close();
	}
}

async function* decodeFrames(child: ChildProcess): AsyncGenerator<unknown> {
	if (!child.stdout) throw new Error("Staged code-mode host stdout is unavailable");
	let buffered = Buffer.alloc(0);
	let count = 0;
	for await (const chunk of child.stdout) {
		buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
		if (buffered.length > PROBE_FRAME_BYTES + 4) throw new Error("Staged code-mode host output exceeds frame bound");
		while (buffered.length >= 4) {
			const length = buffered.readUInt32LE(0);
			if (length > PROBE_FRAME_BYTES) throw new Error("Staged code-mode host frame exceeds probe bound");
			if (buffered.length < length + 4) break;
			count++;
			if (count > PROBE_FRAME_COUNT) throw new Error("Staged code-mode host emitted too many probe frames");
			const payload = buffered.subarray(4, length + 4);
			buffered = buffered.subarray(length + 4);
			try {
				yield JSON.parse(payload.toString("utf8"));
			} catch (error) {
				throw new Error(`Staged code-mode host emitted invalid JSON: ${errorMessage(error)}`);
			}
		}
	}
	if (buffered.length) throw new Error("Staged code-mode host closed with truncated frame");
}

async function nextFrame(frames: AsyncGenerator<unknown>): Promise<unknown> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			frames.next(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Staged code-mode host response timed out")), PROBE_OPERATION_MS);
			}),
		]);
		if (result.done) throw new Error("Staged code-mode host closed before probe completed");
		return result.value;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function writeFrame(child: ChildProcess, value: unknown): Promise<void> {
	if (!child.stdin) throw new Error("Staged code-mode host stdin is unavailable");
	const payload = Buffer.from(JSON.stringify(value));
	if (payload.length > PROBE_FRAME_BYTES) throw new Error("Code-mode host probe request exceeds frame bound");
	const frame = Buffer.allocUnsafe(payload.length + 4);
	frame.writeUInt32LE(payload.length, 0);
	payload.copy(frame, 4);
	await new Promise<void>((resolveWrite, rejectWrite) => {
		child.stdin?.write(frame, (error) => (error ? rejectWrite(error) : resolveWrite()));
	});
}

async function writeBytes(child: ChildProcess, bytes: Buffer): Promise<void> {
	if (!child.stdin) throw new Error("Staged code-mode host stdin is unavailable");
	await new Promise<void>((resolveWrite, rejectWrite) => {
		child.stdin?.write(bytes, (error) => (error ? rejectWrite(error) : resolveWrite()));
	});
}

function operation(id: number, method: string, fields: Record<string, unknown>): Record<string, unknown> {
	return { type: "operation/request", id, request: { method, ...fields } };
}

async function readOperationResponse(frames: AsyncGenerator<unknown>, id: number): Promise<Record<string, unknown>> {
	for (let count = 0; count < 4; count++) {
		const frame = requireRecord(await nextFrame(frames), "operation response");
		if (frame.type === "cell/closed") continue;
		if (frame.type !== "operation/response" || frame.id !== id) {
			throw new Error(
				`Staged code-mode host returned unexpected operation response for ${id}: ${JSON.stringify(frame)}`,
			);
		}
		return requireRecord(frame.result, "operation result");
	}
	throw new Error(`Staged code-mode host omitted operation response for ${id}`);
}

function requireOkValue(result: Record<string, unknown>, operationName: string): Record<string, unknown> {
	if (result.status !== "ok") throw new Error(`Staged code-mode host rejected ${operationName}`);
	return requireRecord(result.value, `${operationName} value`);
}

type CellLimitKey = keyof SessionLimits["maxCellLimits"];
type ProcessLimits = {
	maxActiveCells: number;
	maxCellLimits: Record<CellLimitKey, number>;
	maxCommittedStateBytesPerSession: number;
	maxDelegateCalls: number;
	maxFrameBytes: number;
	maxInFlightOperations: number;
	maxOpenSessions: number;
};

function validateProcessLimits(value: unknown): ProcessLimits {
	const processLimits = requireRecord(value, "process limits");
	const expected = [
		"maxActiveCells",
		"maxCellLimits",
		"maxCommittedStateBytesPerSession",
		"maxDelegateCalls",
		"maxFrameBytes",
		"maxInFlightOperations",
		"maxOpenSessions",
	];
	if (!exactKeys(processLimits, expected)) throw new Error("Staged code-mode host returned malformed process limits");
	const cell = requireRecord(processLimits.maxCellLimits, "process cell limits");
	if (
		!exactKeys(cell, [
			"delegateResultBytes",
			"heapBytes",
			"outputBytes",
			"pendingTimers",
			"toolDefinitionBytes",
			"wallTimeMs",
		])
	) {
		throw new Error("Staged code-mode host returned malformed process cell limits");
	}
	for (const [key, item] of Object.entries(processLimits)) {
		if (key === "maxCellLimits") continue;
		requirePositiveInteger(item, `process limit ${key}`);
	}
	for (const [key, item] of Object.entries(cell)) requirePositiveInteger(item, `process cell limit ${key}`);
	return processLimits as unknown as ProcessLimits;
}

function boundedProbeLimits(processLimits: ProcessLimits): SessionLimits {
	return {
		maxActiveCells: Math.min(processLimits.maxActiveCells, 1),
		maxDelegateCalls: Math.min(processLimits.maxDelegateCalls, 1),
		maxCommittedStateBytes: Math.min(processLimits.maxCommittedStateBytesPerSession, 64),
		maxCellLimits: {
			heapBytes: Math.min(processLimits.maxCellLimits.heapBytes, DEFAULT_SESSION_LIMITS.maxCellLimits.heapBytes),
			wallTimeMs: Math.min(processLimits.maxCellLimits.wallTimeMs, 50),
			pendingTimers: Math.min(processLimits.maxCellLimits.pendingTimers, 1),
			outputBytes: Math.min(processLimits.maxCellLimits.outputBytes, 64),
			delegateResultBytes: Math.min(processLimits.maxCellLimits.delegateResultBytes, 64),
			toolDefinitionBytes: Math.min(processLimits.maxCellLimits.toolDefinitionBytes, 512),
		},
	};
}

function cellLimitKeys(): CellLimitKey[] {
	return ["heapBytes", "wallTimeMs", "pendingTimers", "outputBytes", "delegateResultBytes", "toolDefinitionBytes"];
}

function aboveCeiling(ceiling: number, label: string): number {
	if (ceiling >= 0xffff_ffff) throw new Error(`Staged code-mode host ${label} ceiling cannot be exceeded by probe`);
	return ceiling + 1;
}

async function assertRejectedOperation(
	child: ChildProcess,
	frames: AsyncGenerator<unknown>,
	id: number,
	method: string,
	fields: Record<string, unknown>,
	expectedMessage: string,
): Promise<void> {
	await writeFrame(child, operation(id, method, fields));
	const rejected = await readOperationResponse(frames, id);
	if (
		rejected.status !== "error" ||
		typeof rejected.message !== "string" ||
		!rejected.message.includes(expectedMessage)
	) {
		throw new Error(`Staged code-mode host did not reject ${method} with ${expectedMessage}`);
	}
}

function probeExecuteRequest(source: string, enabledTools: unknown[] = []): Record<string, unknown> {
	return {
		tool_call_id: `install-probe-call-${randomUUID()}`,
		enabled_tools: enabledTools,
		source,
		yield_time_ms: 10_000,
		max_output_tokens: 100,
	};
}

function probeToolDefinition(): Record<string, unknown> {
	return {
		name: "probe",
		tool_name: { name: "probe", namespace: null },
		description: "Installer resource enforcement probe",
		kind: "function",
		input_schema: { type: "object", properties: {}, additionalProperties: false },
		output_schema: null,
	};
}

async function assertRuntimeResourceError(
	child: ChildProcess,
	frames: AsyncGenerator<unknown>,
	id: number,
	limits: SessionLimits["maxCellLimits"],
	source: string,
	resource: string,
	enabledTools: unknown[] = [],
	delegateResult: unknown = { type: "notification/delivered" },
): Promise<void> {
	await writeFrame(
		child,
		operation(id, "session/execute", {
			sessionId: "install-probe",
			request: probeExecuteRequest(source, enabledTools),
			limits,
		}),
	);
	let started = false;
	for (let count = 0; count < 16; count++) {
		const frame = requireRecord(await nextFrame(frames), `runtime ${resource} response`);
		if (frame.type === "cell/closed" || frame.type === "delegate/cancel") continue;
		if (frame.type === "delegate/request") {
			const request = requireRecord(frame.request, "probe delegate request");
			const value =
				request.type === "notification/send"
					? { type: "notification/delivered" }
					: { type: "tool/result", result: delegateResult };
			await writeFrame(child, { type: "delegate/response", id: frame.id, result: { status: "ok", value } });
			continue;
		}
		if (frame.type === "operation/response" && frame.id === id) {
			requireOkValue(requireRecord(frame.result, "runtime execute result"), "session/execute");
			started = true;
			continue;
		}
		if (frame.type === "execute/initialResponse" && frame.id === id) {
			const initial = requireOkValue(requireRecord(frame.result, "runtime initial result"), "initial response");
			const result = requireRecord(initial.Result, "runtime result");
			if (
				!started ||
				typeof result.error_text !== "string" ||
				!result.error_text.includes(`code=resource_exhausted resource=${resource}`)
			) {
				throw new Error(`Staged code-mode host did not enforce runtime ${resource}: ${String(result.error_text)}`);
			}
			return;
		}
		throw new Error(`Staged code-mode host returned unexpected runtime ${resource} frame`);
	}
	throw new Error(`Staged code-mode host omitted runtime ${resource} result`);
}

function validateInitialResponse(initial: Record<string, unknown> | undefined, cellId: string): void {
	if (!initial || !exactKeys(initial, ["Result"])) {
		throw new Error("Staged code-mode host returned invalid initial response");
	}
	const result = requireRecord(initial.Result, "initial result");
	if (result.cell_id !== cellId || result.error_text !== null || !Array.isArray(result.content_items)) {
		throw new Error("Staged code-mode host returned invalid execution result identity");
	}
	if (
		result.content_items.length !== 1 ||
		!jsonEqual(result.content_items[0], { type: "input_text", text: PROBE_TEXT })
	) {
		throw new Error("Staged code-mode host returned unexpected execution output");
	}
}

function cloneSessionLimits(value: SessionLimits): SessionLimits {
	return { ...value, maxCellLimits: { ...value.maxCellLimits } };
}

function minimalProbeEnvironment(): NodeJS.ProcessEnv {
	const temporaryDirectory = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
		return {
			SystemRoot: systemRoot,
			PATH: `${systemRoot}\\System32`,
			...(temporaryDirectory ? { TEMP: temporaryDirectory, TMP: temporaryDirectory } : {}),
		};
	}
	return {
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		...(temporaryDirectory ? { TMPDIR: temporaryDirectory } : {}),
	};
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if (!hasCode(error, "ESRCH")) throw error;
	}
}

async function waitForChild(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode };
	}
	return await new Promise((resolveChild, rejectChild) => {
		child.once("error", rejectChild);
		child.once("close", (code, signal) => resolveChild({ code, signal }));
	});
}

async function waitForChildWithTimeout(
	child: ChildProcess,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			waitForChild(child),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Child process exit timed out")), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function terminateChildBounded(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	terminateProcess(child, "SIGTERM");
	try {
		await waitForChildWithTimeout(child, TERMINATE_GRACE_MS);
		return;
	} catch {
		terminateProcess(child, "SIGKILL");
	}
	await waitForChildWithTimeout(child, TERMINATE_GRACE_MS);
}

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(directory, constants.O_RDONLY);
	try {
		await handle.sync();
	} catch (error) {
		if (!hasCode(error, "EINVAL") && !hasCode(error, "ENOTSUP") && !hasCode(error, "EBADF")) throw error;
	} finally {
		await handle.close();
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await realpath(path);
		return true;
	} catch (error) {
		if (hasCode(error, "ENOENT")) return false;
		throw error;
	}
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function requirePositiveInteger(value: unknown, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
}

function jsonEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isWithin(root: string, path: string): boolean {
	return path.startsWith(`${root}/`) || (process.platform === "win32" && path.startsWith(`${root}\\`));
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Code-mode host install cancelled");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function withDiagnostics(error: Error, diagnostics: string): Error {
	return diagnostics ? new Error(`${error.message}\nBounded diagnostics:\n${diagnostics}`) : error;
}

class BoundedTail {
	private bytes = Buffer.alloc(0);

	constructor(private readonly maximumBytes: number) {}

	append(chunk: Buffer): void {
		this.bytes = Buffer.concat([this.bytes, chunk]).subarray(-this.maximumBytes);
	}

	text(): string {
		return this.bytes.toString("utf8").trim();
	}
}
