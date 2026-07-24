import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { NATIVE_MAX_PROVIDER_ERROR_BYTES, NATIVE_OVERLAY_DRAIN_MS } from "../constants.js";
import { nativeErrorText } from "./error-text.js";

export type ProviderSnapshot =
	| { kind: "none" }
	| { kind: "config"; value: ProviderConfig }
	| { kind: "native"; value: Provider }
	| { kind: "inconsistent"; config: ProviderConfig; native: Provider };

export interface NativeOverlayTransaction {
	readonly providerId: string;
	readonly overlay: Provider;
	install(): void;
	restore(): Promise<void>;
}

export function readProviderSnapshot(registry: ModelRegistry, providerId: string): ProviderSnapshot {
	const config = registry.getRegisteredProviderConfig(providerId);
	const native = registry.getRegisteredNativeProvider(providerId);
	if (config && native) return { kind: "inconsistent", config, native };
	if (native) return { kind: "native", value: native };
	if (config) return { kind: "config", value: config };
	return { kind: "none" };
}

export function prepareNativeOverlay(
	pi: ExtensionAPI,
	registry: ModelRegistry,
	providerId: string,
): NativeOverlayTransaction {
	const prior = readProviderSnapshot(registry, providerId);
	if (prior.kind === "native") throw new Error(`Code-mode native provider already registered for ${providerId}`);
	if (prior.kind === "inconsistent")
		throw new Error(`Code-mode provider registration is inconsistent for ${providerId}`);
	const effective = registry.getProvider(providerId);
	if (!effective) throw new Error(`Code-mode provider ${providerId} is unavailable`);
	const requestAbort = new AbortController();
	const relayTasks = new Set<Promise<void>>();
	const retainedStream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		const relay = createAssistantMessageEventStream();
		const signal = options?.signal ? AbortSignal.any([options.signal, requestAbort.signal]) : requestAbort.signal;
		const task = relayNativeStream(model, context, { ...options, signal }, relay).finally(() =>
			relayTasks.delete(task),
		);
		relayTasks.add(task);
		return relay;
	};
	const overlay = Object.create(Object.getPrototypeOf(effective)) as Provider;
	for (const key of Reflect.ownKeys(effective)) {
		const descriptor = Object.getOwnPropertyDescriptor(effective, key);
		if (!descriptor) throw new Error("Provider descriptor disappeared during overlay construction");
		Object.defineProperty(overlay, key, descriptor);
	}
	const priorStreamDescriptor = Object.getOwnPropertyDescriptor(effective, "streamSimple");
	if (priorStreamDescriptor && !("value" in priorStreamDescriptor)) {
		throw new Error(`Code-mode provider ${providerId} has accessor streamSimple`);
	}
	Object.defineProperty(overlay, "streamSimple", {
		...(priorStreamDescriptor ?? { writable: true, enumerable: true, configurable: true }),
		value: retainedStream,
	});
	const expectedStreamDescriptor = Object.getOwnPropertyDescriptor(overlay, "streamSimple");
	if (!expectedStreamDescriptor || !("value" in expectedStreamDescriptor)) {
		throw new Error(`Code-mode provider ${providerId} streamSimple overlay is invalid`);
	}
	const expected = snapshotValue(overlay, new Map(), new Set<PropertyKey>(["streamSimple"]));
	const expectedModels = snapshotValue(overlay.getModels());
	const expectedPriorConfig = prior.kind === "config" ? snapshotValue(prior.value) : undefined;
	let installed = false;

	const ownsCurrent = (): boolean => {
		const current = readProviderSnapshot(registry, providerId);
		if (current.kind !== "native" || current.value !== overlay) return false;
		const streamDescriptor = Object.getOwnPropertyDescriptor(current.value, "streamSimple");
		if (!matchesDataDescriptor(streamDescriptor, expectedStreamDescriptor, retainedStream)) return false;
		if (!matchesSnapshot(current.value, expected, new Map(), new Set<PropertyKey>(["streamSimple"]))) return false;
		let models: unknown;
		try {
			models = current.value.getModels();
		} catch {
			return false;
		}
		return matchesSnapshot(models, expectedModels);
	};

	return {
		providerId,
		overlay,
		install() {
			if (installed) return;
			const current = readProviderSnapshot(registry, providerId);
			const unchanged =
				(prior.kind === "none" && current.kind === "none") ||
				(prior.kind === "config" &&
					current.kind === "config" &&
					current.value === prior.value &&
					matchesSnapshot(current.value, expectedPriorConfig));
			if (!unchanged) {
				throw new Error(`Code-mode provider ${providerId} changed before overlay commit`);
			}
			pi.registerProvider(overlay);
			installed = true;
			if (!ownsCurrent()) throw new Error(`Code-mode provider overlay verification failed for ${providerId}`);
		},
		async restore() {
			if (!installed) return;
			requestAbort.abort(new Error("Code-mode provider overlay is restoring"));
			let drainError: unknown;
			try {
				await withDeadline(
					drainRelayTasks(relayTasks),
					NATIVE_OVERLAY_DRAIN_MS,
					"Code-mode native stream drain timed out",
				);
			} catch (error) {
				drainError = error;
			}
			if (prior.kind === "config" && !matchesSnapshot(prior.value, expectedPriorConfig)) {
				throw new Error(`Code-mode prior provider config collision for ${providerId}`);
			}
			if (!ownsCurrent()) throw new Error(`Code-mode provider ownership collision for ${providerId}`);
			if (prior.kind === "config") pi.registerProvider(providerId, prior.value);
			else pi.unregisterProvider(providerId);
			installed = false;
			const restored = readProviderSnapshot(registry, providerId);
			if (prior.kind === "none") {
				if (restored.kind !== "none") throw new Error(`Code-mode provider absence restore failed for ${providerId}`);
			} else if (restored.kind !== "config" || !matchesSnapshot(restored.value, expectedPriorConfig)) {
				throw new Error(`Code-mode provider config restore failed for ${providerId}`);
			}
			if (drainError) throw drainError;
		},
	};
}

