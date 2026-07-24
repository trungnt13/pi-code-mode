import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONTROLLER_CELL_CLOSE_MS,
	CONTROLLER_DELEGATE_DRAIN_MS,
	CONTROLLER_LOSS_CLEANUP_MS,
	CONTROLLER_OPERATION_DRAIN_MS,
	CONTROLLER_PREPARE_CLOSE_MS,
	DEFAULT_OUTER_ERROR_BYTES,
} from "../constants.js";
import type { AnyToolDefinition, NestedAfterCallback, NestedBeforeCallback } from "../public-types.js";
import { encodeJsonBounded } from "./frame-codec.js";
import { acquireHost, HOST_CLOSE_MS, type HostIdentity, type HostMetrics, HostSession } from "./host-client.js";
import { mergeSessionLimits, type RuntimeResponse, type SessionLimits } from "./protocol.js";
import { FairScheduler } from "./scheduler.js";

const DEFAULT_TOKENS = 10_000;
export {
	CONTROLLER_CELL_CLOSE_MS,
	CONTROLLER_DELEGATE_DRAIN_MS,
	CONTROLLER_LOSS_CLEANUP_MS,
	CONTROLLER_OPERATION_DRAIN_MS,
	CONTROLLER_PREPARE_CLOSE_MS,
	DEFAULT_OUTER_ERROR_BYTES,
};
export type { AnyToolDefinition, NestedAfterCallback, NestedBeforeCallback };

export interface ControllerOptions {
	host: HostIdentity;
	limits?: Partial<SessionLimits> & {
		maxCellLimits?: Partial<SessionLimits["maxCellLimits"]>;
	};
	createNestedTools(context: ExtensionContext): readonly AnyToolDefinition[];
	beforeNestedTool?: NestedBeforeCallback;
	afterNestedTool?: NestedAfterCallback;
}

export interface ControllerMetrics extends HostMetrics {
	prepared: boolean;
	closed: boolean;
	activeCells: number;
	startingCells: number;
}

type CellRuntime = {
	tools: ReadonlyMap<string, AnyToolDefinition>;
	context: ExtensionContext;
	outerToolCallId: string;
	onUpdate?: (result: AgentToolResult<unknown>) => void;
};

type Lifecycle = "open" | "draining" | "closed";

export class CodeModeController {
	private readonly options: ControllerOptions;
	private readonly limits: SessionLimits;
	private readonly scheduler: FairScheduler;
	private readonly controllerAbort = new AbortController();
	private readonly operations = new Set<Promise<unknown>>();
	private readonly delegates = new Set<Promise<unknown>>();
	private readonly cells = new Map<string, CellRuntime>();
	private readonly activeWaits = new Set<string>();
	private readonly lossCleanups = new Set<Promise<void>>();
	private readonly lossCleanupErrors: unknown[] = [];
	private lifecycle: Lifecycle = "open";
	private session?: HostSession;
	private preparePromise?: Promise<HostSession>;
	private closePromise?: Promise<void>;
	private startingCells = 0;

	constructor(options: ControllerOptions) {
		this.options = options;
		this.limits = mergeSessionLimits(options.limits);
		this.scheduler = new FairScheduler(this.limits.maxDelegateCalls);
	}

	metrics(): ControllerMetrics {
		return {
			...(this.session?.metrics() ?? emptyMetrics()),
			prepared: this.session !== undefined,
			closed: this.lifecycle === "closed",
			activeCells: this.cells.size,
			startingCells: this.startingCells,
		};
	}

