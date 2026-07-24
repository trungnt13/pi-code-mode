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
import type { CodeModeExtensionOptions, LocalHostIdentity } from "../public-types.js";
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
const REQUEST_USER_INPUT = "request_user_input";
const DEFAULT_TOKENS = 10_000;
const MIN_AUTO_RESOLUTION_MS = 60_000;
const MAX_AUTO_RESOLUTION_MS = 240_000;
const MAX_OTHER_ANSWER_LENGTH = 4_096;
type ClaimState = "unclaimed" | "partial" | "claimed";
type NativeOverlayTransaction = {
	readonly providerId: string;
	install(): void;
	restore(): void;
};

export interface ExtensionEngine {
	enable(context: ExtensionCommandContext): Promise<void>;
	modelChanged(context: ExtensionContext): Promise<void>;
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
	const requestUserInputSchema = markSchema(
		Type.Object(
			{
				questions: Type.Array(
					Type.Object(
						{
							id: Type.String({
								pattern: "^[a-z][a-z0-9_]{0,63}$",
								description: "Stable snake_case identifier for mapping answers.",
							}),
							header: Type.String({
								minLength: 1,
								maxLength: 12,
								description: "Short header label, at most 12 characters.",
							}),
							question: Type.String({
								minLength: 1,
								maxLength: 1_024,
								description: "Single-sentence prompt shown to the user.",
							}),
							options: Type.Array(
								Type.Object(
									{
										label: Type.String({ minLength: 1, maxLength: 80 }),
										description: Type.String({ minLength: 1, maxLength: 512 }),
									},
									{ additionalProperties: false },
								),
								{
									minItems: 2,
									maxItems: 3,
									description:
										'Mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include Other; the client adds it.',
								},
							),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1, maxItems: 3, description: "Questions to show. Prefer one and do not exceed three." },
				),
				autoResolutionMs: Type.Optional(
					Type.Integer({
						minimum: MIN_AUTO_RESOLUTION_MS,
						maximum: MAX_AUTO_RESOLUTION_MS,
						description: "Optional non-blocking auto-resolution window. Omit when explicit user input is required.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		marker,
	);
	return new ExtensionRuntime(pi, options, explicitTools, marker, execSchema, waitSchema, requestUserInputSchema);
}

class ExtensionRuntime {
	private readonly pi: ExtensionAPI;
	private readonly options: CodeModeExtensionOptions;
	private readonly explicitTools: readonly AnyToolDefinition[];
	private readonly marker: object;
	private readonly execSchema: TSchema;
	private readonly waitSchema: TSchema;
	private readonly requestUserInputSchema: TSchema;
	private readonly execTool: AnyToolDefinition;
	private readonly waitTool: AnyToolDefinition;
	private readonly requestUserInputTool: AnyToolDefinition;
	private claimState: ClaimState = "unclaimed";
	private enabled = false;
	private active = false;
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
		requestUserInputSchema: TSchema,
	) {
		this.pi = pi;
		this.options = options;
		this.explicitTools = explicitTools;
		this.marker = marker;
		this.execSchema = execSchema;
		this.waitSchema = waitSchema;
		this.requestUserInputSchema = requestUserInputSchema;
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
		this.requestUserInputTool = Object.freeze({
			name: REQUEST_USER_INPUT,
			label: "Request user input",
			description:
				"Request user input for one to three short questions and wait for the response. Set autoResolutionMs only for non-blocking questions where continuing without an answer is acceptable.",
			parameters: requestUserInputSchema,
			executionMode: "sequential",
			execute: async (
				_toolCallId: string,
				params: unknown,
				signal: AbortSignal | undefined,
				_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
				context: ExtensionContext,
			) => {
				this.requireActive();
				return await requestUserInput(params, context, signal);
			},
		});
	}

	async enable(context: ExtensionCommandContext): Promise<void> {
		if (this.enabled) return;
		this.lastError = undefined;
		this.enabled = true;
		if (!supportsCodeModeOnly(context)) return;
		try {
			await this.activate(context);
		} catch (error) {
			this.enabled = false;
			throw error;
		}
	}

	async modelChanged(context: ExtensionContext): Promise<void> {
		if (!this.enabled) return;
		this.lastError = undefined;
		if (!supportsCodeModeOnly(context)) {
			await this.deactivate();
			return;
		}
		if (!this.active) await this.activate(context);
	}

	private async activate(context: ExtensionContext): Promise<void> {
		if (this.active) return;
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
		const overlay = (await import("../native/overlay.js")).prepareNativeOverlay(
			this.pi,
			context.modelRegistry,
			context.model?.provider ?? "",
		);

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
				this.pi.registerTool(this.requestUserInputTool);
				this.assertOwnedTools();
				this.claimState = "claimed";
			}
			this.assertOwnedTools();
			overlay.install();
			this.pi.setActiveTools([EXEC, WAIT, REQUEST_USER_INPUT]);
			assertExactNames(this.pi.getActiveTools(), [EXEC, WAIT, REQUEST_USER_INPUT], "active code-mode tools");
			this.priorActive = prior;
			this.controller = new CodeModeController({
				host,
				limits: this.options.limits,
				createNestedTools: (outerContext) => this.createNestedTools(outerContext),
				beforeNestedTool: this.options.beforeNestedTool,
				afterNestedTool: this.options.afterNestedTool,
			} satisfies ControllerOptions);
			this.providerOverlay = overlay;
			this.active = true;
		} catch (error) {
			if (claimAttempted) this.reconcileClaimAfterFailure();
			const errors: unknown[] = [error];
			try {
				this.restoreActive(prior);
			} catch (restoreError) {
				errors.push(restoreError);
			}
			try {
				overlay.restore();
			} catch (restoreError) {
				errors.push(restoreError);
			}
			this.active = false;
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
		await this.deactivate();
	}

	private async deactivate(): Promise<void> {
		if (!this.active) return;
		this.active = false;
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
			.filter((tool) => tool.name === EXEC || tool.name === WAIT || tool.name === REQUEST_USER_INPUT)
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
			[REQUEST_USER_INPUT, this.requestUserInputSchema],
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
		if (!this.active || !this.controller) throw new Error("Code mode is not active");
		return this.controller;
	}

	private requireActive(): void {
		if (!this.active) throw new Error("Code mode is not active");
	}

	statusText(): string {
		const metrics = this.controller?.metrics();
		const parts = [
			`code-mode: ${this.enabled ? (this.active ? "enabled, active" : "enabled, normal fallback") : "off"}`,
			`tools: ${
				this.claimState === "claimed"
					? "claimed until reload"
					: this.claimState === "partial"
						? "partial until reload"
						: "unclaimed"
			}`,
			`provider: ${this.providerOverlay ? `native CodeModeOnly (${this.providerOverlay.providerId})` : "normal (no overlay)"}`,
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

function supportsCodeModeOnly(context: ExtensionContext): boolean {
	const model = context.model;
	return model?.api === "openai-codex-responses" && model.provider === "openai-codex" && model.id.startsWith("gpt-5.6");
}

type InputOption = { label: string; description: string };
type InputQuestion = { id: string; header: string; question: string; options: InputOption[] };

async function requestUserInput(
	params: unknown,
	context: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }> {
	const input = requireRecord(params, "request_user_input input");
	if (!exactKeys(input, ["questions", "autoResolutionMs"])) {
		throw new Error("request_user_input input contains unsupported fields");
	}
	if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 3) {
		throw new Error("request_user_input requires 1-3 questions");
	}
	const timeout =
		input.autoResolutionMs === undefined
			? undefined
			: requireBoundedInteger(
					input.autoResolutionMs,
					MIN_AUTO_RESOLUTION_MS,
					MAX_AUTO_RESOLUTION_MS,
					"autoResolutionMs",
				);
	const questions = input.questions.map(parseInputQuestion);
	const ids = new Set<string>();
	for (const question of questions) {
		if (ids.has(question.id)) throw new Error(`Duplicate request_user_input question id ${question.id}`);
		ids.add(question.id);
	}
	const answers: Record<string, { answers: string[] }> = {};
	for (const question of questions) answers[question.id] = { answers: [] };
	const deadline = timeout === undefined ? undefined : Date.now() + timeout;
	for (const question of questions) {
		signal?.throwIfAborted();
		const remaining = deadline === undefined ? undefined : deadline - Date.now();
		if (remaining !== undefined && remaining <= 0) break;
		const choices = question.options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`);
		const other = "Other";
		const dialogOptions = { signal, ...(remaining === undefined ? {} : { timeout: remaining }) };
		const selected = await context.ui.select(
			`${question.header}: ${question.question}`,
			[...choices, other],
			dialogOptions,
		);
		signal?.throwIfAborted();
		if (selected === undefined) break;
		if (selected === other) {
			const inputRemaining = deadline === undefined ? undefined : deadline - Date.now();
			if (inputRemaining !== undefined && inputRemaining <= 0) break;
			const inputDialogOptions = {
				signal,
				...(inputRemaining === undefined ? {} : { timeout: inputRemaining }),
			};
			const value = await context.ui.input(`${question.header}: Other`, "Type your answer", inputDialogOptions);
			signal?.throwIfAborted();
			if (value === undefined) break;
			if (value.length > MAX_OTHER_ANSWER_LENGTH) {
				throw new Error(`request_user_input Other answer exceeds ${MAX_OTHER_ANSWER_LENGTH} characters`);
			}
			answers[question.id] = { answers: [value] };
		} else {
			const index = choices.indexOf(selected);
			if (index < 0) throw new Error("request_user_input received an unknown UI choice");
			const option = question.options[index];
			if (!option) throw new Error("request_user_input choice index is unavailable");
			answers[question.id] = { answers: [option.label] };
		}
	}
	return {
		content: [{ type: "text", text: JSON.stringify({ answers }) }],
		details: {},
	};
}

function parseInputQuestion(value: unknown): InputQuestion {
	const question = requireRecord(value, "request_user_input question");
	if (
		!exactKeys(question, ["id", "header", "question", "options"]) ||
		typeof question.id !== "string" ||
		!/^[a-z][a-z0-9_]{0,63}$/.test(question.id) ||
		typeof question.header !== "string" ||
		question.header.length < 1 ||
		question.header.length > 12 ||
		typeof question.question !== "string" ||
		question.question.length < 1 ||
		question.question.length > 1_024 ||
		!Array.isArray(question.options) ||
		question.options.length < 2 ||
		question.options.length > 3
	) {
		throw new Error("Invalid request_user_input question");
	}
	const options = question.options.map((entry) => {
		const option = requireRecord(entry, "request_user_input option");
		if (
			!exactKeys(option, ["label", "description"]) ||
			typeof option.label !== "string" ||
			option.label.length < 1 ||
			option.label.length > 80 ||
			typeof option.description !== "string" ||
			option.description.length < 1 ||
			option.description.length > 512
		) {
			throw new Error("Invalid request_user_input option");
		}
		return { label: option.label, description: option.description };
	});
	if (new Set(options.map((option) => option.label)).size !== options.length) {
		throw new Error(`Duplicate request_user_input option label for ${question.id}`);
	}
	if (options.some((option) => option.label === "Other")) {
		throw new Error(`request_user_input options for ${question.id} must not include Other`);
	}
	return { id: question.id, header: question.header, question: question.question, options };
}

function requireBoundedInteger(value: unknown, min: number, max: number, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
		throw new Error(`${label} must be an integer from ${min} to ${max}`);
	}
	return value as number;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(value).every((key) => allowedSet.has(key));
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
