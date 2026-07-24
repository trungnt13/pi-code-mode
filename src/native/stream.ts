/* Adapted from @howaboua/pi-codex-conversion commit 3d55dffaf22a47854f568d3d2d742b979cfbc55f (MIT). */
import { arch, platform, release } from "node:os";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	NATIVE_MAX_BUFFER_BYTES,
	NATIVE_MAX_EVENTS,
	NATIVE_MAX_HEADER_BYTES,
	NATIVE_MAX_HEADER_COUNT,
	NATIVE_MAX_ID_BYTES,
	NATIVE_MAX_IDS,
	NATIVE_MAX_JWT_BYTES,
	NATIVE_MAX_OUTPUT_ITEMS,
	NATIVE_MAX_PROVIDER_ERROR_BYTES,
	NATIVE_MAX_REQUEST_BYTES,
	NATIVE_MAX_RETRIES,
	NATIVE_MAX_STREAM_BYTES,
} from "../constants.js";
import { assertJsonStructure, encodeJsonBounded } from "../runtime/frame-codec.js";
import { applyNativeExecContract } from "./contract.js";
import { nativeErrorText } from "./error-text.js";
import { transformMessages } from "./transform-messages.js";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const ACCOUNT_CLAIM = "https://api.openai.com/auth";
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const TERMINAL_RATE_LIMIT =
	/GoUsageLimitError|FreeUsageLimitError|usage[_ ]limit[_ ]reached|usage_not_included|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const TRANSIENT_ERROR = /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i;
const NOOP_EVENTS = new Set(["response.in_progress", "response.queued"]);

type Json = Record<string, unknown>;
type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
type TextBlock = Extract<AssistantMessage["content"][number], { type: "text" }>;
type ThinkingBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
type TextPartFamily = "output_text" | "refusal";
type ThinkingPartFamily = "reasoning_summary_text" | "reasoning_text";
type StreamPart<F extends string> = {
	family: F;
	chunks: BoundedChunks;
	valueDone: boolean;
	added: boolean;
	partDone: boolean;
	active: boolean;
};

class BoundedChunks {
	readonly chunks: string[] = [];
	bytes = 0;
	append(value: string, budget: StreamBudget): void {
		const size = Buffer.byteLength(value);
		if (this.bytes + size > NATIVE_MAX_BUFFER_BYTES)
			throw new Error(`Native item exceeds ${NATIVE_MAX_BUFFER_BYTES} bytes`);
		budget.addBytes(size);
		this.bytes += size;
		this.chunks.push(value);
	}
	finish(): string {
		return this.chunks.join("");
	}
}
class StreamBudget {
	events = 0;
	items = 0;
	ids = 0;
	bytes = 0;
	addEvent(): void {
		if (++this.events > NATIVE_MAX_EVENTS) throw new Error(`Native stream exceeds ${NATIVE_MAX_EVENTS} events`);
	}
	addItem(): void {
		if (++this.items > NATIVE_MAX_OUTPUT_ITEMS)
			throw new Error(`Native stream exceeds ${NATIVE_MAX_OUTPUT_ITEMS} output items`);
	}
	addId(): void {
		if (++this.ids > NATIVE_MAX_IDS) throw new Error(`Native stream exceeds ${NATIVE_MAX_IDS} IDs`);
	}
	addBytes(size: number): void {
		this.bytes += size;
		if (this.bytes > NATIVE_MAX_STREAM_BYTES)
			throw new Error(`Native content exceeds ${NATIVE_MAX_STREAM_BYTES} bytes`);
	}
}

type NativeState =
	| {
			kind: "custom";
			block: ToolCall;
			index: number;
			chunks: BoundedChunks;
			itemId: string;
			callId: string;
			done: boolean;
	  }
	| {
			kind: "function";
			block: ToolCall & { partialJson?: string };
			index: number;
			chunks: BoundedChunks;
			itemId: string;
			callId: string;
			done: boolean;
	  }
	| {
			kind: "text";
			block: TextBlock;
			index: number;
			itemId: string;
			parts: Map<number, StreamPart<TextPartFamily>>;
			order: number[];
	  }
	| {
			kind: "thinking";
			block: ThinkingBlock;
			index: number;
			itemId: string;
			summaryParts: Map<number, StreamPart<ThinkingPartFamily>>;
			contentParts: Map<number, StreamPart<ThinkingPartFamily>>;
			order: Array<{ family: ThinkingPartFamily; index: number }>;
	  };

export function streamNativeCodeMode(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	const output = initialMessage(model);
	void runNativeRequest(model, context, options, stream, output);
	return stream;
}

export function buildNativeRequest(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Json {
	const sessionId = (options as (SimpleStreamOptions & { sessionId?: string }) | undefined)?.sessionId;
	const body: Json = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt || "You are a helpful assistant.",
		input: convertMessages(model, context),
		text: { verbosity: "low" },
		tools: (context.tools ?? []).map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: null,
		})),
		tool_choice: "auto",
		parallel_tool_calls: true,
		include: ["reasoning.encrypted_content"],
		...(sessionId ? { prompt_cache_key: Array.from(sessionId).slice(0, 64).join("") } : {}),
	};
	if (options?.temperature !== undefined) body.temperature = options.temperature;
	const reasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	if (reasoning !== undefined && reasoning !== "off") {
		const effort = model.thinkingLevelMap?.[reasoning] ?? reasoning;
		if (effort !== null) body.reasoning = { effort, summary: "auto" };
	}
	return applyNativeExecContract(body, true);
}

export function resolveNativeCodexUrl(baseUrl?: string): string {
	const raw = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
	const parsed = new URL(raw);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Codex base URL must use HTTP(S)");
	if (raw.endsWith("/codex/responses")) return raw;
	if (raw.endsWith("/codex")) return `${raw}/responses`;
	return `${raw}/codex/responses`;
}