	execute(
		code: string,
		toolCallId: string,
		context: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: (result: AgentToolResult<unknown>) => void,
	): Promise<AgentToolResult<unknown>> {
		const executionOptions = parseExecutionOptions(code);
		return this.runOperation(async (ownedSignal) => {
			this.reserveCellStart();
			let starting = true;
			try {
				const session = await this.ensureSession();
				const tools = snapshotTools(this.options.createNestedTools(context));
				preflightDefinitions(tools, this.limits.maxCellLimits.toolDefinitionBytes);
				const runtime: CellRuntime = {
					tools: new Map(tools.map((tool) => [tool.name, tool])),
					context,
					outerToolCallId: toolCallId,
					onUpdate,
				};
				const response = await session.execute(
					{
						tool_call_id: toolCallId,
						enabled_tools: tools.map(toolDefinition),
						source: code,
						yield_time_ms: executionOptions.yieldTimeMs,
						max_output_tokens: executionOptions.maxOutputTokens,
					},
					ownedSignal,
					(cellId) => {
						this.assertOpen();
						if (this.cells.has(cellId)) throw new Error(`Duplicate code-mode cell ${cellId}`);
						if (!starting) throw new Error("Code-mode cell start reservation was already consumed");
						this.startingCells--;
						starting = false;
						this.cells.set(cellId, runtime);
					},
				);
				if (response.kind !== "yielded") this.cells.delete(response.cellId);
				return runtimeResult(response, executionOptions.maxOutputTokens, this.limits.maxCellLimits.outputBytes);
			} finally {
				if (starting) this.startingCells--;
			}
		}, signal).catch((error: unknown) => {
			throw boundedOuterError(
				error,
				outerErrorLimit(executionOptions.maxOutputTokens, this.limits.maxCellLimits.outputBytes),
			);
		});
	}

	wait(
		cellId: string,
		yieldTimeMs: number,
		maxTokens: number,
		terminate: boolean,
		signal?: AbortSignal,
	): Promise<AgentToolResult<unknown>> {
		if (!this.cells.has(cellId)) {
			return Promise.reject(new Error(`Unknown or expired code-mode cell ${boundedId(cellId, "cell ID")}`));
		}
		if (this.activeWaits.has(cellId)) {
			return Promise.reject(new Error(`Code-mode cell ${boundedId(cellId, "cell ID")} already has an active wait`));
		}
		this.activeWaits.add(cellId);
		try {
			return this.runOperation(async (ownedSignal) => {
				const session = await this.ensureSession();
				const response = terminate
					? await session.terminate(cellId, ownedSignal)
					: await session.wait(cellId, yieldTimeMs, ownedSignal);
				if (response.kind !== "yielded") this.cells.delete(cellId);
				return runtimeResult(response, maxTokens, this.limits.maxCellLimits.outputBytes);
			}, signal)
				.catch((error: unknown) => {
					throw boundedOuterError(error, outerErrorLimit(maxTokens, this.limits.maxCellLimits.outputBytes));
				})
				.finally(() => this.activeWaits.delete(cellId));
		} catch (error) {
			this.activeWaits.delete(cellId);
			throw error;
		}
	}

