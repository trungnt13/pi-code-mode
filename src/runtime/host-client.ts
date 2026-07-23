import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { chmod, type FileHandle, mkdtemp, open, realpath, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HOST_CANCEL_GRACE_MS, HOST_CLOSE_MS, HOST_HANDSHAKE_MS, HOST_MAX_PENDING_OPERATIONS } from "../constants.js";
import { encodeFrame, FrameDecoder } from "./frame-codec.js";
import {
	asRecord,
	assertProcessSupports,
	equalLimits,
	type ProcessLimits,
	parseRuntimeResponse,
	type RuntimeResponse,
	type SessionLimits,
} from "./protocol.js";

export { HOST_CANCEL_GRACE_MS, HOST_CLOSE_MS, HOST_HANDSHAKE_MS, HOST_MAX_PENDING_OPERATIONS };
const STDERR_BYTES = 64 * 1024;
const DELEGATE_GAP_LIMIT = 4096;
const DELEGATE_ERROR_BYTES = 1024;
const DELEGATE_ENCODING_ERROR = "Code-mode delegate result could not be encoded within protocol limits";
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
type HandshakeOutcome = { error?: Error };
type SessionRegistration = {
	delegate: DelegateHandler;
	cellClosed(cellId: string): void;
	generationLost(error: Error): void;
	maxDelegateCalls: number;
	inFlightDelegates: number;
};
type ExecutePending = {
	sessionId: string;
	limits: SessionLimits["maxCellLimits"];
	onStarted?: (cellId: string) => void;
	startedCellId?: string;
	started: Pending;
	initial: Pending;
};
export type DelegateHandler = (request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

type CreationSlot = { promise: Promise<HostGeneration>; abort: AbortController; waiters: Set<object> };
let generations: Map<string, HostGeneration> | undefined;
let creating: Map<string, CreationSlot> | undefined;

export interface HostIdentity {
	executablePath: string;
	sha256: string;
	sizeBytes: number;
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
}

export interface HostMetrics {
	requests: number;
	delegates: number;
	framesRead: number;
	framesWritten: number;
	bytesRead: number;
	bytesWritten: number;
	childPid?: number;
}

async function pinHost(
	identity: HostIdentity,
	signal: AbortSignal,
): Promise<{ directory: string; executable: string }> {
	const source = await openValidatedSource(identity, signal);
	let directory: string;
	try {
		directory = await mkdtemp(join(tmpdir(), "pi-code-mode-host-"));
	} catch (error) {
		try {
			await source.close();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Code-mode host temp-directory creation and cleanup failed");
		}
		throw error;
	}
	const executable = join(directory, "host");
	let target: FileHandle | undefined;
	try {
		await chmod(directory, 0o700);
		target = await open(executable, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		const hash = createHash("sha256");
		let total = 0;
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			throwIfAborted(signal);
			const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, total);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			total += bytesRead;
			if (total > identity.sizeBytes)
				throw new Error(`Code-mode host size mismatch: expected ${identity.sizeBytes}, received more bytes`);
			hash.update(chunk);
			let written = 0;
			while (written < chunk.byteLength) written += (await target.write(chunk, written)).bytesWritten;
		}
		throwIfAborted(signal);
		if (total !== identity.sizeBytes)
			throw new Error(`Code-mode host size mismatch: expected ${identity.sizeBytes}, received ${total}`);
		const actual = hash.digest("hex");
		if (actual.toLowerCase() !== identity.sha256.toLowerCase())
			throw new Error(`Code-mode host checksum mismatch: expected ${identity.sha256}, received ${actual}`);
		await target.sync();
		await chmod(executable, 0o700);
		await target.close();
		target = undefined;
		await syncDirectory(directory);
		await source.close();
		return { directory, executable };
	} catch (error) {
		const errors: unknown[] = [error];
		try {
			await target?.close();
		} catch (cleanup) {
			errors.push(cleanup);
		}
		try {
			await source.close();
		} catch (cleanup) {
			errors.push(cleanup);
		}
		errors.push(...(await removePrivateCopy(directory, executable)));
		if (errors.length === 1) throw error;
		throw new AggregateError(errors, "Code-mode host pinning and cleanup failed");
	}
}

export async function validateHostIdentity(identity: HostIdentity, signal?: AbortSignal): Promise<void> {
	const source = await openValidatedSource(identity, signal);
	await source.close();
}