function matchesDataDescriptor(
	actual: PropertyDescriptor | undefined,
	expected: PropertyDescriptor,
	expectedValue: unknown,
): boolean {
	return (
		actual !== undefined &&
		"value" in actual &&
		"value" in expected &&
		actual.value === expectedValue &&
		expected.value === expectedValue &&
		(actual.configurable ?? false) === (expected.configurable ?? false) &&
		(actual.enumerable ?? false) === (expected.enumerable ?? false) &&
		(actual.writable ?? false) === (expected.writable ?? false)
	);
}

async function relayNativeStream(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	relay: ReturnType<typeof createAssistantMessageEventStream>,
): Promise<void> {
	try {
		options.signal?.throwIfAborted();
		const { streamNativeCodeMode } = await import("./stream.js");
		options.signal?.throwIfAborted();
		const source: AssistantMessageEventStream = streamNativeCodeMode(model, context, options);
		for await (const event of source) relay.push(event);
		relay.end();
	} catch (error) {
		failRelay(relay, model, error);
	}
}

async function drainRelayTasks(tasks: ReadonlySet<Promise<void>>): Promise<void> {
	while (tasks.size) await Promise.allSettled([...tasks]);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function failRelay(
	relay: ReturnType<typeof createAssistantMessageEventStream>,
	model: Model<Api> | undefined,
	error: unknown,
): void {
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model?.api ?? "openai-codex-responses",
		provider: model?.provider ?? "openai-codex",
		model: model?.id ?? "unknown",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: boundedText(nativeErrorText(error), NATIVE_MAX_PROVIDER_ERROR_BYTES),
		timestamp: Date.now(),
	};
	relay.push({ type: "error", reason: "error", error: output });
	relay.end();
}

type Snapshot =
	| null
	| string
	| number
	| boolean
	| bigint
	| symbol
	| undefined
	| ((...args: never[]) => unknown)
	| ObjectSnapshot;