	close(): Promise<void> {
		if (!this.closePromise) this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async ensureSession(): Promise<HostSession> {
		this.assertOpen();
		await this.drainLossCleanups();
		this.assertOpen();
		if (this.session && !this.session.isHealthy()) await this.evictPoisonedSession();
		if (this.session) return this.session;
		if (!this.preparePromise) this.preparePromise = this.prepareSession();
		try {
			return await this.preparePromise;
		} catch (error) {
			this.preparePromise = undefined;
			throw error;
		}
	}

	private async evictPoisonedSession(): Promise<void> {
		const session = this.session;
		this.session = undefined;
		this.preparePromise = undefined;
		this.cells.clear();
		if (session) await withDeadline(session.close(), HOST_CLOSE_MS, "Poisoned code-mode session cleanup timed out");
	}

	private generationLost(session: HostSession): void {
		if (this.session === session) this.session = undefined;
		this.preparePromise = undefined;
		this.cells.clear();
		const cleanup = withDeadline(
			session.close(),
			CONTROLLER_LOSS_CLEANUP_MS,
			"Lost code-mode generation cleanup timed out",
		)
			.catch((error: unknown) => {
				this.lossCleanupErrors.push(error);
			})
			.finally(() => this.lossCleanups.delete(cleanup));
		this.lossCleanups.add(cleanup);
	}

	private async drainLossCleanups(): Promise<void> {
		while (this.lossCleanups.size) await Promise.all([...this.lossCleanups]);
		if (this.lossCleanupErrors.length === 1) throw this.lossCleanupErrors.shift();
		if (this.lossCleanupErrors.length > 1) {
			throw new AggregateError(this.lossCleanupErrors.splice(0), "Lost code-mode generation cleanup failed");
		}
	}

	private async prepareSession(): Promise<HostSession> {
		const generation = await acquireHost(this.options.host, this.limits, this.controllerAbort.signal);
		const session = new HostSession(generation, `pi-code-mode-${randomUUID()}`, this.limits);
		try {
			await session.open(
				(request, signal) => this.trackDelegate(request, signal),
				(cellId) => this.cells.delete(cellId),
				() => this.generationLost(session),
				this.controllerAbort.signal,
			);
			this.assertOpen();
			this.session = session;
			return session;
		} catch (error) {
			try {
				await session.close();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "Code-mode session preparation and cleanup failed");
			}
			throw error;
		}
	}

	private async handleDelegate(request: Record<string, unknown>, hostSignal: AbortSignal): Promise<unknown> {
		const signal = AbortSignal.any([hostSignal, this.controllerAbort.signal]);
		throwIfAborted(signal);
		if (request.type === "notification/send") {
			const cellId = boundedId(request.cellId, "notification cell ID");
			const callId = boundedId(request.callId, "notification call ID");
			if (typeof request.text !== "string" || Buffer.byteLength(request.text) > this.limits.maxCellLimits.outputBytes) {
				throw new Error("Code-mode notification text is invalid or exceeds output limit");
			}
			const runtime = this.cells.get(cellId);
			if (!runtime) throw new Error(`Unknown code-mode cell ${cellId}`);
			throwIfAborted(signal);
			runtime.onUpdate?.({
				content: [{ type: "text", text: request.text }],
				details: { cellId, callId, notification: true },
			});
			return { type: "notification/delivered" };
		}
		if (request.type !== "tool/invoke") {
			throw new Error(`Unsupported code-mode delegate ${String(request.type)}`);
		}
		const invocation = asObject(request.invocation, "tool invocation");
		const cellId = boundedId(invocation.cell_id, "tool cell ID");
		const runtimeCallId = boundedId(invocation.runtime_tool_call_id, "runtime tool call ID");
		const runtime = this.cells.get(cellId);
		if (!runtime) throw new Error(`Unknown code-mode cell ${cellId}`);
		const wireName = asObject(invocation.tool_name, "tool name");
		const name = wireName.name;
		if (typeof name !== "string" || name === "exec" || name === "wait") {
			throw new Error("Code-mode public tools cannot be called recursively");
		}
		const tool = runtime.tools.get(name);
		if (!tool) throw new Error(`Unknown nested tool ${String(name)}`);
		const raw = invocation.input ?? {};
		throwIfAborted(signal);
		const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
		let args = validate(tool, prepared, runtimeCallId);
		if (this.options.beforeNestedTool) {
			throwIfAborted(signal);
			const replacement = await this.options.beforeNestedTool({
				toolName: name,
				arguments: args,
				context: runtime.context,
				signal,
			});
			if (replacement !== undefined) args = replacement;
		}
		args = validate(tool, args, runtimeCallId);
		throwIfAborted(signal);
		const release = await this.scheduler.acquire(tool.executionMode === "sequential" ? "exclusive" : "shared", signal);
		try {
			throwIfAborted(signal);
			let result = await tool.execute(
				`${runtime.outerToolCallId}:code-mode:${cellId}:${runtimeCallId}`,
				args as never,
				signal,
				undefined,
				runtime.context,
			);
			result = validateToolResult(result);
			if (this.options.afterNestedTool) {
				throwIfAborted(signal);
				const replacement = await this.options.afterNestedTool({
					toolName: name,
					arguments: args,
					result,
					context: runtime.context,
					signal,
				});
				if (replacement !== undefined) result = replacement;
			}
			result = validateToolResult(result);
			const value = {
				type: "tool/result",
				result: {
					content: result.content,
					details: result.details === undefined ? null : result.details,
					isError: false,
				},
			};
			encodeJsonBounded(value, this.limits.maxCellLimits.delegateResultBytes, "Nested tool result");
			return value;
		} finally {
			release();
		}
	}

