import type { StagePlan } from "../config/compiler.js";
import type { MarkdownTaskSource } from "../core/markdown-task-source.js";
import type { PlaceholderContext } from "../core/placeholders.js";
import type { ProcessResult } from "../core/process-runner.js";

export interface ExtensionEvent {
  type: string;
  iteration: number;
  stage?: string;
  message: string;
}

export interface ActionContext {
  source: MarkdownTaskSource;
  prdPath: string;
  stage: StagePlan;
  values: PlaceholderContext;
  expand: (value: string) => string;
  result: ProcessResult;
  iteration: number;
  emit: (event: ExtensionEvent) => Promise<void>;
}

export type ActionCallback = (context: ActionContext) => Promise<void>;

export interface PredicateContext {
  path?: string;
  check?: StagePlan;
  expand: (value: string) => string;
  runStage: (stage: StagePlan) => Promise<{ success: boolean }>;
}

export type PredicateCallback = (context: PredicateContext) => Promise<boolean>;
