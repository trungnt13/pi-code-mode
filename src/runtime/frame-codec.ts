import { CLIENT_FRAME_BYTES, DEFAULT_JSON_STRUCTURE_LIMITS, type JsonStructureLimits } from "../constants.js";

export { DEFAULT_JSON_STRUCTURE_LIMITS };
export type { JsonStructureLimits };

export function assertJsonStructure(
	value: unknown,
	label = "Code-mode JSON",
	structure: JsonStructureLimits = DEFAULT_JSON_STRUCTURE_LIMITS,
): void {
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let items = 0;
	while (pending.length) {
		const current = pending.pop();
		if (!current) break;
		if (current.depth > structure.maxDepth) {
			throw new Error(`${label} exceeds maximum depth ${structure.maxDepth}`);
		}
		items++;
		if (items > structure.maxItems) {
			throw new Error(`${label} exceeds maximum item count ${structure.maxItems}`);
		}
		if (current.value === null || typeof current.value !== "object") continue;
		const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
		for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
	}
}

export function encodeJsonBounded(
	value: unknown,
	limit: number,
	label = "Code-mode JSON",
	structure: JsonStructureLimits = DEFAULT_JSON_STRUCTURE_LIMITS,
): Buffer {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`${label} limit must be a positive integer`);
	if (!Number.isSafeInteger(structure.maxDepth) || structure.maxDepth < 1) {
		throw new Error(`${label} maxDepth must be a positive integer`);
	}
	if (!Number.isSafeInteger(structure.maxItems) || structure.maxItems < 1) {
		throw new Error(`${label} maxItems must be a positive integer`);
	}
	const chunks: string[] = [];
	let bytes = 0;
	let items = 0;
	const active = new Set<object>();
	const append = (text: string) => {
		const size = Buffer.byteLength(text);
		if (bytes + size > limit) throw new Error(`${label} exceeds ${limit} bytes`);
		bytes += size;
		chunks.push(text);
	};
	const string = (input: string) => {
		append('"');
		for (let start = 0; start < input.length; ) {
			let end = Math.min(start + 16 * 1024, input.length);
			if (end < input.length && input.charCodeAt(end - 1) >= 0xd800 && input.charCodeAt(end - 1) <= 0xdbff) end--;
			const encoded = JSON.stringify(input.slice(start, end));
			append(encoded.slice(1, -1));
			start = end;
		}
		append('"');
	};
	const encode = (input: unknown, depth: number) => {
		if (depth > structure.maxDepth) throw new Error(`${label} exceeds maximum depth ${structure.maxDepth}`);
		items++;
		if (items > structure.maxItems) throw new Error(`${label} exceeds maximum item count ${structure.maxItems}`);
		if (input === null) return append("null");
		switch (typeof input) {
			case "string":
				return string(input);
			case "boolean":
				return append(input ? "true" : "false");
			case "number":
				return append(Number.isFinite(input) ? String(input) : "null");
			case "object": {
				if (active.has(input)) throw new Error(`${label} contains a cycle`);
				active.add(input);
				try {
					const toJSON = (input as { toJSON?: unknown }).toJSON;
					if (typeof toJSON === "function") {
						encode(toJSON.call(input), depth + 1);
						return;
					}
					if (Array.isArray(input)) {
						append("[");
						for (let index = 0; index < input.length; index++) {
							if (index) append(",");
							const item = input[index];
							if (item === undefined || typeof item === "function" || typeof item === "symbol") append("null");
							else encode(item, depth + 1);
						}
						append("]");
						return;
					}
					append("{");
					let first = true;
					for (const key in input) {
						if (!Object.hasOwn(input, key)) continue;
						const item = (input as Record<string, unknown>)[key];
						if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
						if (!first) append(",");
						first = false;
						string(key);
						append(":");
						encode(item, depth + 1);
					}
					append("}");
					return;
				} finally {
					active.delete(input);
				}
			}
			default:
				throw new Error(`${label} contains unsupported ${typeof input}`);
		}
	};
	encode(value, 0);
	return Buffer.from(chunks.join(""));
}

export function encodeFrame(message: unknown): Buffer {
	const payload = encodeJsonBounded(message, CLIENT_FRAME_BYTES, "Code-mode frame");
	const frame = Buffer.allocUnsafe(4 + payload.byteLength);
	frame.writeUInt32LE(payload.byteLength, 0);
	payload.copy(frame, 4);
	return frame;
}

export class FrameDecoder {
	private readonly header = Buffer.allocUnsafe(4);
	private headerBytes = 0;
	private payload?: Buffer;
	private payloadBytes = 0;

	push(chunk: Buffer): unknown[] {
		const frames: unknown[] = [];
		let offset = 0;
		while (offset < chunk.byteLength) {
			if (!this.payload) {
				const count = Math.min(4 - this.headerBytes, chunk.byteLength - offset);
				chunk.copy(this.header, this.headerBytes, offset, offset + count);
				this.headerBytes += count;
				offset += count;
				if (this.headerBytes < 4) continue;
				const length = this.header.readUInt32LE(0);
				if (length > CLIENT_FRAME_BYTES)
					throw new Error(`Code-mode frame declaration ${length} exceeds ${CLIENT_FRAME_BYTES} bytes`);
				this.payload = Buffer.allocUnsafe(length);
				this.payloadBytes = 0;
			}
			const count = Math.min(this.payload.byteLength - this.payloadBytes, chunk.byteLength - offset);
			chunk.copy(this.payload, this.payloadBytes, offset, offset + count);
			this.payloadBytes += count;
			offset += count;
			if (this.payloadBytes !== this.payload.byteLength) continue;
			const payload = this.payload;
			this.payload = undefined;
			this.headerBytes = 0;
			try {
				const value: unknown = JSON.parse(payload.toString("utf8"));
				assertJsonStructure(value, "Code-mode frame");
				frames.push(value);
			} catch (error) {
				throw new Error(`Malformed code-mode JSON frame: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return frames;
	}

	finish(): void {
		if (this.headerBytes !== 0 || this.payload !== undefined)
			throw new Error("Code-mode host closed with a truncated frame");
	}
}