	private trackDelegate(request: Record<string, unknown>, hostSignal: AbortSignal): Promise<unknown> {
		if (this.lifecycle !== "open") {
			return Promise.reject(new Error(`Code-mode controller is ${this.lifecycle}`));
		}
		const promise = this.handleDelegate(request, hostSignal);
		this.delegates.add(promise);
		void promise.then(
			() => this.delegates.delete(promise),
			() => this.delegates.delete(promise),
		);
		return promise;
	}

	private runOperation<T>(operation: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
		this.assertOpen();
		const signal = callerSignal
			? AbortSignal.any([callerSignal, this.controllerAbort.signal])
			: this.controllerAbort.signal;
		let promise: Promise<T>;
		try {
			promise = operation(signal);
		} catch (error) {
			promise = Promise.reject(error);
		}
		this.operations.add(promise);
		void promise.then(
			() => this.operations.delete(promise),
			() => this.operations.delete(promise),
		);
		return promise;
	}

	private async closeInternal(): Promise<void> {
		if (this.lifecycle === "closed") return;
		this.lifecycle = "draining";
		this.controllerAbort.abort(new Error("Code mode is disabling"));
		const errors: unknown[] = [];
		await withDeadline(
			this.drainTrackedWork(errors),
			CONTROLLER_DELEGATE_DRAIN_MS,
			"Code-mode delegate drain timed out",
		).catch((error: unknown) => {
			errors.push(error);
		});
		try {
			await this.drainLossCleanups();
		} catch (error) {
			errors.push(error);
		}
		const session = this.session;
		if (session) {
			for (const cellId of [...this.cells.keys()]) {
				try {
					await withDeadline(
						session.terminate(cellId),
						CONTROLLER_CELL_CLOSE_MS,
						`Code-mode cell ${cellId} termination timed out`,
					);
				} catch (error) {
					errors.push(error);
				} finally {
					this.cells.delete(cellId);
				}
			}
			try {
				await session.close();
			} catch (error) {
				errors.push(error);
			}
		} else {
			const preparation = this.preparePromise;
			if (preparation) {
				try {
					await withDeadline(
						preparation,
						CONTROLLER_PREPARE_CLOSE_MS,
						"Code-mode session preparation cleanup timed out",
					);
				} catch (error) {
					errors.push(error);
				}
			}
		}
		this.cells.clear();
		this.activeWaits.clear();
		try {
			await this.drainLossCleanups();
		} catch (error) {
			errors.push(error);
		}
		this.lifecycle = "closed";
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Code-mode controller cleanup failed");
	}

	private assertOpen(): void {
		if (this.lifecycle !== "open") throw new Error(`Code-mode controller is ${this.lifecycle}`);
	}

	private reserveCellStart(): void {
		this.assertOpen();
		if (this.cells.size + this.startingCells >= this.limits.maxActiveCells) {
			throw new Error(`Code-mode active cell limit ${this.limits.maxActiveCells} reached`);
		}
		this.startingCells++;
	}

	private async drainTrackedWork(errors: unknown[]): Promise<void> {
		while (this.operations.size || this.delegates.size) {
			const settled = await Promise.allSettled([...this.operations, ...this.delegates]);
			for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
		}
	}
}