async function openValidatedSource(identity: HostIdentity, signal?: AbortSignal): Promise<FileHandle> {
	throwIfAborted(signal);
	assertHostPlatform(identity);
	if (!/^[a-f\d]{64}$/.test(identity.sha256))
		throw new Error("Code-mode host SHA-256 must contain 64 lowercase hexadecimal characters");
	if (!Number.isSafeInteger(identity.sizeBytes) || identity.sizeBytes < 1)
		throw new Error("Code-mode host size must be a positive integer");
	if (!isAbsolute(identity.executablePath) || resolve(identity.executablePath) !== identity.executablePath)
		throw new Error("Code-mode host path must be absolute and normalized");
	const canonical = await realpath(identity.executablePath);
	if (canonical !== identity.executablePath) throw new Error("Code-mode host path must be canonical and not a symlink");
	const source = await open(identity.executablePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await source.stat();
		throwIfAborted(signal);
		if (!info.isFile()) throw new Error("Code-mode host path is not a regular file");
		if (info.size !== identity.sizeBytes)
			throw new Error(`Code-mode host size mismatch: expected ${identity.sizeBytes}, received ${info.size}`);
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let total = 0;
		for (;;) {
			throwIfAborted(signal);
			const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, total);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > identity.sizeBytes)
				throw new Error(`Code-mode host size mismatch: expected ${identity.sizeBytes}, received more bytes`);
			hash.update(buffer.subarray(0, bytesRead));
		}
		if (total !== identity.sizeBytes)
			throw new Error(`Code-mode host size mismatch: expected ${identity.sizeBytes}, received ${total}`);
		const actual = hash.digest("hex");
		if (actual !== identity.sha256)
			throw new Error(`Code-mode host checksum mismatch: expected ${identity.sha256}, received ${actual}`);
		return source;
	} catch (error) {
		await source.close();
		throw error;
	}
}

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(directory, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function removePrivateCopy(directory: string, executable: string): Promise<unknown[]> {
	const errors: unknown[] = [];
	for (const [path, operation] of [
		[executable, unlink],
		[directory, rmdir],
	] as const) {
		try {
			await operation(path);
		} catch (error) {
			if (!isMissing(error)) errors.push(error);
		}
	}
	return errors;
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function identityKey(identity: HostIdentity): string {
	return `${identity.platform}\0${identity.architecture}\0${identity.sha256.toLowerCase()}\0${identity.sizeBytes}\0protocol-1`;
}

function assertHostPlatform(identity: HostIdentity): void {
	if (identity.platform !== process.platform)
		throw new Error(
			`Code-mode host platform mismatch: expected ${process.platform}, received ${String(identity.platform)}`,
		);
	if (identity.architecture !== process.arch)
		throw new Error(
			`Code-mode host architecture mismatch: expected ${process.arch}, received ${String(identity.architecture)}`,
		);
}

export function minimalHostEnvironment(): NodeJS.ProcessEnv {
	const temporaryDirectory = tmpdir();
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
		return {
			SystemRoot: systemRoot,
			PATH: `${systemRoot}\\System32`,
			TEMP: temporaryDirectory,
			TMP: temporaryDirectory,
		};
	}
	return {
		PATH: "/usr/bin:/bin",
		TMPDIR: temporaryDirectory,
		LANG: "C.UTF-8",
	};
}

export async function acquireHost(
	identity: HostIdentity,
	limits: SessionLimits,
	signal?: AbortSignal,
): Promise<HostGeneration> {
	throwIfAborted(signal);
	assertHostPlatform(identity);
	const key = identityKey(identity);
	assertSingleContentIdentity(key);
	let generation = generations?.get(key);
	if (!generation || generation.poisoned || generation.closing) {
		let slot = creating?.get(key);
		if (slot?.abort.signal.aborted) {
			creating?.delete(key);
			slot = undefined;
		}
		if (!slot) {
			const abort = new AbortController();
			slot = {
				abort,
				waiters: new Set(),
				promise: pinHost(identity, abort.signal).then(
					({ directory, executable }) => new HostGeneration(key, directory, executable),
				),
			};
			if (!creating) creating = new Map();
			creating.set(key, slot);
		}
		const waiter = {};
		slot.waiters.add(waiter);
		try {
			generation = await waitForCreation(slot, waiter, signal);
		} finally {
			slot.waiters.delete(waiter);
			if (slot.waiters.size === 0 && signal?.aborted) slot.abort.abort(signal.reason);
			if (creating?.get(key) === slot && slot.waiters.size === 0) creating.delete(key);
		}
		if (signal?.aborted) {
			if (slot.waiters.size === 0) await generation.disposeIfUnused();
			throw abortError(signal);
		}
		if (!generations) generations = new Map();
		const incumbent = generations.get(key);
		if (incumbent && incumbent !== generation && !incumbent.poisoned && !incumbent.closing) {
			await generation.disposeUnused();
			generation = incumbent;
		} else generations.set(key, generation);
	}
	generation.retain();
	try {
		await generation.prepare(limits, signal);
		return generation;
	} catch (error) {
		try {
			await generation.release();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Code-mode host preparation and cleanup failed");
		}
		throw error;
	}
}

export class HostSession {
	private closePromise?: Promise<void>;
	private opened = false;
	private readonly generation: HostGeneration;
	readonly sessionId: string;
	private readonly limits: SessionLimits;

	constructor(generation: HostGeneration, sessionId: string, limits: SessionLimits) {
		this.generation = generation;
		this.sessionId = sessionId;
		this.limits = limits;
	}

	async open(
		handler: DelegateHandler,
		cellClosed: (cellId: string) => void,
		generationLost: (error: Error) => void,
		signal?: AbortSignal,
	): Promise<void> {
		this.generation.registerSession(this.sessionId, {
			delegate: handler,
			cellClosed,
			generationLost,
			maxDelegateCalls: this.limits.maxDelegateCalls,
			inFlightDelegates: 0,
		});
		try {
			const response = asRecord(
				await this.generation.request(
					{ method: "session/open", sessionId: this.sessionId, limits: this.limits },
					signal,
					HOST_CANCEL_GRACE_MS,
				),
				"session/open response",
			);
			if (
				response.type !== "session/ready" ||
				response.sessionId !== this.sessionId ||
				!equalLimits(response.limits, this.limits)
			)
				this.generation.fail(new Error("Code-mode host returned unequal session identity or limits"));
			this.opened = true;
			throwIfAborted(signal);
		} catch (error) {
			this.generation.unregisterSession(this.sessionId);
			throw error;
		}
	}

	execute(request: Record<string, unknown>, signal?: AbortSignal, onStarted?: (cellId: string) => void) {
		return this.generation.execute(this.sessionId, request, this.limits.maxCellLimits, signal, onStarted);
	}

	async wait(cellId: string, yieldTimeMs: number, signal?: AbortSignal): Promise<RuntimeResponse> {
		const response = asRecord(
			await this.generation.request(
				{
					method: "session/wait",
					sessionId: this.sessionId,
					request: { cell_id: cellId, yield_time_ms: yieldTimeMs },
				},
				signal,
			),
			"wait response",
		);
		if (response.type !== "wait/completed")
			this.generation.fail(new Error("Code-mode host returned unexpected wait response"));
		const outcome = asRecord(response.outcome, "wait outcome");
		return this.generation.validateCell(parseRuntimeResponse(outcome.LiveCell ?? outcome.MissingCell), cellId, "wait");
	}

	async terminate(cellId: string, signal?: AbortSignal): Promise<RuntimeResponse> {
		const response = asRecord(
			await this.generation.request({ method: "session/terminate", sessionId: this.sessionId, cellId }, signal),
			"terminate response",
		);
		if (response.type !== "wait/completed")
			this.generation.fail(new Error("Code-mode host returned unexpected terminate response"));
		const outcome = asRecord(response.outcome, "terminate outcome");
		return this.generation.validateCell(
			parseRuntimeResponse(outcome.LiveCell ?? outcome.MissingCell),
			cellId,
			"terminate",
		);
	}

	close(): Promise<void> {
		if (!this.closePromise) this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		const errors: unknown[] = [];
		try {
			if (this.opened && !this.generation.poisoned) {
				const response = asRecord(
					await withDeadline(
						this.generation.request({ method: "session/shutdown", sessionId: this.sessionId }),
						HOST_CLOSE_MS,
						"Code-mode session close timed out",
					),
					"session/shutdown response",
				);
				if (response.type !== "session/closed" || response.sessionId !== this.sessionId)
					this.generation.fail(new Error("Code-mode host returned unequal closed session ID"));
			}
		} catch (error) {
			errors.push(error);
		} finally {
			this.generation.unregisterSession(this.sessionId);
			try {
				await this.generation.release();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "Code-mode session cleanup failed");
	}

	metrics(): HostMetrics {
		return this.generation.metrics();
	}

	isHealthy(): boolean {
		return this.generation.isHealthy();
	}
}

export class HostGeneration {
	private readonly key: string;
	private readonly privateDirectory: string;
	private readonly privateExecutable: string;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly decoder = new FrameDecoder();
	private readonly pending = new Map<number, Pending>();
	private readonly executions = new Map<number, ExecutePending>();
	private readonly sessionHandlers = new Map<string, SessionRegistration>();
	private readonly delegateAborts = new Map<number, AbortController>();
	private delegateFloor = 0;
	private readonly delegateSeenGap = new Set<number>();
	private nextId = 1;
	private refs = 0;
	private hello: Promise<void>;
	private resolveHello!: () => void;
	private rejectHello!: (error: Error) => void;
	private processLimits?: ProcessLimits;
	private preparing?: Promise<HandshakeOutcome>;
	private writeChain = Promise.resolve();
	private counters = { requests: 0, delegates: 0, framesRead: 0, framesWritten: 0, bytesRead: 0, bytesWritten: 0 };
	private stderrTail = Buffer.alloc(0);
	poisoned = false;
	closing = false;

	constructor(key: string, privateDirectory: string, executablePath: string) {
		this.key = key;
		this.privateDirectory = privateDirectory;
		this.privateExecutable = executablePath;
		this.child = spawn(executablePath, [], {
			stdio: ["pipe", "pipe", "pipe"],
			env: minimalHostEnvironment(),
			windowsHide: true,
		});
		this.hello = new Promise<void>((resolve, reject) => {
			this.resolveHello = resolve;
			this.rejectHello = reject;
		});
		this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = Buffer.concat([this.stderrTail, chunk]).subarray(-STDERR_BYTES);
		});
		this.child.once("error", (error) => this.poison(error));
		this.child.once("exit", (code, signal) => {
			try {
				this.decoder.finish();
			} catch (error) {
				this.poison(asError(error));
				return;
			}
			if (!this.closing) this.poison(new Error(`Code-mode host exited (${code ?? signal ?? "unknown"})`));
		});
	}

	retain(): void {
		if (this.closing) throw new Error("Code-mode host generation is closing");
		this.refs++;
	}

	async prepare(limits: SessionLimits, signal?: AbortSignal): Promise<void> {
		this.assertHealthy();
		if (!this.preparing) {
			const handshake = withDeadline(
				(async () => {
					await this.write({
						type: "connection/hello",
						supportedVersions: [1],
						requiredCapabilities: ["resource_limits_v1"],
						optionalCapabilities: [],
					});
					await this.hello;
				})(),
				HOST_HANDSHAKE_MS,
				"Code-mode host handshake timed out",
			);
			this.preparing = handshake.then(
				() => ({}),
				(error) => {
					const failure = asError(error);
					if (!this.closing) this.poison(failure);
					return { error: this.decorate(failure) };
				},
			);
		}
		const outcome = await waitForCaller(this.preparing, signal);
		if (outcome.error) throw outcome.error;
		this.assertHealthy();
		if (!this.processLimits) throw new Error("Code-mode host omitted process limits");
		assertProcessSupports(this.processLimits, limits);
	}

	async release(): Promise<void> {
		if (this.refs <= 0) throw new Error("Code-mode host lease underflow");
		this.refs--;
		if (this.refs) return;
		this.closing = true;
		if (generations?.get(this.key) === this) generations.delete(this.key);
		const released = new Error("Code-mode host generation lease was released");
		this.rejectHello(released);
		this.rejectOutstanding(released);
		let cleanupError: unknown;
		try {
			await this.reapAndRemove();
		} catch (error) {
			cleanupError = error;
		}
		await this.preparing;
		if (cleanupError) throw cleanupError;
	}

	async disposeUnused(): Promise<void> {
		if (this.refs !== 0) throw new Error("Cannot dispose leased code-mode generation");
		this.closing = true;
		const disposed = new Error("Unused code-mode host generation was disposed");
		this.rejectHello(disposed);
		this.rejectOutstanding(disposed);
		let cleanupError: unknown;
		try {
			await this.reapAndRemove();
		} catch (error) {
			cleanupError = error;
		}
		await this.preparing;
		if (cleanupError) throw cleanupError;
	}

	async disposeIfUnused(): Promise<void> {
		if (this.refs !== 0 || generations?.get(this.key) === this || this.closing) return;
		this.closing = true;
		this.rejectOutstanding(new Error("Unused code-mode host generation was disposed"));
		await this.reapAndRemove();
	}

	registerSession(id: string, registration: SessionRegistration): void {
		if (this.sessionHandlers.has(id)) throw new Error(`Duplicate code-mode session ${id}`);
		this.sessionHandlers.set(id, registration);
	}
	unregisterSession(id: string): void {
		this.sessionHandlers.delete(id);
	}

	async request(request: Record<string, unknown>, signal?: AbortSignal, cancelTimeoutMs?: number): Promise<unknown> {
		this.assertHealthy();
		if (this.pending.size + this.executions.size >= HOST_MAX_PENDING_OPERATIONS)
			throw new Error("Code-mode client has too many pending requests");
		const id = this.nextId++;
		const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
		this.counters.requests++;
		let settled = false;
		let cancelTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			if (!settled && this.pending.has(id)) {
				void this.write({ type: "operation/cancel", id }).catch((error) => this.poison(asError(error)));
				const grace = cancelTimeoutMs ?? HOST_CANCEL_GRACE_MS;
				if (cancelTimer === undefined)
					cancelTimer = setTimeout(() => {
						if (this.pending.has(id)) this.poison(new Error(`Code-mode operation ${id} cancellation timed out`));
					}, grace);
			}
		};
		try {
			await this.write({ type: "operation/request", id, request });
			if (signal) {
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
			return await response;
		} catch (error) {
			this.pending.delete(id);
			throw error;
		} finally {
			settled = true;
			if (cancelTimer) clearTimeout(cancelTimer);
			if (signal) signal.removeEventListener("abort", abort);
		}
	}

	async execute(
		sessionId: string,
		request: Record<string, unknown>,
		limits: SessionLimits["maxCellLimits"],
		signal?: AbortSignal,
		onStarted?: (cellId: string) => void,
	): Promise<RuntimeResponse> {
		this.assertHealthy();
		if (this.pending.size + this.executions.size >= HOST_MAX_PENDING_OPERATIONS)
			throw new Error("Code-mode client has too many pending executions");
		const id = this.nextId++;
		let resolveStarted!: (value: unknown) => void, rejectStarted!: (error: Error) => void;
		let resolveInitial!: (value: unknown) => void, rejectInitial!: (error: Error) => void;
		const started = new Promise<unknown>((resolve, reject) => {
			resolveStarted = resolve;
			rejectStarted = reject;
		});
		const initial = new Promise<unknown>((resolve, reject) => {
			resolveInitial = resolve;
			rejectInitial = reject;
		});
		const execution: ExecutePending = {
			sessionId,
			limits,
			onStarted,
			started: { resolve: resolveStarted, reject: rejectStarted },
			initial: { resolve: resolveInitial, reject: rejectInitial },
		};
		this.executions.set(id, execution);
		this.counters.requests++;
		let cancelTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			const task = execution.startedCellId
				? this.request({ method: "session/terminate", sessionId, cellId: execution.startedCellId })
				: this.write({ type: "operation/cancel", id });
			void task.catch((error) => this.poison(asError(error)));
			if (cancelTimer === undefined) {
				cancelTimer = setTimeout(() => {
					if (this.executions.has(id)) {
						this.poison(new Error(`Code-mode execution ${id} cancellation timed out`));
					}
				}, HOST_CANCEL_GRACE_MS);
			}
		};
		try {
			await this.write({
				type: "operation/request",
				id,
				request: { method: "session/execute", sessionId, request, limits },
			});
			if (signal) {
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			}
			await started;
			const response = parseRuntimeResponse(await initial);
			validWireString(response.cellId, "initial cell ID");
			if (response.cellId !== execution.startedCellId)
				this.fail(
					new Error(
						`Code-mode initial cell ID mismatch: expected ${execution.startedCellId}, received ${response.cellId}`,
					),
				);
			return response;
		} catch (error) {
			execution.started.reject(asError(error));
			execution.initial.reject(asError(error));
			await Promise.allSettled([started, initial]);
			this.executions.delete(id);
			if (execution.startedCellId && !this.poisoned) {
				try {
					await this.request({ method: "session/terminate", sessionId, cellId: execution.startedCellId });
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], "Code-mode execution and cleanup failed");
				}
			}
			throw error;
		} finally {
			this.executions.delete(id);
			if (cancelTimer) clearTimeout(cancelTimer);
			if (signal) signal.removeEventListener("abort", abort);
		}
	}

	validateCell(response: RuntimeResponse, expected: string, operation: string): RuntimeResponse {
		validWireString(response.cellId, `${operation} cell ID`);
		if (response.cellId !== expected)
			this.fail(
				new Error(`Code-mode ${operation} cell ID mismatch: expected ${expected}, received ${response.cellId}`),
			);
		return response;
	}

	metrics(): HostMetrics {
		return { ...this.counters, childPid: this.child.pid };
	}
	isHealthy(): boolean {
		return !this.poisoned && !this.closing;
	}
	fail(error: Error): never {
		this.poison(error);
		throw this.decorate(error);
	}
	cancel(error: Error): void {
		this.poison(error);
	}

	private async write(message: unknown): Promise<void> {
		let frame: Buffer;
		try {
			frame = encodeFrame(message);
		} catch (error) {
			throw asError(error);
		}
		await this.writeFrame(frame);
	}

	private async writeFrame(frame: Buffer): Promise<void> {
		this.writeChain = this.writeChain.then(
			() =>
				new Promise<void>((resolve, reject) =>
					this.child.stdin.write(frame, (error) => (error ? reject(error) : resolve())),
				),
		);
		try {
			await this.writeChain;
			this.counters.framesWritten++;
			this.counters.bytesWritten += frame.byteLength;
		} catch (error) {
			this.fail(new Error(`Code-mode host write failed: ${asError(error).message}`));
		}
	}

	private onData(chunk: Buffer): void {
		try {
			this.counters.bytesRead += chunk.byteLength;
			for (const message of this.decoder.push(chunk)) {
				this.counters.framesRead++;
				this.onMessage(asRecord(message, "host message"));
			}
		} catch (error) {
			this.poison(asError(error));
		}
	}

	private onMessage(message: Record<string, unknown>): void {
		if (message.type === "connection/ready") {
			if (this.processLimits) throw new Error("Duplicate code-mode connection response");
			if (
				message.selectedVersion !== 1 ||
				!Array.isArray(message.capabilities) ||
				!message.capabilities.includes("resource_limits_v1")
			)
				throw new Error("Code-mode host lacks required resource_limits_v1 capability");
			this.processLimits = asRecord(message.processLimits, "process limits") as unknown as ProcessLimits;
			this.resolveHello();
			return;
		}
		if (message.type === "connection/rejected")
			throw new Error(`Code-mode host rejected handshake: ${String(message.reason)}`);
		if (message.type === "operation/response") {
			const id = validId(message.id, "response");
			const execution = this.executions.get(id);
			if (execution) {
				if (execution.startedCellId) throw new Error(`Unknown or duplicate code-mode response ID ${id}`);
				let value: unknown;
				try {
					value = unwrapResult(message.result);
				} catch (error) {
					this.executions.delete(id);
					execution.started.reject(asError(error));
					execution.initial.reject(asError(error));
					return;
				}
				const started = asRecord(value, "execution/started response");
				if (
					started.type !== "execution/started" ||
					!equalLimits(started.limits, execution.limits) ||
					typeof started.cellId !== "string"
				)
					throw new Error("Code-mode host returned invalid execution identity or limits");
				validWireString(started.cellId, "started cell ID");
				execution.startedCellId = started.cellId;
				execution.onStarted?.(started.cellId);
				execution.started.resolve(value);
				return;
			}
			const pending = this.pending.get(id);
			if (!pending) throw new Error(`Unknown or duplicate code-mode response ID ${id}`);
			this.pending.delete(id);
			try {
				pending.resolve(unwrapResult(message.result));
			} catch (error) {
				pending.reject(asError(error));
			}
			return;
		}
		if (message.type === "execute/initialResponse") {
			const id = validId(message.id, "initial response");
			const execution = this.executions.get(id);
			if (!execution?.startedCellId)
				throw new Error(`Unknown, duplicate, or early code-mode initial response ID ${id}`);
			this.executions.delete(id);
			try {
				execution.initial.resolve(unwrapResult(message.result));
			} catch (error) {
				execution.initial.reject(asError(error));
			}
			return;
		}
		if (message.type === "delegate/request") {
			void this.handleDelegate(message).catch((error) => this.poison(asError(error)));
			return;
		}
		if (message.type === "delegate/cancel") {
			const id = validId(message.id, "delegate cancel");
			const abort = this.delegateAborts.get(id);
			if (abort) abort.abort();
			else if (!this.hasSeenDelegate(id)) throw new Error(`Delegate cancel targets unknown request ${id}`);
			return;
		}
		if (message.type === "cell/closed") {
			if (typeof message.sessionId !== "string" || typeof message.cellId !== "string")
				throw new Error("Malformed code-mode cell/closed message");
			validWireString(message.cellId, "closed cell ID");
			const registration = this.sessionHandlers.get(message.sessionId);
			if (!registration) throw new Error(`Cell closure targets unknown session ${message.sessionId}`);
			registration.cellClosed(message.cellId);
			return;
		}
		throw new Error(`Unknown code-mode host message ${String(message.type)}`);
	}

	private async handleDelegate(message: Record<string, unknown>): Promise<void> {
		const id = validId(message.id, "delegate request");
		const sessionId = message.sessionId;
		if (typeof sessionId !== "string" || this.hasSeenDelegate(id))
			throw new Error("Invalid or duplicate code-mode delegate request");
		const registration = this.sessionHandlers.get(sessionId);
		if (!registration) throw new Error(`Delegate request targets unknown session ${sessionId}`);
		const processCap = Math.min(
			this.processLimits?.maxDelegateCalls ?? 0,
			this.processLimits?.maxInFlightOperations ?? 0,
			HOST_MAX_PENDING_OPERATIONS,
		);
		if (processCap < 1 || this.delegateAborts.size >= processCap) {
			throw new Error(`Code-mode host exceeded global delegate limit ${processCap}`);
		}
		if (registration.inFlightDelegates >= registration.maxDelegateCalls) {
			throw new Error(`Code-mode session exceeded delegate limit ${registration.maxDelegateCalls}`);
		}
		this.recordDelegate(id);
		const abort = new AbortController();
		this.delegateAborts.set(id, abort);
		registration.inFlightDelegates++;
		this.counters.delegates++;
		try {
			let value: unknown;
			try {
				value = await registration.delegate(asRecord(message.request, "delegate request"), abort.signal);
			} catch (error) {
				await this.sendDelegateError(id, boundedErrorMessage(error));
				return;
			}
			let frame: Buffer;
			try {
				frame = encodeFrame({ type: "delegate/response", id, result: { status: "ok", value } });
			} catch {
				await this.sendDelegateError(id, DELEGATE_ENCODING_ERROR);
				return;
			}
			await this.writeFrame(frame);
		} finally {
			this.delegateAborts.delete(id);
			registration.inFlightDelegates--;
		}
	}

	private hasSeenDelegate(id: number): boolean {
		return id <= this.delegateFloor || this.delegateSeenGap.has(id);
	}

	private recordDelegate(id: number): void {
		this.delegateSeenGap.add(id);
		while (this.delegateSeenGap.delete(this.delegateFloor + 1)) this.delegateFloor++;
		if (this.delegateSeenGap.size > DELEGATE_GAP_LIMIT)
			throw new Error(`Code-mode delegate ID gap exceeds ${DELEGATE_GAP_LIMIT}`);
	}

	private async sendDelegateError(id: number, message: string): Promise<void> {
		const frame = encodeFrame({ type: "delegate/response", id, result: { status: "error", message } });
		await this.writeFrame(frame);
	}

	private assertHealthy(): void {
		if (this.poisoned) throw this.decorate(new Error("Code-mode host generation is poisoned"));
	}
	private decorate(error: Error): Error {
		const stderr = this.stderrTail.toString("utf8").trim();
		return stderr ? new Error(`${error.message}\nCode-mode host stderr:\n${stderr}`, { cause: error }) : error;
	}
	private poison(error: Error): void {
		if (this.poisoned) return;
		this.poisoned = true;
		if (generations?.get(this.key) === this) generations.delete(this.key);
		const decorated = this.decorate(error);
		this.rejectHello(decorated);
		this.rejectOutstanding(decorated);
		for (const registration of this.sessionHandlers.values()) registration.generationLost(decorated);
		if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
	}

	private rejectOutstanding(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error);
		for (const execution of this.executions.values()) {
			execution.started.reject(error);
			execution.initial.reject(error);
		}
		this.pending.clear();
		this.executions.clear();
		for (const abort of this.delegateAborts.values()) abort.abort(error);
		this.delegateAborts.clear();
	}

	private async reapAndRemove(): Promise<void> {
		const errors: unknown[] = [];
		try {
			if (this.child.exitCode === null && this.child.signalCode === null) {
				this.child.kill("SIGTERM");
				if (!(await waitForExit(this.child, 1000))) {
					this.child.kill("SIGKILL");
					if (!(await waitForExit(this.child, 1000)))
						errors.push(new Error(`Code-mode host PID ${this.child.pid ?? "unknown"} was not reaped after SIGKILL`));
				}
			}
		} catch (error) {
			errors.push(error);
		}
		errors.push(...(await removePrivateCopy(this.privateDirectory, this.privateExecutable)));
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "Code-mode host reap and private-copy cleanup failed");
	}
}

