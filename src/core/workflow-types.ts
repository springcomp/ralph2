export type WorkflowStatus =
  | "complete"
  | "blocked"
  | "iterationLimit"
  | "processFailure"
  | "canceled";
export interface WorkflowEvent {
  type: string;
  iteration: number;
  stage?: string;
  message: string;
}
export interface WorkflowOptions {
  model?: string | null;
  agent?: string | null;
  harness?: string;
  maxIterations?: number;
  signal?: AbortSignal;
}
export interface WorkflowRunResult {
  status: WorkflowStatus;
  message: string;
  iterations: number;
  events: WorkflowEvent[];
  exitCode: number;
}
export interface WorkflowEngineCallbacks {
  onEvent?: (event: WorkflowEvent) => void | Promise<void>;
  onStatus?: (status: string) => void | Promise<void>;
}
