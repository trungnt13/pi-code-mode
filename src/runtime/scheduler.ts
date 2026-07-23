export type PermitMode = "shared" | "exclusive";

type QueueEntry = {
	mode: PermitMode;
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

/**
 * FIFO phase-fair shared/exclusive scheduler.
 *
 * A queued exclusive entry blocks later shared entries. Consecutive shared
 * entries at queue head start as one phase.
 */
export class FairScheduler {
	private readonly maxShared: number;
	private activeReaders = 0;
	private activeWriter = false;
	private readonly queue: QueueEntry[] = [];

	constructor(maxShared: number) {
		if (!Number.isSafeInteger(maxShared) || maxShared < 1) {
			throw new Error("Scheduler shared permit limit must be a positive integer");
		}
		this.maxShared = maxShared;
	}

	acquire(mode: PermitMode, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(abortError(signal));
		if (
			this.queue.length === 0 &&
			!this.activeWriter &&
			(mode === "shared" ? this.activeReaders < this.maxShared : this.activeReaders === 0)
		) {
			return Promise.resolve(this.activate(mode));
		}

		return new Promise<() => void>((resolve, reject) => {
			const entry: QueueEntry = { mode, resolve, reject, signal };
			if (signal) {
				entry.onAbort = () => {
					const index = this.queue.indexOf(entry);
					if (index < 0) return;
					this.queue.splice(index, 1);
					reject(abortError(signal));
					this.drain();
				};
				signal.addEventListener("abort", entry.onAbort, { once: true });
			}
			this.queue.push(entry);
		});
	}

	private activate(mode: PermitMode): () => void {
		if (mode === "exclusive") this.activeWriter = true;
		else this.activeReaders++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (mode === "exclusive") this.activeWriter = false;
			else this.activeReaders--;
			this.drain();
		};
	}

	private drain(): void {
		if (this.activeWriter || this.queue.length === 0) return;
		if (this.queue[0]?.mode === "exclusive") {
			if (this.activeReaders > 0) return;
			const entry = this.queue.shift();
			if (!entry) throw new Error("Scheduler queue changed while draining");
			this.resolveEntry(entry);
			return;
		}
		while (this.queue[0]?.mode === "shared" && this.activeReaders < this.maxShared) {
			const entry = this.queue.shift();
			if (!entry) throw new Error("Scheduler queue changed while draining");
			this.resolveEntry(entry);
		}
	}

	private resolveEntry(entry: QueueEntry): void {
		if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
		entry.resolve(this.activate(entry.mode));
	}
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}