export function extractNativeAccountId(token: string): string {
	if (!token || Buffer.byteLength(token) > NATIVE_MAX_JWT_BYTES) throw new Error("Invalid Codex OAuth token");
	const parts = token.split(".");
	const encoded = parts[1];
	if (parts.length !== 3 || !encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid Codex OAuth token");
	try {
		const bytes = Buffer.from(encoded, "base64url");
		if (bytes.byteLength > NATIVE_MAX_JWT_BYTES) throw new Error("oversize");
		const payload: unknown = JSON.parse(bytes.toString("utf8"));
		assertJsonStructure(payload, "Codex OAuth token", { maxDepth: 16, maxItems: 1024 });
		const claims = isRecord(payload) && isRecord(payload[ACCOUNT_CLAIM]) ? payload[ACCOUNT_CLAIM] : undefined;
		return boundedId(claims?.chatgpt_account_id, "Codex account");
	} catch {
		throw new Error("Failed to extract account ID from Codex OAuth token");
	}
}

export function buildNativeCodexHeaders(
	modelHeaders: Record<string, string> | undefined,
	optionHeaders: Record<string, string | null> | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const merged = mergeHeaders(modelHeaders, optionHeaders);
	assertHeaderBounds(merged);
	const headers = new Headers(merged);
	headers.set("authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("user-agent", `pi (${platform()} ${release()}; ${arch()})`);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (sessionId) {
		const id = boundedId(sessionId, "session");
		headers.set("session-id", id);
		headers.set("x-client-request-id", id);
	}
	assertHeaderBounds(Object.fromEntries(headers.entries()));
	return headers;
}

async function runNativeRequest(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): Promise<void> {
	try {
		throwIfAborted(options?.signal);
		let body = buildNativeRequest(model, context, options);
		const replacement = await options?.onPayload?.(body, model);
		if (replacement !== undefined) body = asRecord(replacement, "native payload");
		body = applyNativeExecContract(body, true);
		const payload = encodeJsonBounded(body, NATIVE_MAX_REQUEST_BYTES, "Native request");
		const token = options?.apiKey;
		if (!token) throw new Error(`No OAuth token for provider: ${model.provider}`);
		const accountId = extractNativeAccountId(token);
		const sessionId = (options as (SimpleStreamOptions & { sessionId?: string }) | undefined)?.sessionId;
		const headers = buildNativeCodexHeaders(model.headers, options?.headers, accountId, token, sessionId);
		const retries = boundedInteger(options?.maxRetries ?? 0, 0, NATIVE_MAX_RETRIES, "maxRetries");
		const timeoutMs =
			options?.timeoutMs === undefined ? undefined : boundedInteger(options.timeoutMs, 0, 2_147_483_647, "timeoutMs");
		const maxRetryDelay = options?.maxRetryDelayMs ?? 60_000;
		if (!Number.isSafeInteger(maxRetryDelay) || maxRetryDelay < 0) throw new Error("Invalid maxRetryDelayMs");
		let response: Response | undefined;
		let lastError: unknown;
		for (let attempt = 0; attempt <= retries; attempt++) {
			response = undefined;
			try {
				const signal = combinedSignal(options?.signal, timeoutMs);
				response = await fetch(resolveNativeCodexUrl(model.baseUrl), {
					method: "POST",
					headers,
					body: payload.toString("utf8"),
					signal,
				});
				const responseHeaders = boundedResponseHeaders(response.headers);
				await options?.onResponse?.({ status: response.status, headers: responseHeaders }, model);
				if (response.ok) break;
				const providerError = await readProviderError(response);
				lastError = new Error(`Codex HTTP ${response.status}: ${providerError.message}`);
				if (!isRetryableError(response.status, providerError.classification) || attempt === retries) throw lastError;
				await retryDelay(response.headers, response.status, attempt, maxRetryDelay, options?.signal);
			} catch (error) {
				lastError = error;
				if (options?.signal?.aborted || attempt === retries || response !== undefined) throw error;
				await retryDelay(undefined, undefined, attempt, maxRetryDelay, options?.signal);
			}
		}
		if (!response?.ok || !response.body) throw lastError ?? new Error("Codex response has no body");
		stream.push({ type: "start", partial: output });
		await processNativeEvents(parseNativeSse(response.body, options?.signal), output, stream, model, options);
		throwIfAborted(options?.signal);
		stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse" | "length", message: output });
		stream.end();
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = boundedText(nativeErrorText(error), NATIVE_MAX_PROVIDER_ERROR_BYTES);
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	}
}

export async function* parseNativeSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Json> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
	let finished = false;
	let abortSettled = false;
	let rejectAbort!: (reason: Error) => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const abort = () => {
		if (abortSettled) return;
		abortSettled = true;
		const reason = explicitAbortReason(signal);
		void reader.cancel(reason).catch(() => undefined);
		rejectAbort(reason);
	};
	if (signal) {
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	}
	let rawBytes = 0;
	let lineParts: string[] = [];
	let lineBytes = 0;
	let dataLines: string[] = [];
	let dataBytes = 0;
	const dispatch = (): Json | undefined => {
		if (!dataLines.length) return undefined;
		const data = dataLines.join("\n");
		dataLines = [];
		dataBytes = 0;
		if (data === "[DONE]") return undefined;
		const value: unknown = JSON.parse(data);
		assertJsonStructure(value, "Codex SSE event");
		return asRecord(value, "Codex SSE event");
	};
	const consumeLine = (line: string): Json | undefined => {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line) return dispatch();
		if (line.startsWith(":")) return undefined;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			const size = Buffer.byteLength(value) + (dataLines.length ? 1 : 0);
			dataBytes += size;
			if (dataBytes > NATIVE_MAX_BUFFER_BYTES)
				throw new Error(`Codex SSE event exceeds ${NATIVE_MAX_BUFFER_BYTES} bytes`);
			dataLines.push(value);
			return undefined;
		}
		if (field === "event" || field === "id" || field === "retry") return undefined;
		throw new Error(`Unsupported Codex SSE field ${field}`);
	};
	try {
		while (true) {
			if (abortSettled) await aborted;
			pendingRead = reader.read();
			const next = await Promise.race([pendingRead, aborted]);
			pendingRead = undefined;
			if (abortSettled) await aborted;
			if (next.done) {
				finished = true;
				break;
			}
			rawBytes += next.value.byteLength;
			if (rawBytes > NATIVE_MAX_STREAM_BYTES)
				throw new Error(`Codex SSE stream exceeds ${NATIVE_MAX_STREAM_BYTES} bytes`);
			const text = decoder.decode(next.value, { stream: true });
			let start = 0;
			for (let index = 0; index < text.length; index++)
				if (text.charCodeAt(index) === 10) {
					const part = text.slice(start, index);
					lineBytes += Buffer.byteLength(part);
					if (lineBytes > NATIVE_MAX_BUFFER_BYTES)
						throw new Error(`Codex SSE line exceeds ${NATIVE_MAX_BUFFER_BYTES} bytes`);
					lineParts.push(part);
					const event = consumeLine(lineParts.join(""));
					lineParts = [];
					lineBytes = 0;
					start = index + 1;
					if (event) yield event;
				}
			const tail = text.slice(start);
			if (tail) {
				lineBytes += Buffer.byteLength(tail);
				if (lineBytes > NATIVE_MAX_BUFFER_BYTES)
					throw new Error(`Codex SSE line exceeds ${NATIVE_MAX_BUFFER_BYTES} bytes`);
				lineParts.push(tail);
			}
		}
		const tail = decoder.decode();
		if (tail) {
			lineBytes += Buffer.byteLength(tail);
			lineParts.push(tail);
		}
		if (lineParts.length) {
			const event = consumeLine(lineParts.join(""));
			if (event) yield event;
		}
		const final = dispatch();
		if (final) yield final;
	} finally {
		signal?.removeEventListener("abort", abort);
		if (!finished && !abortSettled) void reader.cancel().catch(() => undefined);
		if (pendingRead) await pendingRead.catch(() => undefined);
		reader.releaseLock();
	}
}

