import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { CodeModeExtensionOptions } from "./public-types.js";

export type { CellLimits, JsonStructureLimits, SessionLimits } from "./constants.js";
export {
	CLIENT_FRAME_BYTES,
	CONTROLLER_CELL_CLOSE_MS,
	CONTROLLER_LOSS_CLEANUP_MS,
	CONTROLLER_OPERATION_DRAIN_MS,
	CONTROLLER_PREPARE_CLOSE_MS,
	DEFAULT_JSON_STRUCTURE_LIMITS,
	DEFAULT_OUTER_ERROR_BYTES,
	DEFAULT_SESSION_LIMITS,
	DELEGATE_RESULT_BYTES,
	HOST_CANCEL_GRACE_MS,
	HOST_CLOSE_MS,
	HOST_HANDSHAKE_MS,
	HOST_MAX_PENDING_OPERATIONS,
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
} from "./constants.js";
export type {
	AnyToolDefinition,
	CodeModeExtensionOptions,
	LocalHostIdentity,
	NestedAfterCallback,
	NestedBeforeCallback,
} from "./public-types.js";

export function createCodeModeExtension(options: CodeModeExtensionOptions = {}): ExtensionFactory {
	return (pi) => new LazyExtensionRuntime(pi, options).register();
}

interface ExtensionEngine {
	enable(context: ExtensionCommandContext): Promise<void>;
	modelChanged(context: ExtensionContext): Promise<void>;
	disable(): Promise<void>;
	isEnabled(): boolean;
	statusText(): string;
}

class LazyExtensionRuntime {
	private readonly mutex = new LifecycleMutex();
	private engine?: ExtensionEngine;
	private installAbort?: AbortController;
	private reloadRequired = false;
	private lastError?: string;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly options: CodeModeExtensionOptions,
	) {}

	register(): void {
		this.pi.registerCommand("code-mode", {
			description: "Toggle bounded code mode on or off",
			handler: async (args, context) => {
				if (args.trim()) throw new Error("Usage: /code-mode");
				if (this.installAbort) throw new Error("/code-mode-host-install is running");
				if (this.reloadRequired) throw new Error("Code-mode host was installed; run /reload before enabling");
				await this.mutex.run(async () => {
					if (!context.isIdle()) throw new Error("/code-mode requires idle agent");
					if (this.engine?.isEnabled()) await this.engine.disable();
					else await this.enable(context);
				});
				context.ui.notify(this.statusText(), "info");
			},
		});
		this.pi.registerCommand("code-mode-host-install", {
			description: "Build, validate, and install package-owned code-mode host",
			handler: async (args, context) => {
				if (args.trim()) throw new Error("Usage: /code-mode-host-install");
				if (!context.isIdle()) throw new Error("/code-mode-host-install requires idle agent");
				if (this.engine?.isEnabled()) throw new Error("/code-mode-host-install requires code mode to be disabled");
				if (this.installAbort) throw new Error("/code-mode-host-install is already running");
				const abort = new AbortController();
				this.installAbort = abort;
				try {
					const result = await this.mutex.run(async () => {
						if (!context.isIdle()) throw new Error("/code-mode-host-install requires idle agent");
						if (this.engine?.isEnabled()) {
							throw new Error("/code-mode-host-install requires code mode to be disabled");
						}
						const module = await import("./host-install.js");
						return await module.installCodeModeHost(context, abort.signal);
					});
					this.reloadRequired = true;
					const warningText = result.warnings.length ? ` Warnings: ${result.warnings.join(" ")}` : "";
					context.ui.notify(
						`Code-mode host installed: ${result.sha256} (${result.executablePath}). Run /reload before /code-mode.${warningText}`,
						result.warnings.length ? "warning" : "info",
					);
				} finally {
					if (this.installAbort === abort) this.installAbort = undefined;
				}
			},
		});
		this.pi.registerCommand("code-mode-status", {
			description: "Show bounded code mode status",
			handler: async (args, context) => {
				if (args.trim()) throw new Error("Usage: /code-mode-status");
				context.ui.notify(this.statusText(), "info");
			},
		});
		this.pi.on("model_select", async (_event, context) => {
			await this.mutex.run(async () => {
				if (!this.engine?.isEnabled()) return;
				try {
					this.lastError = undefined;
					await this.engine.modelChanged(context);
				} catch (error) {
					this.lastError = boundedError(error);
					context.ui.notify(`Code-mode model transition failed: ${this.lastError}`, "error");
				}
			});
		});
		this.pi.on("session_shutdown", async () => {
			this.installAbort?.abort(new Error("Code-mode host install cancelled by session shutdown"));
			await this.mutex.run(async () => this.engine?.disable());
		});
	}

	private async enable(context: ExtensionCommandContext): Promise<void> {
		if (!this.engine) {
			let module: typeof import("./runtime/extension.js");
			try {
				module = await import("./runtime/extension.js");
			} catch (error) {
				this.lastError = boundedError(error);
				throw new Error(`Code-mode runtime load failed: ${this.lastError}`);
			}
			this.engine = module.createExtensionRuntime(this.pi, this.options);
		}
		this.lastError = undefined;
		await this.engine.enable(context);
	}

	private statusText(): string {
		const base = this.engine
			? [this.engine.statusText()]
			: ["code-mode: off", "tools: unclaimed", "provider: normal (no overlay)"];
		return [
			...base,
			...(this.installAbort ? ["host install: running"] : []),
			...(this.reloadRequired ? ["host install: complete; reload required"] : []),
			...(this.lastError ? [`last error: ${this.lastError}`] : []),
		].join("; ");
	}
}

function boundedError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length <= 512 ? text : `${text.slice(0, 511)}…`;
}

class LifecycleMutex {
	private tail?: Promise<void>;

	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail ? this.tail.then(operation) : Promise.resolve().then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

const defaultExtension: ExtensionFactory = createCodeModeExtension();
export default defaultExtension;
