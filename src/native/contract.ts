import { NATIVE_MAX_ID_BYTES, NATIVE_MAX_OUTPUT_ITEMS } from "../native-limits.js";

export const CODE_MODE_EXEC_GRAMMAR = String.raw`
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

interface ResponsesBody {
	tools?: unknown[];
	input?: unknown[];
	[key: string]: unknown;
}

export function applyNativeExecContract<T extends ResponsesBody>(body: T, requireToolSurface = false): T {
	const tools = body.tools?.map(nativeTool);
	if (requireToolSurface) validateToolSurface(tools);
	const calls = new Map<string, "exec-custom" | "exec-function" | "function">();
	const input = body.input ?? [];
	const paired = new Set<string>();
	const rewritten = input.map((item) => {
		if (!isRecord(item)) return item;
		if (item.type === "custom_tool_call") {
			if (item.name !== "exec") throw new Error(`Native custom tool must be exec, received ${String(item.name)}`);
			const callId = boundedId(item.call_id, "custom exec call ID");
			if (typeof item.input !== "string") throw new Error(`Native custom exec input must be a string for ${callId}`);
			recordCall(calls, callId, "exec-custom");
			return item;
		}
		if (item.type === "function_call") {
			const callId = boundedId(item.call_id, "function call ID");
			const name = requireString(item.name, "function name");
			recordCall(calls, callId, name === "exec" ? "exec-function" : "function");
			if (name === "exec") {
				const { arguments: argumentText, ...rest } = item;
				return { ...rest, type: "custom_tool_call", input: execSource(argumentText) };
			}
			return item;
		}
		if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") return item;
		const callId = boundedId(item.call_id, "tool output call ID");
		const kind = calls.get(callId);
		if (!kind) throw new Error(`Tool output targets unknown call ${callId}`);
		if (paired.has(callId)) throw new Error(`Duplicate tool output for ${callId}`);
		paired.add(callId);
		if (kind === "exec-custom") {
			if (item.type !== "custom_tool_call_output") throw new Error(`Exec output has wrong kind for ${callId}`);
			return item;
		}
		if (kind === "exec-function") {
			if (item.type !== "function_call_output") throw new Error(`Exec replay output has wrong kind for ${callId}`);
			return { ...item, type: "custom_tool_call_output" };
		}
		if (item.type !== "function_call_output") throw new Error(`Function output has wrong kind for ${callId}`);
		return item;
	});
	for (const callId of calls.keys()) {
		if (!paired.has(callId)) throw new Error(`Missing tool output for ${callId}`);
	}
	return {
		...body,
		...(tools ? { tools } : {}),
		...(body.input ? { input: rewritten } : {}),
	};
}

function validateToolSurface(tools: unknown[] | undefined): void {
	if (!tools || tools.length !== 2) throw new Error("Native tool surface must contain exactly exec and wait");
	const names = new Set<string>();
	for (const tool of tools) {
		if (!isRecord(tool)) throw new Error("Invalid native tool definition");
		const name = requireString(tool.name, "native tool name");
		if (names.has(name)) throw new Error(`Duplicate native tool ${name}`);
		names.add(name);
		if (name === "exec") {
			if (
				tool.type !== "custom" ||
				!isRecord(tool.format) ||
				tool.format.type !== "grammar" ||
				tool.format.syntax !== "lark" ||
				tool.format.definition !== CODE_MODE_EXEC_GRAMMAR
			)
				throw new Error("Native exec tool must use exact code-mode grammar");
		} else if (name === "wait") {
			if (tool.type !== "function") throw new Error("Native wait tool must remain a function");
		} else throw new Error(`Unsupported native tool ${name}`);
	}
	if (!names.has("exec") || !names.has("wait"))
		throw new Error("Native tool surface must contain exactly exec and wait");
}

function recordCall(
	calls: Map<string, "exec-custom" | "exec-function" | "function">,
	id: string,
	kind: "exec-custom" | "exec-function" | "function",
): void {
	if (calls.has(id)) throw new Error(`Duplicate code-mode call ID ${id}`);
	if (calls.size >= NATIVE_MAX_OUTPUT_ITEMS)
		throw new Error(`Code-mode replay exceeds ${NATIVE_MAX_OUTPUT_ITEMS} calls`);
	calls.set(id, kind);
}

function boundedId(value: unknown, label: string): string {
	const id = requireString(value, label);
	if (Buffer.byteLength(id) > NATIVE_MAX_ID_BYTES) throw new Error(`${label} exceeds ${NATIVE_MAX_ID_BYTES} bytes`);
	if (id.includes("|")) throw new Error(`${label} contains reserved delimiter`);
	return id;
}

function nativeTool(tool: unknown): unknown {
	if (!isRecord(tool) || tool.type !== "function" || tool.name !== "exec") return tool;
	return {
		type: "custom",
		name: "exec",
		description: typeof tool.description === "string" ? tool.description : "Run JavaScript to compose tools",
		format: { type: "grammar", syntax: "lark", definition: CODE_MODE_EXEC_GRAMMAR },
	};
}

function execSource(value: unknown): string {
	if (typeof value !== "string") throw new Error("Code-mode replay exec arguments must be JSON text");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Code-mode replay exec arguments are malformed JSON");
	}
	if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.code !== "string") {
		throw new Error("Code-mode replay exec arguments must contain exactly string code");
	}
	return parsed.code;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