export function snapshotTools(tools: readonly AnyToolDefinition[]): readonly AnyToolDefinition[] {
	const names = new Set<string>();
	const runtimeNames = new Set<string>();
	const snapshot = tools.map((tool) => {
		if (!tool.name || tool.name === "exec" || tool.name === "wait") {
			throw new Error(`Nested tool name ${tool.name} is reserved or empty`);
		}
		if (names.has(tool.name)) throw new Error(`Duplicate nested tool name ${tool.name}`);
		const runtimeName = runtimeToolName(tool.name);
		if (runtimeNames.has(runtimeName)) {
			throw new Error(`Nested tool names collide after normalization: ${runtimeName}`);
		}
		names.add(tool.name);
		runtimeNames.add(runtimeName);
		const schema = deepFreeze(structuredClone(tool.parameters));
		return Object.freeze({
			...tool,
			parameters: schema,
			execute: tool.execute.bind(tool),
			...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments.bind(tool) } : {}),
		});
	});
	return Object.freeze(snapshot);
}

export function preflightDefinitions(tools: readonly AnyToolDefinition[], limit: number): void {
	encodeJsonBounded(tools.map(toolDefinition), limit, "Code-mode tool definitions");
}

function validate(tool: AnyToolDefinition, args: unknown, callId: string): unknown {
	return validateToolArguments(tool as never, {
		type: "toolCall",
		id: callId,
		name: tool.name,
		arguments: args as Record<string, unknown>,
	});
}

function validateToolResult(value: unknown): AgentToolResult<unknown> {
	const result = asObject(value, "nested tool result");
	if (!Array.isArray(result.content)) throw new Error("Nested tool result content must be an array");
	for (const item of result.content) {
		const content = asObject(item, "nested tool content");
		if (content.type === "text" && typeof content.text === "string") continue;
		if (content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string") continue;
		throw new Error("Nested tool result contains unsupported content");
	}
	if (!("details" in result)) throw new Error("Nested tool result must contain details");
	return value as AgentToolResult<unknown>;
}

function toolDefinition(tool: AnyToolDefinition): Record<string, unknown> {
	return {
		name: runtimeToolName(tool.name),
		tool_name: { name: tool.name, namespace: null },
		description: tool.description,
		kind: "function",
		input_schema: tool.parameters,
		output_schema: null,
	};
}

function runtimeToolName(name: string): string {
	const normalized = name.replace(/[^A-Za-z0-9_$]/g, "_");
	return /^[A-Za-z_$]/.test(normalized) ? normalized : `tool_${normalized}`;
}

function parseExecutionOptions(source: string): { yieldTimeMs: number; maxOutputTokens: number } {
	if (!source.trim()) throw new Error("Code-mode source must contain nonempty code");
	const defaults = { yieldTimeMs: 10_000, maxOutputTokens: DEFAULT_TOKENS };
	const newline = source.search(/\r?\n/);
	const firstLine = (newline < 0 ? source : source.slice(0, newline)).trim();
	if (!firstLine.startsWith("// @exec:")) return defaults;
	if (newline < 0 || !source.slice(newline).trim()) {
		throw new Error("Code-mode @exec pragma must be followed by code");
	}
	let value: unknown;
	try {
		value = JSON.parse(firstLine.slice("// @exec:".length).trim());
	} catch {
		throw new Error("Invalid code-mode @exec pragma JSON");
	}
	const record = asObject(value, "@exec pragma");
	for (const key of Object.keys(record)) {
		if (key !== "yield_time_ms" && key !== "max_output_tokens") {
			throw new Error(`Unsupported code-mode @exec option ${key}`);
		}
	}
	return {
		yieldTimeMs: optionInteger(record.yield_time_ms, "yield_time_ms", 60_000, defaults.yieldTimeMs),
		maxOutputTokens: optionInteger(record.max_output_tokens, "max_output_tokens", 100_000, defaults.maxOutputTokens),
	};
}

function optionInteger(value: unknown, name: string, maximum: number, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
		throw new Error(`Code-mode ${name} must be an integer from 1 to ${maximum}`);
	}
	return value as number;
}

