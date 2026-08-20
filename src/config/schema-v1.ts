export interface V1WorkflowDocument {
  schemaVersion?: unknown;
  workspace?: unknown;
  maxIterations?: unknown;
  tasks?: TaskFilesDto | null;
  defaults?: DefaultsDto | null;
  harnesses?: Record<string, CommandDto> | null;
  preAgent?: CommandDto[] | null;
  postAgent?: CommandDto[] | null;
  verification?: VerificationDto | null;
  continuation?: ContinuationDto | null;
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
  environment?: unknown;
  failurePolicy?: unknown;
  timeout?: unknown;
  successExitCodes?: unknown;
  output?: { combined?: unknown } | null;
  onFailure?: { action?: unknown; task?: unknown } | null;
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
  kind?: unknown;
  source?: unknown;
  seedPrdFromSource?: unknown;
  completeWhenSourceExhausted?: unknown;
  producer?: string | CommandDto | null;
  completeWhen?: CompletionPredicateDto | null;
  nextTask?: unknown;
}
export interface CompletionPredicateDto {
  kind?: unknown;
  path?: unknown;
  check?: CommandDto | null;
}
