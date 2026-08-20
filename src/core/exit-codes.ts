/** Process exit codes exposed by workflow commands. */
export const WorkflowExitCodes = Object.freeze({
  Complete: 0,
  InvalidConfiguration: 2,
  Blocked: 3,
  IterationLimitReached: 4,
  ProcessFailure: 5,
} as const);

export type WorkflowExitCode =
  (typeof WorkflowExitCodes)[keyof typeof WorkflowExitCodes];