function runtimeResult(response: RuntimeResponse, maxTokens: number, outputBytes: number): AgentToolResult<unknown> {
	const failed = response.kind === "result" && response.errorText !== undefined;
	const status =
		response.kind === "yielded"
			? `Script running with cell ID ${response.cellId}`
			: response.kind === "terminated"
				? `Script terminated with cell ID ${response.cellId}`
				: failed
					? `Script failed with cell ID ${response.cellId}`
					: `Script completed with cell ID ${response.cellId}`;
	const maximumBytes = outerErrorLimit(maxTokens, outputBytes);
	if (failed) throw new Error(truncateUtf8(`${status}\n${response.errorText}`, maximumBytes));
	const content: AgentToolResult<unknown>["content"] = [{ type: "text", text: status }];
	for (const item of response.contentItems) {
		const record = asObject(item, "runtime content item");
		if (record.type === "input_text" && typeof record.text === "string") {
			content.push({ type: "text", text: record.text });
		} else if (record.type === "input_image" && typeof record.image_url === "string") {
			const match = /^data:([^;,]+);base64,(.*)$/s.exec(record.image_url);
			if (!match) throw new Error("Code-mode runtime returned invalid image data URL");
			const mimeType = match[1];
			const data = match[2];
			if (mimeType === undefined || data === undefined) {
				throw new Error("Code-mode runtime returned incomplete image data URL");
			}
			content.push({ type: "image", mimeType, data });
		} else if (record.type === "input_audio" && typeof record.audio_url === "string") {
			content.push({ type: "text", text: `[audio output: ${record.audio_url}]` });
		} else {
			throw new Error("Code-mode runtime returned unsupported content item");
		}
	}
	truncateTextContent(content, Math.min(maxTokens * 4, outputBytes), 1);
	return { content, details: { cellId: response.cellId, status: response.kind } };
}

function outerErrorLimit(maxTokens: number, outputBytes: number): number {
	return Math.max(1, Math.min(DEFAULT_OUTER_ERROR_BYTES, maxTokens * 4, outputBytes));
}

function boundedOuterError(error: unknown, maximumBytes: number): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(truncateUtf8(message, maximumBytes), error instanceof Error ? { cause: error } : undefined);
}

function truncateUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value) <= maximumBytes) return value;
	if (maximumBytes <= 3) return ".".repeat(maximumBytes);
	let end = Math.min(value.length, maximumBytes - 3);
	while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maximumBytes - 3) end--;
	return `${value.slice(0, end)}...`;
}

function truncateTextContent(
	content: AgentToolResult<unknown>["content"],
	maximumCharacters: number,
	startIndex: number,
): void {
	let remaining = maximumCharacters;
	for (const item of content.slice(startIndex)) {
		if (item.type !== "text") continue;
		if (remaining <= 0) item.text = "";
		else if (item.text.length > remaining) {
			item.text = `${item.text.slice(0, Math.max(0, remaining - 1))}…`;
			remaining = 0;
		} else remaining -= item.text.length;
	}
}

function boundedId(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.length > 1_024) {
		throw new Error(`Invalid code-mode ${label}`);
	}
	return value;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Malformed code-mode ${label}`);
	}
	return value as Record<string, unknown>;
}

function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error("Operation aborted");
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		if (seen.has(value)) return value;
		seen.add(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
		Object.freeze(value);
	}
	return value;
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

function emptyMetrics(): HostMetrics {
	return {
		requests: 0,
		delegates: 0,
		framesRead: 0,
		framesWritten: 0,
		bytesRead: 0,
		bytesWritten: 0,
	};
}