function unwrapResult(value: unknown): unknown {
	const result = asRecord(value, "operation result");
	if (result.status === "ok") return result.value;
	throw new Error(typeof result.message === "string" ? result.message : "Code-mode host operation failed");
}
function validId(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1)
		throw new Error(`Code-mode ${label} has invalid request ID`);
	return value as number;
}
function validWireString(value: string, label: string): string {
	if (!value || value.length > 1024) throw new Error(`Code-mode ${label} is invalid`);
	return value;
}
function assertSingleContentIdentity(key: string): void {
	for (const [activeKey, generation] of generations ?? []) {
		if (activeKey !== key && !generation.poisoned && !generation.closing)
			throw new Error("A different code-mode host content identity is already active in this process");
	}
	for (const [activeKey, slot] of creating ?? []) {
		if (activeKey !== key && !slot.abort.signal.aborted)
			throw new Error("A different code-mode host content identity is already being prepared in this process");
	}
}
async function waitForCreation(slot: CreationSlot, waiter: object, signal?: AbortSignal): Promise<HostGeneration> {
	if (!signal) return slot.promise;
	let resolveAbort!: () => void;
	const callerAborted = new Promise<void>((resolve) => {
		resolveAbort = resolve;
	});
	const abort = () => {
		slot.waiters.delete(waiter);
		if (slot.waiters.size === 0) slot.abort.abort(signal.reason);
		resolveAbort();
	};
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	try {
		const outcome = await Promise.race([
			slot.promise.then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			),
			callerAborted.then(() => ({ aborted: true as const })),
		]);
		if ("aborted" in outcome) {
			// A sole waiter owns cancellation cleanup. Shared waiters detach immediately.
			const callerError = abortError(signal);
			if (slot.waiters.size === 0) {
				const creation = await slot.promise.then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				);
				if ("error" in creation)
					throw new AggregateError([callerError, creation.error], "Code-mode host abort and cleanup failed");
				// A waiter can join while creation settles. disposeIfUnused() also protects a generation
				// already retained or installed by such a waiter.
				if (slot.waiters.size === 0) {
					try {
						await creation.value.disposeIfUnused();
					} catch (cleanup) {
						throw new AggregateError([callerError, cleanup], "Code-mode host abort and cleanup failed");
					}
				}
			}
			throw callerError;
		}
		if ("error" in outcome) throw outcome.error;
		return outcome.value;
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
async function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	throwIfAborted(signal);
	let rejectAbort!: (error: Error) => void;
	const aborted = new Promise<T>((_, reject) => {
		rejectAbort = reject;
	});
	const abort = () => rejectAbort(abortError(signal));
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}
function abortError(signal?: AbortSignal): Error {
	return new Error("Code-mode host preparation aborted", { cause: signal?.reason });
}
function boundedErrorMessage(error: unknown): string {
	let message: string;
	try {
		message = error instanceof Error ? error.message : String(error);
	} catch {
		message = "Code-mode delegate handler failed with an unreadable error";
	}
	let result = "";
	let bytes = 0;
	for (const character of message) {
		const size = Buffer.byteLength(character);
		if (bytes + size > DELEGATE_ERROR_BYTES - 3) return `${result}...`;
		result += character;
		bytes += size;
	}
	return result || "Code-mode delegate handler failed";
}
function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
async function waitForExit(child: ChildProcessWithoutNullStreams, milliseconds: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			once(child, "exit").then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function withDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