export async function processNativeEvents(
	events: AsyncIterable<Json>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	options?: SimpleStreamOptions,
): Promise<void> {
	const states = new Map<number, NativeState>();
	const usedIndices = new Set<number>();
	const itemIds = new Set<string>();
	const callIds = new Set<string>();
	const reasoningBlocks = new Map<string, ThinkingBlock>();
	const budget = new StreamBudget();
	let terminal = false;
	let createdResponseId: string | undefined;
	let responsePhase: "queued" | "in_progress" | undefined;
	for await (const event of events) {
		throwIfAborted(options?.signal);
		budget.addEvent();
		if (terminal) throw new Error("Native stream emitted an event after terminal response");
		const type = requireString(event.type, "response event type");
		if (type === "response.created") {
			if (createdResponseId !== undefined) throw new Error("Duplicate response.created event");
			const response = asRecord(event.response, "created response");
			if (response.status !== "in_progress" && response.status !== "queued")
				throw new Error("Invalid created response status");
			createdResponseId = boundedId(response.id, "response");
			responsePhase = response.status;
			output.responseId = createdResponseId;
			continue;
		}
		if (type === "response.output_item.added") {
			if (createdResponseId === undefined) throw new Error("Output item arrived before response.created");
			const outputIndex = requireIndex(event.output_index);
			if (usedIndices.has(outputIndex)) throw new Error(`Reused native output index ${outputIndex}`);
			usedIndices.add(outputIndex);
			budget.addItem();
			const item = asRecord(event.item, "output item");
			const itemType = requireString(item.type, "output item type");
			if (item.status !== "in_progress") throw new Error("Added native output item has invalid status");
			const itemId = uniqueWireId(item.id, `${itemType} item`, itemIds, budget);
			if (itemType === "custom_tool_call") {
				rejectToolIdDelimiter(itemId, "custom item");
				const callId = uniqueWireId(item.call_id, "custom call", callIds, budget);
				rejectToolIdDelimiter(callId, "custom call");
				if (item.name !== "exec") throw new Error(`Native custom tool must be exec, received ${String(item.name)}`);
				const initial = optionalString(item.input, "custom input") ?? "";
				const chunks = new BoundedChunks();
				chunks.append(initial, budget);
				const block: ToolCall = {
					type: "toolCall",
					id: `${callId}|${itemId}`,
					name: "exec",
					arguments: { code: initial },
				};
				output.content.push(block);
				states.set(outputIndex, {
					kind: "custom",
					block,
					index: output.content.length - 1,
					chunks,
					itemId,
					callId,
					done: false,
				});
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
			} else if (itemType === "function_call") {
				rejectToolIdDelimiter(itemId, "function item");
				const callId = uniqueWireId(item.call_id, "function call", callIds, budget);
				rejectToolIdDelimiter(callId, "function call");
				const name = boundedId(item.name, "function name");
				if (name !== "wait") throw new Error(`Native function tool must be wait, received ${name}`);
				const initial = optionalString(item.arguments, "function arguments") ?? "";
				const chunks = new BoundedChunks();
				chunks.append(initial, budget);
				const block: ToolCall & { partialJson?: string } = {
					type: "toolCall",
					id: `${callId}|${itemId}`,
					name,
					arguments: partialArguments(initial),
					partialJson: initial,
				};
				output.content.push(block);
				states.set(outputIndex, {
					kind: "function",
					block,
					index: output.content.length - 1,
					chunks,
					itemId,
					callId,
					done: false,
				});
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
			} else if (itemType === "message") {
				const block: TextBlock = { type: "text", text: "" };
				output.content.push(block);
				states.set(outputIndex, {
					kind: "text",
					block,
					index: output.content.length - 1,
					itemId,
					parts: new Map(),
					order: [],
				});
				stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
			} else if (itemType === "reasoning") {
				const block: ThinkingBlock = { type: "thinking", thinking: "" };
				output.content.push(block);
				states.set(outputIndex, {
					kind: "thinking",
					block,
					index: output.content.length - 1,
					itemId,
					summaryParts: new Map(),
					contentParts: new Map(),
					order: [],
				});
				stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
			} else throw new Error(`Unsupported native output item type ${itemType}`);
			continue;
		}
		if (type === "response.custom_tool_call_input.delta") {
			const state = requireState(states, event.output_index, "custom");
			if (state.done) throw new Error("Native custom delta arrived after input done");
			matchItemId(event, state.itemId, "custom delta");
			const delta = requireStringAllowEmpty(event.delta, "custom input delta");
			state.chunks.append(delta, budget);
			stream.push({ type: "toolcall_delta", contentIndex: state.index, delta, partial: output });
			continue;
		}
		if (type === "response.custom_tool_call_input.done") {
			const state = requireState(states, event.output_index, "custom");
			if (state.done) throw new Error("Duplicate native custom input done");
			matchItemId(event, state.itemId, "custom done");
			const input = requireStringAllowEmpty(event.input, "custom done input");
			const suffix = appendCompletionSuffix(
				state.chunks,
				input,
				budget,
				"Native custom done input differs from streamed prefix",
			);
			if (suffix) stream.push({ type: "toolcall_delta", contentIndex: state.index, delta: suffix, partial: output });
			state.done = true;
			state.block.arguments = { code: input };
			continue;
		}
		if (type === "response.function_call_arguments.delta") {
			const state = requireState(states, event.output_index, "function");
			if (state.done) throw new Error("Function delta arrived after arguments done");
			matchItemId(event, state.itemId, "function delta");
			const delta = requireStringAllowEmpty(event.delta, "function arguments delta");
			state.chunks.append(delta, budget);
			stream.push({ type: "toolcall_delta", contentIndex: state.index, delta, partial: output });
			continue;
		}
		if (type === "response.function_call_arguments.done") {
			const state = requireState(states, event.output_index, "function");
			if (state.done) throw new Error("Duplicate function arguments done");
			matchItemId(event, state.itemId, "function done");
			const text = requireStringAllowEmpty(event.arguments, "function arguments");
			const suffix = appendCompletionSuffix(
				state.chunks,
				text,
				budget,
				"Function arguments done differs from streamed prefix",
			);
			if (suffix) stream.push({ type: "toolcall_delta", contentIndex: state.index, delta: suffix, partial: output });
			state.done = true;
			state.block.arguments = completeArguments(text);
			state.block.partialJson = text;
			continue;
		}
		if (type === "response.output_text.delta" || type === "response.refusal.delta") {
			const state = requireState(states, event.output_index, "text");
			const family = type === "response.output_text.delta" ? "output_text" : "refusal";
			matchItemId(event, state.itemId, "text delta");
			const part = ensureTextPart(state, requireIndex(event.content_index), family);
			if (part.valueDone || part.partDone) throw new Error("Native text delta arrived after matching part done");
			const delta = requireStringAllowEmpty(event.delta, "text delta");
			part.active = true;
			part.chunks.append(delta, budget);
			stream.push({ type: "text_delta", contentIndex: state.index, delta, partial: output });
			continue;
		}
		if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
			const state = requireState(states, event.output_index, "thinking");
			matchItemId(event, state.itemId, "reasoning delta");
			const family = type === "response.reasoning_summary_text.delta" ? "reasoning_summary_text" : "reasoning_text";
			const partIndex = requireIndex(family === "reasoning_summary_text" ? event.summary_index : event.content_index);
			const { part, separator } = ensureThinkingPart(state, partIndex, family, budget);
			if (separator)
				stream.push({ type: "thinking_delta", contentIndex: state.index, delta: separator, partial: output });
			if (part.valueDone || part.partDone) throw new Error("Native reasoning delta arrived after matching part done");
			const delta = requireStringAllowEmpty(event.delta, "reasoning delta");
			part.active = true;
			part.chunks.append(delta, budget);
			stream.push({ type: "thinking_delta", contentIndex: state.index, delta, partial: output });
			continue;
		}
		if (type === "response.output_text.done" || type === "response.refusal.done") {
			const state = requireState(states, event.output_index, "text");
			const family = type === "response.output_text.done" ? "output_text" : "refusal";
			matchItemId(event, state.itemId, "text done");
			const part = ensureTextPart(state, requireIndex(event.content_index), family);
			if (part.valueDone) throw new Error("Duplicate native text part done");
			if (part.partDone) throw new Error("Native text value done arrived after content part done");
			const value =
				family === "refusal"
					? requireStringAllowEmpty(event.refusal, "refusal done")
					: requireStringAllowEmpty(event.text, "output text done");
			if (value !== part.chunks.finish()) throw new Error("Native text done payload mismatch");
			part.valueDone = true;
			part.active = true;
			continue;
		}
		if (type === "response.reasoning_summary_text.done" || type === "response.reasoning_text.done") {
			const state = requireState(states, event.output_index, "thinking");
			const family = type === "response.reasoning_summary_text.done" ? "reasoning_summary_text" : "reasoning_text";
			matchItemId(event, state.itemId, "reasoning done");
			const partIndex = requireIndex(family === "reasoning_summary_text" ? event.summary_index : event.content_index);
			const { part } = ensureThinkingPart(state, partIndex, family, budget);
			if (part.valueDone) throw new Error("Duplicate native reasoning part done");
			if (part.partDone) throw new Error("Native reasoning value done arrived after part done");
			if (requireStringAllowEmpty(event.text, "reasoning done") !== part.chunks.finish())
				throw new Error("Native reasoning done payload mismatch");
			part.valueDone = true;
			part.active = true;
			continue;
		}
		if (type === "response.content_part.added" || type === "response.content_part.done") {
			const outputIndex = requireIndex(event.output_index);
			const state = states.get(outputIndex);
			if (!state || (state.kind !== "text" && state.kind !== "thinking"))
				throw new Error(`Native content part targets unknown output index ${outputIndex}`);
			matchItemId(event, state.itemId, "content part");
			const partValue = asRecord(event.part, "content part");
			const contentIndex = requireIndex(event.content_index);
			const family = requireString(partValue.type, "content part type");
			const text =
				family === "refusal"
					? requireStringAllowEmpty(partValue.refusal, "content refusal")
					: requireStringAllowEmpty(partValue.text, "content text");
			const part =
				state.kind === "text" && (family === "output_text" || family === "refusal")
					? ensureTextPart(state, contentIndex, family)
					: state.kind === "thinking" && family === "reasoning_text"
						? ensureThinkingPart(state, contentIndex, family, budget).part
						: undefined;
			if (!part) throw new Error("Native content part family does not match output item");
			if (type === "response.content_part.added") {
				if (part.added || part.active) throw new Error("Duplicate or late native content part added");
				part.added = true;
				if (text) {
					part.chunks.append(text, budget);
					stream.push({
						type: state.kind === "text" ? "text_delta" : "thinking_delta",
						contentIndex: state.index,
						delta: text,
						partial: output,
					});
				}
			} else {
				if (part.partDone) throw new Error("Duplicate native content part done");
				if (text !== part.chunks.finish()) throw new Error("Native content part done payload mismatch");
				part.partDone = true;
				part.active = true;
			}
			continue;
		}
		if (type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done") {
			const state = requireState(states, event.output_index, "thinking");
			matchItemId(event, state.itemId, "reasoning summary part");
			const summaryIndex = requireIndex(event.summary_index);
			const { part, separator } = ensureThinkingPart(state, summaryIndex, "reasoning_summary_text", budget);
			if (separator)
				stream.push({ type: "thinking_delta", contentIndex: state.index, delta: separator, partial: output });
			const partValue = asRecord(event.part, "reasoning summary part");
			if (partValue.type !== "summary_text") throw new Error("Invalid reasoning summary part type");
			const text = requireStringAllowEmpty(partValue.text, "reasoning summary part text");
			if (type === "response.reasoning_summary_part.added") {
				if (part.added || part.active) throw new Error("Duplicate or late reasoning summary part added");
				part.added = true;
				if (text) {
					part.chunks.append(text, budget);
					stream.push({ type: "thinking_delta", contentIndex: state.index, delta: text, partial: output });
				}
			} else {
				if (part.partDone) throw new Error("Duplicate reasoning summary part done");
				if (text !== part.chunks.finish()) throw new Error("Reasoning summary part done payload mismatch");
				part.partDone = true;
				part.active = true;
			}
			continue;
		}
		if (type === "response.output_item.done") {
			const outputIndex = requireIndex(event.output_index);
			const state = states.get(outputIndex);
			if (!state) throw new Error(`Native completion targets unknown output index ${outputIndex}`);
			const item = asRecord(event.item, "completed output item");
			if (item.status !== "completed") throw new Error("Native output item has non-completed status");
			if (state.kind === "custom") {
				if (
					item.type !== "custom_tool_call" ||
					item.id !== state.itemId ||
					item.call_id !== state.callId ||
					item.name !== "exec"
				)
					throw new Error("Native custom completion identity mismatch");
				const input = requireStringAllowEmpty(item.input, "completed custom input");
				let suffix = "";
				if (state.done) {
					if (input !== state.chunks.finish()) throw new Error("Native custom completion input mismatch");
				} else {
					suffix = appendCompletionSuffix(
						state.chunks,
						input,
						budget,
						"Native custom completion input differs from streamed prefix",
					);
				}
				if (suffix) stream.push({ type: "toolcall_delta", contentIndex: state.index, delta: suffix, partial: output });
				state.done = true;
				const toolCall: ToolCall = { ...state.block, arguments: { code: input } };
				output.content[state.index] = toolCall;
				stream.push({ type: "toolcall_end", contentIndex: state.index, toolCall, partial: output });
			} else if (state.kind === "function") {
				if (
					item.type !== "function_call" ||
					item.id !== state.itemId ||
					item.call_id !== state.callId ||
					item.name !== state.block.name
				)
					throw new Error("Function completion identity mismatch");
				const text = requireStringAllowEmpty(item.arguments, "completed function arguments");
				let suffix = "";
				if (state.done) {
					if (text !== state.chunks.finish()) throw new Error("Function completion arguments mismatch");
				} else {
					suffix = appendCompletionSuffix(
						state.chunks,
						text,
						budget,
						"Function completion arguments differ from streamed prefix",
					);
				}
				if (suffix) stream.push({ type: "toolcall_delta", contentIndex: state.index, delta: suffix, partial: output });
				state.done = true;
				state.block.arguments = completeArguments(text);
				delete state.block.partialJson;
				stream.push({ type: "toolcall_end", contentIndex: state.index, toolCall: state.block, partial: output });
			} else if (state.kind === "text") {
				if (item.type !== "message" || item.id !== state.itemId || item.status !== "completed")
					throw new Error("Text completion identity or status mismatch");
				const text = completedText(item);
				const streamed = finishTextParts(state);
				if (streamed && text !== streamed) throw new Error("Text completion differs from streamed text");
				state.block.text = text || streamed;
				state.block.textSignature = JSON.stringify({
					v: 1,
					id: state.itemId,
					...(validTextPhase(item.phase) ? { phase: item.phase } : {}),
				});
				stream.push({ type: "text_end", contentIndex: state.index, content: state.block.text, partial: output });
			} else {
				if (item.type !== "reasoning" || item.id !== state.itemId)
					throw new Error("Reasoning completion identity mismatch");
				const thinking = completedReasoning(item);
				const streamed = finishThinkingParts(state);
				if (streamed && thinking && thinking !== streamed)
					throw new Error("Reasoning completion differs from streamed reasoning");
				state.block.thinking = thinking || streamed;
				const signature = JSON.stringify(item);
				if (Buffer.byteLength(signature) > NATIVE_MAX_BUFFER_BYTES)
					throw new Error("Reasoning signature exceeds native item limit");
				state.block.thinkingSignature = signature;
				reasoningBlocks.set(state.itemId, state.block);
				stream.push({
					type: "thinking_end",
					contentIndex: state.index,
					content: state.block.thinking,
					partial: output,
				});
			}
			states.delete(outputIndex);
			continue;
		}
		if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
			if (createdResponseId === undefined) throw new Error("Terminal response arrived before response.created");
			if (states.size) throw new Error("Native stream terminated with unfinished output items");
			const response = asRecord(event.response, "terminal response");
			if (response.status !== "completed" && response.status !== "incomplete")
				throw new Error("Native terminal response status must be completed or incomplete");
			const terminalId = boundedId(response.id, "response");
			if (createdResponseId !== undefined && terminalId !== createdResponseId)
				throw new Error("Native terminal response ID mismatch");
			output.responseId = terminalId;
			backfillReasoningSignatures(response, reasoningBlocks);
			applyUsage(output, response, model);
			output.stopReason =
				response.status === "incomplete"
					? "length"
					: output.content.some((block) => block.type === "toolCall")
						? "toolUse"
						: "stop";
			terminal = true;
			continue;
		}
		if (type === "response.failed" || type === "error") throw new Error(streamError(event));
		if (NOOP_EVENTS.has(type)) {
			validateNoopEvent(type, event, createdResponseId);
			if (type === "response.queued" && (responsePhase === "in_progress" || usedIndices.size))
				throw new Error("Native response regressed to queued after in-progress");
			if (type === "response.in_progress") responsePhase = "in_progress";
			continue;
		}
		throw new Error(`Unsupported native response event ${type}`);
	}
	if (!terminal) throw new Error("Native stream closed before terminal response");
}

