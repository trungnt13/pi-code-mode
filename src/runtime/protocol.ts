import {
	type CellLimits,
	CLIENT_FRAME_BYTES,
	DEFAULT_SESSION_LIMITS,
	DELEGATE_RESULT_BYTES,
	type SessionLimits,
} from "../constants.js";

export { CLIENT_FRAME_BYTES, DEFAULT_SESSION_LIMITS, DELEGATE_RESULT_BYTES };
export type { CellLimits, SessionLimits };

export interface ProcessLimits {
	maxFrameBytes: number;
	maxOpenSessions: number;
	maxCommittedStateBytesPerSession: number;
	maxActiveCells: number;
	maxInFlightOperations: number;
	maxDelegateCalls: number;
	maxCellLimits: CellLimits;
}

export function mergeSessionLimits(
	patch?: Partial<SessionLimits> & { maxCellLimits?: Partial<CellLimits> },
): SessionLimits {
	const merged = {
		...DEFAULT_SESSION_LIMITS,
		...patch,
		maxCellLimits: { ...DEFAULT_SESSION_LIMITS.maxCellLimits, ...patch?.maxCellLimits },
	};
	assertPositiveLimits(merged);
	assertFitsSession(merged, DEFAULT_SESSION_LIMITS, "Configured code-mode limits exceed supported profile");
	return merged;
}

export function assertProcessSupports(process: ProcessLimits, requested: SessionLimits): void {
	const processValues = [
		process.maxFrameBytes,
		process.maxOpenSessions,
		process.maxCommittedStateBytesPerSession,
		process.maxActiveCells,
		process.maxInFlightOperations,
		process.maxDelegateCalls,
		...Object.values(process.maxCellLimits ?? {}),
	];
	if (processValues.length !== 12 || processValues.some((value) => !Number.isSafeInteger(value) || value <= 0))
		throw new Error("Code-mode host returned malformed process limits");
	if (process.maxFrameBytes < CLIENT_FRAME_BYTES) throw new Error("Code-mode host frame ceiling is below 16 MiB");
	if (process.maxActiveCells < requested.maxActiveCells || process.maxDelegateCalls < requested.maxDelegateCalls)
		throw new Error("Code-mode host process ceilings are below requested session limits");
	if (process.maxCommittedStateBytesPerSession < requested.maxCommittedStateBytes)
		throw new Error("Code-mode host committed-state ceiling is below requested limit");
	assertFitsCell(requested.maxCellLimits, process.maxCellLimits, "Code-mode host cell ceilings are too small");
}

export function equalLimits(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function assertPositiveLimits(limits: SessionLimits): void {
	const values = [
		limits.maxActiveCells,
		limits.maxDelegateCalls,
		limits.maxCommittedStateBytes,
		...Object.values(limits.maxCellLimits),
	];
	if (values.some((value) => !Number.isSafeInteger(value) || value <= 0))
		throw new Error("Code-mode limits must be positive integers");
}

function assertFitsSession(value: SessionLimits, maximum: SessionLimits, message: string): void {
	if (
		value.maxActiveCells > maximum.maxActiveCells ||
		value.maxDelegateCalls > maximum.maxDelegateCalls ||
		value.maxCommittedStateBytes > maximum.maxCommittedStateBytes
	)
		throw new Error(message);
	assertFitsCell(value.maxCellLimits, maximum.maxCellLimits, message);
}

function assertFitsCell(value: CellLimits, maximum: CellLimits, message: string): void {
	for (const key of Object.keys(maximum) as Array<keyof CellLimits>)
		if (value[key] > maximum[key]) throw new Error(message);
}

export type RuntimeResponse =
	| { kind: "yielded" | "terminated"; cellId: string; contentItems: unknown[] }
	| { kind: "result"; cellId: string; contentItems: unknown[]; errorText?: string };

export function parseRuntimeResponse(value: unknown): RuntimeResponse {
	const record = asRecord(value, "runtime response");
	const variants = ["Yielded", "Terminated", "Result"].filter((key) => key in record);
	if (variants.length !== 1 || Object.keys(record).length !== 1)
		throw new Error("Code-mode runtime response must contain exactly one known variant");
	for (const [wireKey, kind] of [
		["Yielded", "yielded"],
		["Terminated", "terminated"],
		["Result", "result"],
	] as const) {
		if (wireKey in record) {
			const body = asRecord(record[wireKey], wireKey);
			if (typeof body.cell_id !== "string" || !Array.isArray(body.content_items))
				throw new Error(`Malformed ${wireKey} response`);
			if ("error_text" in body && body.error_text !== null && typeof body.error_text !== "string")
				throw new Error(`Malformed ${wireKey} error_text`);
			if (kind !== "result" && "error_text" in body) throw new Error(`Malformed ${wireKey} error_text`);
			return {
				kind,
				cellId: body.cell_id,
				contentItems: body.content_items,
				...(kind === "result" && typeof body.error_text === "string" ? { errorText: body.error_text } : {}),
			};
		}
	}
	throw new Error("Unknown code-mode runtime response");
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Malformed code-mode ${label}`);
	return value as Record<string, unknown>;
}
