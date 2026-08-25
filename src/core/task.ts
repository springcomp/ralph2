/** A unit of work pulled from a {@link TaskSource} and driven by the workflow engine. */
export interface Task {
  readonly typ: string;
  readonly num: string;
  readonly id: string;
  readonly description: string;
  readonly rawLine: string;
  readonly model?: string;
  readonly agent?: string;
  readonly lineIndex: number;
}

/** The task-queue contract the workflow engine drives; `MarkdownTaskSource` is the only implementation today. */
export interface TaskSource {
  getFirstUncheckedTask(prdPath: string): Promise<Task | null>;
  remediationDepth(
    prdPath: string,
    target: Task,
  ): Promise<{ depth: number; rootId: string }>;
  isTaskUnchecked(prdPath: string, target: Task): Promise<boolean>;
  checkTask(prdPath: string, task: Task): Promise<void>;
  scheduleTask(prdPath: string, taskLine: string): Promise<void>;
  seedBlueprintTask(
    prdPath: string,
    blueprintPath: string,
  ): Promise<string | null>;
}
