import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StateLock } from "./locks.js";
import { atomicWrite } from "./markdown-task-source.js";

/** Persisted per-check streak state, keyed by check name. */
interface CircuitBreakerState {
  [checkName: string]: {
    signature: string;
    streak: number;
  };
}

/** Resolves the path of the circuit breaker state file for a workspace. */
export function circuitBreakerStatePath(workspace: string): string {
  return join(workspace, ".agentic", "__circuit_breaker.json");
}

async function readState(path: string): Promise<CircuitBreakerState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object")
      return parsed as CircuitBreakerState;
    return {};
  } catch {
    return {};
  }
}

export interface CircuitBreakerEvaluation {
  /** Whether the check's streak reached its configured threshold. */
  tripped: boolean;
  /** The signature that produced this result, or null if inactive/reset. */
  signature: string | null;
  /** Streak count after applying this iteration's signature. */
  streak: number;
}

/**
 * Applies the generic circuit-breaker streak rule for a single check:
 * - signature === null -> reset (streak 0, no last signature).
 * - signature === last persisted signature -> streak += 1.
 * - signature differs -> streak = 1, update last signature.
 * - streak >= threshold -> tripped.
 *
 * State is read-modify-written atomically under a state lock so this is safe to
 * call from concurrent iterations/processes sharing the same workspace.
 */
export async function evaluateCircuitBreaker(
  workspace: string,
  checkName: string,
  threshold: number,
  signature: string | null,
): Promise<CircuitBreakerEvaluation> {
  const path = circuitBreakerStatePath(workspace);
  const lock = new StateLock(path);
  return lock.withLock(async () => {
    const state = await readState(path);
    const previous = state[checkName];
    let streak: number;
    if (signature === null) {
      streak = 0;
      delete state[checkName];
    } else if (previous && previous.signature === signature) {
      streak = previous.streak + 1;
      state[checkName] = { signature, streak };
    } else {
      streak = 1;
      state[checkName] = { signature, streak };
    }
    await atomicWrite(path, JSON.stringify(state, null, 2));
    return { tripped: streak >= threshold, signature, streak };
  });
}