function convertMessages(model: Model<Api>, context: Context): unknown[] {
	const output: unknown[] = [];
	const seenCalls = new Map<string, string>();
	const pairedCalls = new Set<string>();
	let textIndex = 0;
	validateOriginalToolPairs(context);
	const normalizeToolCallId = (id: string, _target: Model<Api>, source: AssistantMessage): string => {
		const [callId, itemId] = splitToolId(id);
		const normalizedCallId = normalizeIdPart(callId);
		if (itemId === undefined) return normalizedCallId;
		const foreign = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = foreign ? `fc_${shortHash(itemId)}` : normalizeIdPart(itemId);
		if (!normalizedItemId.startsWith("fc_")) normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		return `${normalizedCallId}|${normalizedItemId}`;
	};
	const messages = transformMessages(context.messages, model, normalizeToolCallId);
	for (const message of messages) {
		if (message.role === "user") {
			const content =
				typeof message.content === "string"
					? [{ type: "input_text", text: message.content }]
					: message.content.map((part) =>
							part.type === "text"
								? { type: "input_text", text: part.text }
								: { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}`, detail: "auto" },
						);
			output.push({ role: "user", content });
		} else if (message.role === "assistant") {
			const differentModel =
				message.model !== model.id && message.provider === model.provider && message.api === model.api;
			for (const block of message.content) {
				if (block.type === "text") {
					const signature = parseTextSignature(block.textSignature);
					const rawId = signature?.id || `msg_pi_${textIndex++}`;
					output.push({
						type: "message",
						id: rawId.length > 64 ? `msg_${shortHash(rawId)}` : rawId,
						role: "assistant",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
						status: "completed",
						...(signature?.phase ? { phase: signature.phase } : {}),
					});
				} else if (block.type === "thinking" && block.thinkingSignature) {
					let signature: unknown;
					try {
						signature = JSON.parse(block.thinkingSignature);
					} catch {
						throw new Error("Invalid replay reasoning signature JSON");
					}
					assertJsonStructure(signature, "Replay reasoning signature");
					if (!isRecord(signature)) throw new Error("Replay reasoning signature must be an object");
					output.push(signature);
				} else if (block.type === "toolCall") {
					const [callId, itemId] = splitToolId(block.id);
					if (seenCalls.has(callId)) throw new Error(`Duplicate replay tool call ID ${callId}`);
					seenCalls.set(callId, block.name);
					output.push({
						type: "function_call",
						...(itemId && !(differentModel && itemId.startsWith("fc_")) ? { id: itemId } : {}),
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
			}
		} else if (message.role === "toolResult") {
			const [callId] = splitToolId(message.toolCallId);
			const expectedName = seenCalls.get(callId);
			if (!expectedName) throw new Error(`Tool result has no preceding call ${callId}`);
			if (expectedName !== message.toolName) throw new Error(`Tool result name mismatch for ${callId}`);
			if (pairedCalls.has(callId)) throw new Error(`Duplicate tool result for ${callId}`);
			pairedCalls.add(callId);
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const images = message.content.filter((part) => part.type === "image");
			const result =
				images.length && model.input.includes("image")
					? [
							...(text ? [{ type: "input_text", text }] : []),
							...images.map((part) => ({
								type: "input_image",
								detail: "auto",
								image_url: `data:${part.mimeType};base64,${part.data}`,
							})),
						]
					: text || (images.length ? "(see attached image)" : "(no tool output)");
			output.push({ type: "function_call_output", call_id: callId, output: result });
		}
	}
	return output;
}

function initialMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function applyUsage(output: AssistantMessage, response: Json, model: Model<Api>): void {
	const usage = isRecord(response.usage) ? response.usage : {};
	const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
	const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
	const cacheRead = number(details.cached_tokens);
	const cacheWrite = number(details.cache_write_tokens);
	const totalInput = number(usage.input_tokens);
	output.usage = {
		input: Math.max(0, totalInput - cacheRead - cacheWrite),
		output: number(usage.output_tokens),
		reasoning: Math.max(0, number(outputDetails.reasoning_tokens)),
		cacheRead,
		cacheWrite,
		totalTokens: number(usage.total_tokens),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, output.usage);
}

function requireState<K extends NativeState["kind"]>(
	states: Map<number, NativeState>,
	value: unknown,
	kind: K,
): Extract<NativeState, { kind: K }> {
	const index = requireIndex(value);
	const state = states.get(index);
	if (!state || state.kind !== kind) throw new Error(`Native ${kind} event targets unknown output index ${index}`);
	return state as Extract<NativeState, { kind: K }>;
}
function requireIndex(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= NATIVE_MAX_OUTPUT_ITEMS)
		throw new Error("Invalid native output index");
	return value as number;
}
function boundedInteger(value: number, min: number, max: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
	return value;
}
function boundedId(value: unknown, label: string): string {
	const id = requireString(value, `${label} ID`);
	if (Buffer.byteLength(id) > NATIVE_MAX_ID_BYTES) throw new Error(`${label} ID exceeds ${NATIVE_MAX_ID_BYTES} bytes`);
	return id;
}
function wireId(value: unknown, label: string, budget: StreamBudget): string {
	const id = boundedId(value, label);
	budget.addId();
	return id;
}
function uniqueWireId(value: unknown, label: string, seen: Set<string>, budget: StreamBudget): string {
	const id = wireId(value, label, budget);
	if (seen.has(id)) throw new Error(`Duplicate native ${label} ID`);
	seen.add(id);
	return id;
}
function rejectToolIdDelimiter(value: string, label: string): void {
	if (value.includes("|")) throw new Error(`Native ${label} ID contains reserved delimiter`);
}
function matchItemId(event: Json, expected: string, label: string): void {
	if (boundedId(event.item_id, label) !== expected) throw new Error(`Native ${label} item ID mismatch`);
}
function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}`);
	return value;
}
function requireStringAllowEmpty(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`Invalid ${label}`);
	return value;
}
function optionalString(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : requireStringAllowEmpty(value, label);
}
function partialArguments(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value || "{}");
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
function completeArguments(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value || "{}");
	assertJsonStructure(parsed, "Function arguments");
	if (!isRecord(parsed)) throw new Error("Function arguments must decode to an object");
	return parsed;
}
function appendCompletionSuffix(
	chunks: BoundedChunks,
	completed: string,
	budget: StreamBudget,
	mismatchMessage: string,
): string {
	const streamed = chunks.finish();
	if (!completed.startsWith(streamed)) throw new Error(mismatchMessage);
	const suffix = completed.slice(streamed.length);
	if (suffix) chunks.append(suffix, budget);
	return suffix;
}
function ensureTextPart(
	state: Extract<NativeState, { kind: "text" }>,
	index: number,
	family: TextPartFamily,
): StreamPart<TextPartFamily> {
	const existing = state.parts.get(index);
	if (existing) {
		if (existing.family !== family) throw new Error("Native text content index changed family");
		if (index !== state.parts.size - 1) throw new Error("Native text content index reopened after later part");
		return existing;
	}
	if (index !== state.parts.size) throw new Error("Native text content index skipped or reopened");
	const part = { family, chunks: new BoundedChunks(), valueDone: false, added: false, partDone: false, active: false };
	state.parts.set(index, part);
	state.order.push(index);
	return part;
}
function ensureThinkingPart(
	state: Extract<NativeState, { kind: "thinking" }>,
	index: number,
	family: ThinkingPartFamily,
	budget: StreamBudget,
): { part: StreamPart<ThinkingPartFamily>; separator?: string } {
	const parts = family === "reasoning_summary_text" ? state.summaryParts : state.contentParts;
	const existing = parts.get(index);
	if (existing) {
		if (index !== parts.size - 1) throw new Error("Native reasoning part index reopened after later part");
		return { part: existing };
	}
	if (index !== parts.size) throw new Error("Native reasoning part index skipped or reopened");
	const part = { family, chunks: new BoundedChunks(), valueDone: false, added: false, partDone: false, active: false };
	parts.set(index, part);
	state.order.push({ family, index });
	if (index > 0) {
		budget.addBytes(2);
		return { part, separator: "\n\n" };
	}
	return { part };
}
function finishTextParts(state: Extract<NativeState, { kind: "text" }>): string {
	return state.order.map((index) => state.parts.get(index)?.chunks.finish() ?? "").join("");
}
function finishThinkingParts(state: Extract<NativeState, { kind: "thinking" }>): string {
	const parts = state.summaryParts.size ? state.summaryParts : state.contentParts;
	return [...parts.values()].map((part) => part.chunks.finish()).join("\n\n");
}
function completedText(item: Json): string {
	if (!Array.isArray(item.content)) throw new Error("Completed message content must be an array");
	const chunks: string[] = [];
	let bytes = 0;
	for (const part of item.content) {
		if (!isRecord(part) || (part.type !== "output_text" && part.type !== "refusal"))
			throw new Error("Unsupported completed message content part");
		const text =
			part.type === "refusal"
				? requireStringAllowEmpty(part.refusal, "refusal")
				: requireStringAllowEmpty(part.text, "output text");
		bytes += Buffer.byteLength(text);
		if (bytes > NATIVE_MAX_BUFFER_BYTES) throw new Error("Completed text exceeds native item limit");
		chunks.push(text);
	}
	return chunks.join("");
}
function completedReasoning(item: Json): string {
	const source =
		Array.isArray(item.summary) && item.summary.length
			? { parts: item.summary, type: "summary_text", label: "reasoning summary" }
			: Array.isArray(item.content) && item.content.length
				? { parts: item.content, type: "reasoning_text", label: "reasoning content" }
				: undefined;
	if (!source) {
		if (item.summary !== undefined && !Array.isArray(item.summary))
			throw new Error("Reasoning summary must be an array");
		if (item.content !== undefined && !Array.isArray(item.content))
			throw new Error("Reasoning content must be an array");
		return "";
	}
	const chunks: string[] = [];
	let bytes = 0;
	for (const part of source.parts) {
		if (!isRecord(part) || part.type !== source.type) throw new Error(`Unsupported ${source.label} part`);
		const text = requireStringAllowEmpty(part.text, source.label);
		bytes += Buffer.byteLength(text);
		if (bytes > NATIVE_MAX_BUFFER_BYTES) throw new Error("Reasoning summary exceeds native item limit");
		chunks.push(text);
	}
	return chunks.join("\n\n");
}
function validateNoopEvent(type: string, event: Json, createdResponseId: string | undefined): void {
	if (type === "response.in_progress" || type === "response.queued") {
		if (createdResponseId === undefined) throw new Error(`${type} arrived before response.created`);
		const response = asRecord(event.response, type);
		if (boundedId(response.id, "response") !== createdResponseId) throw new Error(`${type} response ID mismatch`);
		const expected = type === "response.queued" ? "queued" : "in_progress";
		if (response.status !== expected) throw new Error(`${type} status mismatch`);
		return;
	}
	throw new Error(`Unsupported native no-op event ${type}`);
}
function splitToolId(value: string): [string, string | undefined] {
	const parts = value.split("|");
	if (parts.length > 2) throw new Error("Invalid replay tool call ID: multiple reserved delimiters");
	const callId = boundedId(parts[0], "replay tool call");
	if (parts.length === 1) return [callId, undefined];
	return [callId, boundedId(parts[1], "replay tool item")];
}
function validateOriginalToolPairs(context: Context): void {
	const calls = new Map<string, string>();
	const results = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				splitToolId(block.id);
				if (calls.has(block.id)) throw new Error(`Duplicate replay tool call ID ${block.id}`);
				calls.set(block.id, block.name);
			}
		} else if (message.role === "toolResult") {
			splitToolId(message.toolCallId);
			const name = calls.get(message.toolCallId);
			if (!name) throw new Error(`Tool result has no preceding call ${message.toolCallId}`);
			if (name !== message.toolName) throw new Error(`Tool result name mismatch for ${message.toolCallId}`);
			if (results.has(message.toolCallId)) throw new Error(`Duplicate tool result for ${message.toolCallId}`);
			results.add(message.toolCallId);
		}
	}
	for (const id of calls.keys()) {
		if (!results.has(id)) throw new Error(`Missing tool output for ${id}`);
	}
}
function normalizeIdPart(value: string): string {
	const normalized = value
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.slice(0, 64)
		.replace(/_+$/, "");
	if (!normalized) throw new Error("Tool call ID cannot be normalized");
	return normalized;
}
function shortHash(value: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
function validTextPhase(value: unknown): value is "commentary" | "final_answer" {
	return value === "commentary" || value === "final_answer";
}
function parseTextSignature(value: string | undefined): { id: string; phase?: string } | undefined {
	if (!value) return undefined;
	if (value.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed) && parsed.v === 1 && typeof parsed.id === "string")
				return validTextPhase(parsed.phase) ? { id: parsed.id, phase: parsed.phase } : { id: parsed.id };
		} catch {
			/* fall through to legacy plain-string handling */
		}
	}
	return { id: value };
}
function backfillReasoningSignatures(response: Json, blocks: Map<string, ThinkingBlock>): void {
	if (response.output === undefined) return;
	if (!Array.isArray(response.output)) throw new Error("Native terminal response output must be an array");
	assertJsonStructure(response.output, "Native terminal response output");
	const seenReasoning = new Set<string>();
	for (const value of response.output) {
		if (!isRecord(value) || value.type !== "reasoning") continue;
		const id = boundedId(value.id, "terminal reasoning");
		if (seenReasoning.has(id)) throw new Error(`Duplicate terminal reasoning output ${id}`);
		seenReasoning.add(id);
		const block = blocks.get(id);
		if (!block) throw new Error(`Terminal reasoning output introduced unknown item ${id}`);
		if (value.encrypted_content === undefined) continue;
		const encrypted = requireStringAllowEmpty(value.encrypted_content, "terminal encrypted reasoning");
		if (Buffer.byteLength(encrypted) > NATIVE_MAX_BUFFER_BYTES)
			throw new Error("Terminal encrypted reasoning exceeds native item limit");
		if (!block.thinkingSignature) throw new Error("Observed reasoning block has no signature");
		const signature: unknown = JSON.parse(block.thinkingSignature);
		if (!isRecord(signature) || signature.id !== id) throw new Error("Reasoning signature identity mismatch");
		if (signature.encrypted_content !== undefined && signature.encrypted_content !== encrypted)
			throw new Error("Terminal encrypted reasoning differs from item completion");
		if (signature.encrypted_content === undefined) signature.encrypted_content = encrypted;
		const encoded = JSON.stringify(signature);
		if (Buffer.byteLength(encoded) > NATIVE_MAX_BUFFER_BYTES)
			throw new Error("Reasoning signature exceeds native item limit");
		block.thinkingSignature = encoded;
	}
}
function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function asRecord(value: unknown, label: string): Json {
	if (!isRecord(value)) throw new Error(`Invalid ${label}`);
	return value;
}
function isRecord(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Request was aborted");
}
function streamError(event: Json): string {
	const nested = isRecord(event.error) ? event.error : {};
	const text = [event.code ?? nested.code, event.message ?? nested.message]
		.filter((value) => typeof value === "string" || typeof value === "number")
		.join(": ");
	return boundedText(text || "Native response failed", NATIVE_MAX_PROVIDER_ERROR_BYTES);
}
function mergeHeaders(...groups: Array<Record<string, string | null> | undefined>): Record<string, string> {
	const headers = new Map<string, [string, string]>();
	for (const group of groups)
		for (const [key, value] of Object.entries(group ?? {})) {
			if (value === null) headers.delete(key.toLowerCase());
			else headers.set(key.toLowerCase(), [key, value]);
		}
	return Object.fromEntries(headers.values());
}
function assertHeaderBounds(headers: Record<string, string>): void {
	const entries = Object.entries(headers);
	if (entries.length > NATIVE_MAX_HEADER_COUNT) throw new Error(`Headers exceed ${NATIVE_MAX_HEADER_COUNT} entries`);
	let bytes = 0;
	for (const [key, value] of entries) {
		if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) throw new Error("Invalid header characters");
		bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
	}
	if (bytes > NATIVE_MAX_HEADER_BYTES) throw new Error(`Headers exceed ${NATIVE_MAX_HEADER_BYTES} bytes`);
}
function boundedResponseHeaders(headers: Headers): Record<string, string> {
	const result = Object.fromEntries(headers.entries());
	assertHeaderBounds(result);
	return result;
}
function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
	if (timeoutMs === undefined || timeoutMs === 0) return signal;
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
async function readProviderError(response: Response): Promise<{ message: string; classification: string }> {
	if (!response.body) {
		const message = response.statusText || "request failed";
		return { message, classification: message };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			const remaining = NATIVE_MAX_PROVIDER_ERROR_BYTES - bytes;
			if (remaining <= 0) break;
			const chunk = next.value.subarray(0, remaining);
			chunks.push(chunk);
			bytes += chunk.byteLength;
			if (chunk.byteLength < next.value.byteLength) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const text = Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		bytes,
	).toString("utf8");
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value)) {
			const error = isRecord(value.error) ? value.error : value;
			if (typeof error.message === "string") {
				return {
					message: boundedText(error.message, NATIVE_MAX_PROVIDER_ERROR_BYTES),
					classification: text,
				};
			}
		}
	} catch {
		/* use raw bounded body */
	}
	const message = boundedText(text || response.statusText || "request failed", NATIVE_MAX_PROVIDER_ERROR_BYTES);
	return { message, classification: text || message };
}
async function retryDelay(
	headers: Headers | undefined,
	status: number | undefined,
	attempt: number,
	maxDelay: number,
	signal?: AbortSignal,
): Promise<void> {
	let delay = 1000 * 2 ** attempt;
	const retryAfterMs = headers?.get("retry-after-ms");
	if (retryAfterMs !== null && retryAfterMs !== undefined) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) delay = Math.max(0, millis);
	} else {
		const retryAfter = headers?.get("retry-after");
		if (retryAfter) {
			const seconds = Number(retryAfter);
			const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
			if (Number.isFinite(parsed)) delay = Math.max(0, parsed);
		}
	}
	if (status === 429 && maxDelay > 0) delay = Math.min(delay, maxDelay);
	if (delay <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const finish = () => {
			cleanup();
			resolve();
		};
		const timer = setTimeout(finish, delay);
		const abort = () => {
			clearTimeout(timer);
			cleanup();
			reject(signal?.reason instanceof Error ? signal.reason : new Error("Request was aborted"));
		};
		if (signal) {
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

function isRetryableError(status: number, errorText: string): boolean {
	if (status === 429 && TERMINAL_RATE_LIMIT.test(errorText)) return false;
	return RETRYABLE_STATUS.has(status) || TRANSIENT_ERROR.test(errorText);
}

function explicitAbortReason(signal: AbortSignal | undefined): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	return new DOMException(reason === undefined ? "Request was aborted" : String(reason), "AbortError");
}
function boundedText(value: string, limit: number): string {
	if (Buffer.byteLength(value) <= limit) return value;
	let end = Math.min(value.length, limit - 3);
	while (end > 0 && Buffer.byteLength(value.slice(0, end)) > limit - 3) end--;
	return `${value.slice(0, end)}...`;
}
