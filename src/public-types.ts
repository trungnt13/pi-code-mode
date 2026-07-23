import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SessionLimits } from "./constants.js";

// Generic erasure is required because Pi tool renderers are parameter-contravariant.
// biome-ignore lint/suspicious/noExplicitAny: public Pi registry accepts heterogeneous tool definitions
export type AnyToolDefinition = ToolDefinition<any, any, any>;

export type NestedBeforeCallback = (input: {
	toolName: string;
	arguments: unknown;
	context: ExtensionContext;
	signal: AbortSignal;
}) => Promise<unknown | undefined> | unknown | undefined;

export type NestedAfterCallback = (input: {
	toolName: string;
	arguments: unknown;
	result: AgentToolResult<unknown>;
	context: ExtensionContext;
	signal: AbortSignal;
}) => Promise<AgentToolResult<unknown> | undefined> | AgentToolResult<unknown> | undefined;

export type CodeModeInputMode = "auto" | "function" | "freeform";

export interface LocalHostIdentity {
	executablePath: string;
	sha256: string;
	sizeBytes: number;
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
}

export interface CodeModeExtensionOptions {
	host?: LocalHostIdentity;
	inputMode?: CodeModeInputMode;
	nestedTools?: readonly AnyToolDefinition[];
	beforeNestedTool?: NestedBeforeCallback;
	afterNestedTool?: NestedAfterCallback;
	limits?: Partial<SessionLimits> & {
		maxCellLimits?: Partial<SessionLimits["maxCellLimits"]>;
	};
}
