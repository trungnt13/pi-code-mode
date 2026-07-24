import { randomUUID } from "node:crypto";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { CodeModeExtensionOptions, CodeModeInputMode, LocalHostIdentity } from "../public-types.js";
import {
	type AnyToolDefinition,
	CodeModeController,
	type ControllerOptions,
	preflightDefinitions,
	snapshotTools,
} from "./controller.js";
import { type HostIdentity, validateHostIdentity } from "./host-client.js";
import { mergeSessionLimits } from "./protocol.js";

const OWNER_MARKER = Symbol("pi-code-mode-owner");
const EXEC = "exec";
const WAIT = "wait";
const DEFAULT_TOKENS = 10_000;
type ClaimState = "unclaimed" | "partial" | "claimed";
type NativeOverlayTransaction = {
	readonly providerId: string;
	install(): void;
	restore(): void;
};

export interface ExtensionEngine {
	enable(context: ExtensionCommandContext): Promise<void>;
	disable(): Promise<void>;
	isEnabled(): boolean;
	statusText(): string;
}

export function createExtensionRuntime(pi: ExtensionAPI, options: CodeModeExtensionOptions): ExtensionEngine {
	const explicitTools = snapshotTools(options.nestedTools ?? []);
	const marker = Object.freeze({ id: randomUUID() });
	const execSchema = markSchema(
		Type.Object(
			{ code: Type.String({ description: "JavaScript source to execute" }) },
			{ additionalProperties: false },
		),
		marker,
	);
	const waitSchema = markSchema(
		Type.Object(
			{
				cell_id: Type.String(),
				yield_time_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
				max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
				terminate: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
		marker,
	);
	return new ExtensionRuntime(pi, options, explicitTools, marker, execSchema, waitSchema);
}

class ExtensionRuntime {
	private readonly pi: ExtensionAPI;
	private readonly options: CodeModeExtensionOptions;
	private readonly explicitTools: readonly AnyToolDefinition[];
	private readonly marker: object;
	private readonly execSchema: TSchema;
	private readonly waitSchema: TSchema;
	private readonly execTool: AnyToolDefinition;
	private readonly waitTool: AnyToolDefinition;
	private claimState: ClaimState = "unclaimed";
	private enabled = false;
	private priorActive?: string[];
	private controller?: CodeModeController;
	private providerOverlay?: NativeOverlayTransaction;
	private lastError?: string;

	constructor(
		pi: ExtensionAPI,
		options: CodeModeExtensionOptions,
		explicitTools: readonly AnyToolDefinition[],
		marker: object,
		execSchema: TSchema,
		waitSchema: TSchema,
	) {
		this.pi = pi;
		this.options = options;
		this.explicitTools = explicitTools;
		this.marker = marker;
		this.execSchema = execSchema;
		this.waitSchema = waitSchema;
		this.execTool = Object.freeze({
			name: EXEC,
			label: "Execute code",
			description: "Execute JavaScript that composes bounded nested tools. Input must be { code: string }.",
			promptSnippet: "Execute JavaScript over nested tools",
			promptGuidelines: [
				"Use exec to compose several nested tool calls, and wait when exec returns a running cell ID.",
			],
			parameters: execSchema,
			executionMode: "parallel",
			execute: (
				toolCallId: string,
				params: unknown,
				signal: AbortSignal | undefined,
				onUpdate: AgentToolUpdateCallback<unknown> | undefined,
				context: ExtensionContext,
			) => {
				const input = requireRecord(params, "exec input");
				if (typeof input.code !== "string") throw new Error("exec input code must be a string");
				const controller = this.requireEnabled();
				return controller.execute(
					input.code,
					toolCallId,
					context,
					signal,
					onUpdate as Parameters<CodeModeController["execute"]>[4],
				);
			},
		});
		this.waitTool = Object.freeze({
			name: WAIT,
			label: "Wait for code cell",
			description: "Wait for or terminate a yielded JavaScript cell.",
			parameters: waitSchema,
			executionMode: "parallel",
			execute: (_toolCallId: string, params: unknown, signal: AbortSignal | undefined) => {
				const input = requireRecord(params, "wait input");
				if (typeof input.cell_id !== "string") throw new Error("wait input cell_id must be a string");
				return this.requireEnabled().wait(
					input.cell_id,
					typeof input.yield_time_ms === "number" ? input.yield_time_ms : 10_000,
					typeof input.max_tokens === "number" ? input.max_tokens : DEFAULT_TOKENS,
					input.terminate === true,
					signal,
				);
			},
		});
	}

	async enable(context: ExtensionCommandContext): Promise<void> {
		if (this.enabled) return;
		this.lastError = undefined;
		if (this.claimState === "partial") {
			throw new Error("Code-mode tool registration is partial; reload required");
		}
		if (this.claimState === "unclaimed") this.assertNamesAvailable();
		else this.assertOwnedTools();

		const host = await resolveHostIdentity(this.options.host, process.env);
		await validateHostIdentity(host);
		const limits = mergeSessionLimits(this.options.limits);
		const probeTools = this.createNestedTools(context);
		preflightDefinitions(probeTools, limits.maxCellLimits.toolDefinitionBytes);
		const native = shouldUseNativeInput(context, this.options.inputMode ?? "auto");
		const overlay = native
			? (await import("../native/overlay.js")).prepareNativeOverlay(
					this.pi,
					context.modelRegistry,
					context.model?.provider ?? "",
				)
			: undefined;

		if (this.claimState === "unclaimed") this.assertNamesAvailable();
		else this.assertOwnedTools();
		const prior = [...this.pi.getActiveTools()];
		let claimAttempted = false;
		try {
			if (this.claimState === "unclaimed") {
				claimAttempted = true;
				this.claimState = "partial";
				this.pi.registerTool(this.execTool);
				this.pi.registerTool(this.waitTool);
				this.assertOwnedTools();
				this.claimState = "claimed";
			}
			this.assertOwnedTools();
			overlay?.install();
			this.pi.setActiveTools([EXEC, WAIT]);
			assertExactNames(this.pi.getActiveTools(), [EXEC, WAIT], "active code-mode tools");
			this.priorActive = prior;
			this.controller = new CodeModeController({
				host,
				limits: this.options.limits,
				createNestedTools: (outerContext) => this.createNestedTools(outerContext),
				beforeNestedTool: this.options.beforeNestedTool,
				afterNestedTool: this.options.afterNestedTool,
			} satisfies ControllerOptions);
			this.providerOverlay = overlay;
			this.enabled = true;
		} catch (error) {
			if (claimAttempted) this.reconcileClaimAfterFailure();
			const errors: unknown[] = [error];
			try {
				this.restoreActive(prior);
			} catch (restoreError) {
				errors.push(restoreError);
			}
			try {
				overlay?.restore();
			} catch (restoreError) {
				errors.push(restoreError);
			}
			this.enabled = false;
			this.controller = undefined;
			this.providerOverlay = undefined;
			this.priorActive = undefined;
			this.lastError = boundedError(error);
			if (errors.length === 1) throw error;
			throw new AggregateError(
				errors,
				claimAttempted
					? "Code-mode enable failed; tool registration state remains until reload"
					: "Code-mode enable and active-tool restore failed",
			);
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	async disable(): Promise<void> {
		if (!this.enabled) return;
		this.enabled = false;
		const controller = this.controller;
		const overlay = this.providerOverlay;
		const prior = this.priorActive ?? [];
		this.controller = undefined;
		this.providerOverlay = undefined;
		this.priorActive = undefined;
		const errors: unknown[] = [];
		if (controller) {
			try {
				await controller.close();
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			overlay?.restore();
		} catch (error) {
			errors.push(error);
		}
		try {
			this.restoreActive(prior);
		} catch (error) {
			errors.push(error);
		}
		if (errors.length) {
			this.lastError = boundedError(errors[0]);
			if (errors.length === 1) throw errors[0];
			throw new AggregateError(errors, "Code-mode disable failed");
		}
	}

	private createNestedTools(context: ExtensionContext): readonly AnyToolDefinition[] {
		return snapshotTools([
			createReadToolDefinition(context.cwd),
			createBashToolDefinition(context.cwd),
			createEditToolDefinition(context.cwd),
			createWriteToolDefinition(context.cwd),
			createGrepToolDefinition(context.cwd),
			createFindToolDefinition(context.cwd),
			createLsToolDefinition(context.cwd),
			...this.explicitTools,
		]);
	}

	private assertNamesAvailable(): void {
		const conflicts = this.pi
			.getAllTools()
			.filter((tool) => tool.name === EXEC || tool.name === WAIT)
			.map((tool) => tool.name);
		if (conflicts.length) {
			throw new Error(`Code-mode tool name conflict: ${[...new Set(conflicts)].join(", ")}`);
		}
	}

	private assertOwnedTools(): void {
		const all = this.pi.getAllTools();
		for (const [name, schema] of [
			[EXEC, this.execSchema],
			[WAIT, this.waitSchema],
		] as const) {
			const matches = all.filter((tool) => tool.name === name);
			if (matches.length !== 1) throw new Error(`Code-mode tool ownership check failed for ${name}`);
			const info = matches[0];
			if (!info) throw new Error(`Code-mode tool ownership check lost ${name}`);
			if (
				info.parameters !== schema ||
				readMarker(info.parameters) !== this.marker ||
				info.sourceInfo.source === "builtin" ||
				info.sourceInfo.source === "sdk"
			) {
				throw new Error(`Code-mode tool ownership marker mismatch for ${name}`);
			}
		}
	}

	private reconcileClaimAfterFailure(): void {
		try {
			this.assertOwnedTools();
			this.claimState = "claimed";
		} catch {
			// Registration APIs can record a tool before throwing. Reload is the only safe reset.
			this.claimState = "partial";
		}
	}

	private restoreActive(prior: readonly string[]): void {
		const available = new Set(this.pi.getAllTools().map((tool) => tool.name));
		const restored = prior.filter((name) => available.has(name));
		this.pi.setActiveTools(restored);
		assertExactNames(this.pi.getActiveTools(), restored, "restored active tools");
	}

	private requireEnabled(): CodeModeController {
		if (!this.enabled || !this.controller) throw new Error("Code mode is disabled");
		return this.controller;
	}

	statusText(): string {
		const metrics = this.controller?.metrics();
		const parts = [
			`code-mode: ${this.enabled ? "on" : "off"}`,
			`tools: ${
				this.claimState === "claimed"
					? "claimed until reload"
					: this.claimState === "partial"
						? "partial until reload"
						: "unclaimed"
			}`,
			`provider: ${this.providerOverlay ? `native freeform (${this.providerOverlay.providerId})` : "function input (no overlay)"}`,
		];
		if (metrics) {
			parts.push(
				`host: ${metrics.prepared ? `running pid ${metrics.childPid ?? "unknown"}` : "validated, not started"}`,
				`cells: ${metrics.activeCells + metrics.startingCells}`,
			);
		}
		if (this.lastError) parts.push(`last error: ${this.lastError}`);
		return parts.join("; ");
	}
}

function shouldUseNativeInput(context: ExtensionCommandContext, mode: CodeModeInputMode): boolean {
	const model = context.model;
	const eligible =
		model?.api === "openai-codex-responses" && model.provider === "openai-codex" && model.id.startsWith("gpt-5.6");
	if (mode === "function") return false;
	if (mode === "freeform" && !eligible) {
		throw new Error("Code-mode freeform input requires openai-codex, openai-codex-responses, and a gpt-5.6 model");
	}
	return eligible;
}

async function resolveHostIdentity(
	factory: LocalHostIdentity | undefined,
	env: NodeJS.ProcessEnv,
): Promise<HostIdentity> {
	if (factory) return validateCompleteHost(factory);
	const values = {
		executablePath: env.PI_CODE_MODE_HOST_PATH,
		sha256: env.PI_CODE_MODE_HOST_SHA256,
		sizeBytes: env.PI_CODE_MODE_HOST_SIZE,
		platform: env.PI_CODE_MODE_HOST_PLATFORM,
		architecture: env.PI_CODE_MODE_HOST_ARCH,
	};
	const present = Object.values(values).filter((value) => value !== undefined).length;
	if (present === 0) {
		const installed = await (await import("../installed-host.js")).resolveInstalledHostIdentity();
		if (!installed) throw new Error("Code-mode host is not configured");
		return installed;
	}
	if (present !== 5) {
		throw new Error("Code-mode host environment must define all five PI_CODE_MODE_HOST_* variables");
	}
	const { executablePath, sha256, sizeBytes, platform, architecture } = values;
	if (
		executablePath === undefined ||
		sha256 === undefined ||
		sizeBytes === undefined ||
		platform === undefined ||
		architecture === undefined
	) {
		throw new Error("Code-mode host environment changed during resolution");
	}
	if (!/^[1-9]\d*$/.test(sizeBytes)) {
		throw new Error("PI_CODE_MODE_HOST_SIZE must be a positive decimal integer");
	}
	return validateCompleteHost({
		executablePath,
		sha256,
		sizeBytes: Number(sizeBytes),
		platform: platform as NodeJS.Platform,
		architecture: architecture as NodeJS.Architecture,
	});
}

function validateCompleteHost(value: LocalHostIdentity): HostIdentity {
	if (
		typeof value.executablePath !== "string" ||
		typeof value.sha256 !== "string" ||
		!Number.isSafeInteger(value.sizeBytes) ||
		typeof value.platform !== "string" ||
		typeof value.architecture !== "string"
	) {
		throw new Error("Code-mode factory host identity must provide all five valid values");
	}
	return { ...value };
}

function markSchema<T extends TSchema>(schema: T, marker: object): T {
	Object.defineProperty(schema, OWNER_MARKER, {
		value: marker,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	return deepFreeze(schema);
}

function readMarker(schema: TSchema): unknown {
	return (schema as TSchema & { [OWNER_MARKER]?: object })[OWNER_MARKER];
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

function assertExactNames(actual: readonly string[], expected: readonly string[], label: string): void {
	if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
		throw new Error(
			`Code-mode ${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
		);
	}
}

function boundedError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length <= 512 ? text : `${text.slice(0, 511)}…`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}
