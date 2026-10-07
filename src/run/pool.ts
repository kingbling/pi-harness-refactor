/**
 * Two pools, never shared: many network-bound agent sessions, few CPU-bound gate workers.
 * A plain counting semaphore with FIFO fairness and a priority lane for the gate queue.
 */
export class Semaphore {
	private queue: Array<{ resolve: () => void; priority: number; seq: number }> = [];
	private seq = 0;
	private active = 0;
	constructor(public limit: number) {}

	/** Change the size mid-flight: growing grants waiting work at once; shrinking lets running work finish. */
	setLimit(n: number): void {
		this.limit = Math.max(1, Math.floor(n));
		this.next();
	}

	get waiting(): number {
		return this.queue.length;
	}
	get running(): number {
		return this.active;
	}

	acquire(priority = 0): Promise<() => void> {
		return new Promise((resolve) => {
			const grant = () => {
				this.active++;
				let released = false;
				resolve(() => {
					if (released) return;
					released = true;
					this.active--;
					this.next();
				});
			};
			if (this.active < this.limit && this.queue.length === 0) grant();
			else {
				this.queue.push({ resolve: grant, priority, seq: this.seq++ });
				this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
			}
		});
	}

	private next() {
		while (this.active < this.limit && this.queue.length) this.queue.shift()!.resolve();
	}

	/** Run fn under one slot. */
	async run<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
		const release = await this.acquire(priority);
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

export function gatePoolSize(configured?: number): number {
	const cores = typeof navigator !== "undefined" && (navigator as any).hardwareConcurrency ? (navigator as any).hardwareConcurrency : 4;
	return configured ?? Math.max(2, Math.floor(cores / 4));
}
