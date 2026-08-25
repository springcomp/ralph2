export interface V1WorkflowDocument {
  schemaVersion?: unknown;
  workspace?: unknown;
  envFile?: unknown;
  environment?: (EnvironmentVariableDto | string)[] | null;
  maxIterations?: unknown;
  maxRemediationAttempts?: unknown;
  tasks?: TaskFilesDto | null;
  defaults?: DefaultsDto | null;
  harnesses?: Record<string, CommandDto> | null;
  preAgent?: CommandDto[] | null;
  postAgent?: CommandDto[] | null;
  verification?: VerificationDto | null;
  continuation?: ContinuationDto | null;
  trigger?: TriggerDto | null;
  circuitBreaker?: CircuitBreakerDto | null;
}
export interface TaskFilesDto {
  format?: unknown;
  prd?: unknown;
  progress?: unknown;
  prompt?: unknown;
  completionSignal?: unknown;
  metadata?: { model?: unknown; agent?: unknown } | null;
}
export interface DefaultsDto {
  harness?: unknown;
  model?: unknown;
  agent?: unknown;
  statusFormat?: unknown;
}
export interface CommandDto {
  name?: unknown;
  executable?: unknown;
  arguments?: unknown;
  conditionalArguments?: unknown;
  environment?: (EnvironmentVariableDto | string)[] | null;
  envFile?: unknown;
  failurePolicy?: unknown;
  timeout?: unknown;
  successExitCodes?: unknown;
  output?: { combined?: unknown } | null;
  onFailure?: { action?: unknown; task?: unknown } | null;
  pty?: unknown;
  mandatory?: unknown;
  result?: { path?: unknown; required?: unknown } | null;
}
export interface ConditionalArgumentsDto {
  whenSet?: unknown;
  arguments?: unknown;
}
export interface EnvironmentVariableDto {
  name?: unknown;
  value?: unknown;
  secret?: unknown;
}
export interface VerificationDto {
  requireTaskChecked?: unknown;
  retries?: unknown;
  prompt?: unknown;
}
export interface ContinuationDto {
  [key: string]: unknown;
  kind?: unknown;
}
export interface TriggerDto {
  kind?: unknown;
  source?: unknown;
  pollInterval?: unknown;
}
export interface CircuitBreakerCheckDto {
  kind?: unknown;
  threshold?: unknown;
}
export interface CircuitBreakerDto {
  checks?: CircuitBreakerCheckDto[] | null;
}
export interface CompletionPredicateDto {
  kind?: unknown;
  path?: unknown;
  check?: CommandDto | null;
}