type ObjectSnapshot = {
	readonly kind: "object";
	readonly prototype: object | null;
	readonly functionIdentity?: (...args: never[]) => unknown;
	readonly descriptors: ReadonlyArray<readonly [PropertyKey, DescriptorSnapshot]>;
};

type DescriptorSnapshot =
	| {
			readonly kind: "data";
			readonly configurable: boolean;
			readonly enumerable: boolean;
			readonly writable: boolean;
			readonly value: Snapshot;
	  }
	| {
			readonly kind: "accessor";
			readonly configurable: boolean;
			readonly enumerable: boolean;
			readonly get: Snapshot;
			readonly set: Snapshot;
	  };

function snapshotValue(
	value: unknown,
	seen = new Map<object, ObjectSnapshot>(),
	omitRootKeys: ReadonlySet<PropertyKey> = new Set(),
): Snapshot {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value as Snapshot;
	const existing = seen.get(value);
	if (existing) return existing;
	const descriptors: Array<readonly [PropertyKey, DescriptorSnapshot]> = [];
	const snapshot: ObjectSnapshot = {
		kind: "object",
		prototype: Object.getPrototypeOf(value),
		...(typeof value === "function" ? { functionIdentity: value as (...args: never[]) => unknown } : {}),
		descriptors,
	};
	seen.set(value, snapshot);
	for (const key of Reflect.ownKeys(value)) {
		if (omitRootKeys.has(key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) throw new Error("Provider descriptor disappeared during snapshot");
		if ("value" in descriptor) {
			descriptors.push([
				key,
				{
					kind: "data",
					configurable: descriptor.configurable ?? false,
					enumerable: descriptor.enumerable ?? false,
					writable: descriptor.writable ?? false,
					value: snapshotValue(descriptor.value, seen),
				},
			]);
		} else {
			descriptors.push([
				key,
				{
					kind: "accessor",
					configurable: descriptor.configurable ?? false,
					enumerable: descriptor.enumerable ?? false,
					get: snapshotValue(descriptor.get, seen),
					set: snapshotValue(descriptor.set, seen),
				},
			]);
		}
	}
	return snapshot;
}

function matchesSnapshot(
	actual: unknown,
	expected: Snapshot,
	seen = new Map<object, ObjectSnapshot>(),
	omitRootKeys: ReadonlySet<PropertyKey> = new Set(),
): boolean {
	if (typeof expected === "function" || expected === null || typeof expected !== "object")
		return Object.is(actual, expected);
	if (actual === null || (typeof actual !== "object" && typeof actual !== "function")) return false;
	if (expected.functionIdentity && actual !== expected.functionIdentity) return false;
	const prior = seen.get(actual);
	if (prior) return prior === expected;
	seen.set(actual, expected);
	if (Object.getPrototypeOf(actual) !== expected.prototype) return false;
	const keys = Reflect.ownKeys(actual).filter((key) => !omitRootKeys.has(key));
	if (keys.length !== expected.descriptors.length) return false;
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index];
		const pair = expected.descriptors[index];
		if (key === undefined || pair === undefined || key !== pair[0]) return false;
		const descriptor = Object.getOwnPropertyDescriptor(actual, key);
		const saved = pair[1];
		if (
			!descriptor ||
			(descriptor.configurable ?? false) !== saved.configurable ||
			(descriptor.enumerable ?? false) !== saved.enumerable
		)
			return false;
		if (saved.kind === "data") {
			if (
				!("value" in descriptor) ||
				(descriptor.writable ?? false) !== saved.writable ||
				!matchesSnapshot(descriptor.value, saved.value, seen)
			)
				return false;
		} else if (
			"value" in descriptor ||
			!matchesSnapshot(descriptor.get, saved.get, seen) ||
			!matchesSnapshot(descriptor.set, saved.set, seen)
		)
			return false;
	}
	return true;
}

function boundedText(value: string, limit: number): string {
	if (Buffer.byteLength(value) <= limit) return value;
	let end = Math.min(value.length, limit - 3);
	while (end > 0 && Buffer.byteLength(value.slice(0, end)) > limit - 3) end--;
	return `${value.slice(0, end)}...`;
}
