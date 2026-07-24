import { NATIVE_MAX_ID_BYTES, NATIVE_MAX_OUTPUT_ITEMS } from "../constants.js";

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
			if (name !== "exec" && name !== "wait" && name !== "request_user_input") {
				throw new Error(`Unsupported native function tool ${name}`);
			}
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
	if (!tools || (tools.length !== 3 && tools.length !== 4))
		throw new Error(
			"Native tool surface must contain exactly exec, wait, and request_user_input, plus optional hosted web search",
		);
	const names = new Set<string>();
	let webSearch = false;
	for (const tool of tools) {
		if (!isRecord(tool)) throw new Error("Invalid native tool definition");
		if (tool.type === "web_search") {
			if (webSearch) throw new Error("Duplicate hosted web search tool");
			if (
				Object.keys(tool).length !== 2 ||
				typeof tool.external_web_access !== "boolean" ||
				Object.hasOwn(tool, "name")
			)
				throw new Error("Hosted web search tool must contain exactly type and boolean external_web_access");
			webSearch = true;
			continue;
		}
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
		} else if (name === "wait" || name === "request_user_input") {
			if (tool.type !== "function") throw new Error(`Native ${name} tool must remain a function`);
		} else throw new Error(`Unsupported native tool ${name}`);
	}
	if (!names.has("exec") || !names.has("wait") || !names.has("request_user_input")) {
		throw new Error("Native tool surface must contain exactly exec, wait, and request_user_input");
	}
	if (tools.length !== names.size + (webSearch ? 1 : 0))
		throw new Error("Native tool surface contains an unsupported hosted tool");
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
