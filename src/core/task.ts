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
export interface TaskDocumentReader {
  /** Read the first unchecked task from this reader's bound document. */
  getFirstUncheckedTask(): Promise<Task | null>;
}

export interface TaskSource extends TaskDocumentReader {
  remediationDepth(target: Task): Promise<{ depth: number; rootId: string }>;
  isTaskUnchecked(target: Task): Promise<boolean>;
  checkTask(task: Task): Promise<void>;
  scheduleTask(taskLine: string): Promise<void>;
  seedBlueprintTask(blueprintPath: string): Promise<string | null>;
}
