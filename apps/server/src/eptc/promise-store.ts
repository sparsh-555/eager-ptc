import { createHash } from "node:crypto";

export interface StoreKey {
  tool: string;
  argsHash: string;
  occurrence: number;
}

export interface WorkTiming {
  startedAtMs: number;
  endedAtMs: number | null;
  workMs: number;
}

export interface PromiseClaim {
  promise: Promise<unknown>;
  timing: WorkTiming;
  ownerCallId: string | null;
  created: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new Error("Arguments are not JSON serializable");
  return serialized;
}

export function argsHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export class PromiseStore {
  private readonly promises = new Map<string, PromiseClaim>();
  private readonly priorTimings = new Map<string, WorkTiming[]>();
  private hits = 0;
  private misses = 0;

  claim(key: StoreKey, run: () => Promise<unknown>): Promise<unknown> {
    return this.claimWithTiming(key, run).promise;
  }

  claimWithTiming(key: StoreKey, run: () => Promise<unknown>, ownerCallId: string | null = null): PromiseClaim {
    const id = this.id(key);
    const existing = this.promises.get(id);
    if (existing) {
      this.hits += 1;
      if (existing.ownerCallId === null && ownerCallId !== null) existing.ownerCallId = ownerCallId;
      return { ...existing, created: false };
    }
    this.misses += 1;
    const timing: WorkTiming = { startedAtMs: Date.now(), endedAtMs: null, workMs: 0 };
    const promise = (async () => {
      try {
        return await run();
      } finally {
        timing.endedAtMs = Date.now();
        timing.workMs = Math.max(0, timing.endedAtMs - timing.startedAtMs);
      }
    })();
    const claim: PromiseClaim = { promise, timing, ownerCallId, created: true };
    this.promises.set(id, claim);
    void promise.catch(() => {
      if (this.promises.get(id) === claim) {
        const previous = this.priorTimings.get(id) ?? [];
        previous.push(timing);
        this.priorTimings.set(id, previous);
        this.promises.delete(id);
      }
    });
    return claim;
  }

  remove(key: StoreKey): void {
    this.promises.delete(this.id(key));
  }

  workTiming(key: StoreKey): WorkTiming | undefined {
    return this.promises.get(this.id(key))?.timing;
  }

  workTimings(key: StoreKey): WorkTiming[] {
    const id = this.id(key);
    const current = this.promises.get(id)?.timing;
    return [...(this.priorTimings.get(id) ?? []), ...(current ? [current] : [])];
  }

  private id(key: StoreKey): string {
    return JSON.stringify([key.tool, key.argsHash, key.occurrence]);
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}
