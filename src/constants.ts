export interface CellLimits {
	heapBytes: number;
	wallTimeMs: number;
	pendingTimers: number;
	outputBytes: number;
	delegateResultBytes: number;
	toolDefinitionBytes: number;
}

export interface SessionLimits {
	maxActiveCells: number;
	maxDelegateCalls: number;
	maxCommittedStateBytes: number;
	maxCellLimits: CellLimits;
}

export interface JsonStructureLimits {
	maxDepth: number;
	maxItems: number;
}

export const CLIENT_FRAME_BYTES = 16 * 1024 * 1024;
export const DELEGATE_RESULT_BYTES = 4 * 1024 * 1024;

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
	maxActiveCells: 4,
	maxDelegateCalls: 8,
	maxCommittedStateBytes: 4 * 1024 * 1024,
	maxCellLimits: {
		heapBytes: 64 * 1024 * 1024,
		wallTimeMs: 60_000,
		pendingTimers: 16,
		outputBytes: 4 * 1024 * 1024,
		delegateResultBytes: DELEGATE_RESULT_BYTES,
		toolDefinitionBytes: 1024 * 1024,
	},
};

export const DEFAULT_JSON_STRUCTURE_LIMITS: Readonly<JsonStructureLimits> = Object.freeze({
	maxDepth: 64,
	maxItems: 100_000,
});

export const CONTROLLER_OPERATION_DRAIN_MS = 3_000;
export const CONTROLLER_CELL_CLOSE_MS = 2_000;
export const CONTROLLER_PREPARE_CLOSE_MS = 6_000;
export const CONTROLLER_LOSS_CLEANUP_MS = 6_000;
export const DEFAULT_OUTER_ERROR_BYTES = 16 * 1024;

export const HOST_MAX_PENDING_OPERATIONS = 256;
export const HOST_HANDSHAKE_MS = 5_000;
export const HOST_CLOSE_MS = 2_000;
export const HOST_CANCEL_GRACE_MS = 1_000;

export const NATIVE_MAX_EVENTS = 100_000;
export const NATIVE_MAX_OUTPUT_ITEMS = 4_096;
export const NATIVE_MAX_IDS = 8_000;
export const NATIVE_MAX_ID_BYTES = 1_024;
export const NATIVE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
export const NATIVE_MAX_STREAM_BYTES = 16 * 1024 * 1024;
export const NATIVE_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const NATIVE_MAX_PROVIDER_ERROR_BYTES = 16 * 1024;
export const NATIVE_MAX_HEADER_COUNT = 256;
export const NATIVE_MAX_HEADER_BYTES = 64 * 1024;
export const NATIVE_MAX_JWT_BYTES = 16 * 1024;
export const NATIVE_MAX_RETRIES = 8;
