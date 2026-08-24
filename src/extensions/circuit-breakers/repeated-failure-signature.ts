import type { CircuitBreakerRegistration } from "../registry.js";

/**
 * Signature identifies the postAgent stage that failed this iteration (name +
 * exit code). Returns null (reset) when no stage failed, so the streak clears as
 * soon as the workflow makes real progress again. This closes the gap where a
 * non-mandatory gate (`mandatory: false` or `failurePolicy: continue`) fails
 * every iteration with no counter at all today.
 */
export const repeatedFailureSignatureCircuitBreaker: CircuitBreakerRegistration =
  {
    name: "repeatedFailureSignature",
    description:
      "Trips when the same postAgent stage fails with the same exit code across consecutive iterations.",
    properties: [],
    callback: async ({ lastFailure }) => {
      if (!lastFailure) return null;
      return `${lastFailure.stage}:${lastFailure.exitCode ?? "null"}`;
    },
  };
