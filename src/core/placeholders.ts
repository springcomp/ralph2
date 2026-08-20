export interface PlaceholderDefinition {
  readonly name: string;
  readonly description: string;
}

export interface PlaceholderContext {
  readonly model?: string | null;
  readonly agent?: string | null;
  readonly type?: string | null;
  readonly number?: string | number | null;
  readonly task?: string | null;
  readonly taskLine?: string | null;
  readonly prompt?: string | null;
  readonly prd?: string | null;
  readonly progress?: string | null;
  readonly iteration: number;
  readonly workspace?: string | null;
}

export interface ConditionalArguments {
  readonly whenSet: string;
  readonly arguments: readonly string[];
}

export interface ExpandableArguments {
  readonly arguments?: readonly string[];
  readonly conditionalArguments?: readonly ConditionalArguments[];
}

export const PlaceholderRegistry = Object.freeze({
  definitions: [
    { name: "MODEL", description: "The model selected for the workflow." },
    { name: "AGENT", description: "The agent selected for the workflow." },
    { name: "TYP", description: "The type of the current task." },
    { name: "NUM", description: "The number of the current task." },
    { name: "TASK", description: "The description of the current task." },
    {
      name: "TASK_LINE",
      description: "The complete source line for the current task.",
    },
    { name: "PROMPT", description: "The path to the agent prompt file." },
    { name: "PRD", description: "The path to the PRD task file." },
    { name: "PROGRESS", description: "The path to the progress file." },
    {
      name: "ITERATION",
      description: "The current workflow iteration number.",
    },
    {
      name: "ITERATION:000",
      description: "The current iteration number padded to three digits.",
    },
    { name: "WORKSPACE", description: "The path to the workflow workspace." },
  ] as readonly PlaceholderDefinition[],
  names: new Set([
    "MODEL",
    "AGENT",
    "TYP",
    "NUM",
    "TASK",
    "TASK_LINE",
    "PROMPT",
    "PRD",
    "PROGRESS",
    "ITERATION",
    "ITERATION:000",
    "WORKSPACE",
  ]),
  conditionalNames: new Set([
    "MODEL",
    "AGENT",
    "TYP",
    "NUM",
    "TASK",
    "TASK_LINE",
    "PROMPT",
    "PRD",
    "PROGRESS",
    "ITERATION",
    "WORKSPACE",
  ]),
});

export class PlaceholderExpander {
  expand(value: string, context: PlaceholderContext): string {
    this.validate(value);
    const values: Record<string, string> = {
      MODEL: context.model ?? "",
      AGENT: context.agent ?? "",
      TYP: context.type ?? "",
      NUM: String(context.number ?? ""),
      TASK: context.task ?? "",
      TASK_LINE: context.taskLine ?? "",
      PROMPT: context.prompt ?? "",
      PRD: context.prd ?? "",
      PROGRESS: context.progress ?? "",
      ITERATION: String(context.iteration),
      "ITERATION:000": String(context.iteration).padStart(3, "0"),
      WORKSPACE: context.workspace ?? "",
    };
    return value.replace(
      /\{([^}]+)\}/g,
      (_, name: string) => values[name.toUpperCase()] ?? "",
    );
  }

  expandArguments(
    stage: ExpandableArguments,
    context: PlaceholderContext,
  ): string[] {
    const result = (stage.arguments ?? []).map((argument) =>
      this.expand(argument, context),
    );
    for (const conditional of stage.conditionalArguments ?? []) {
      if (
        !PlaceholderRegistry.conditionalNames.has(
          conditional.whenSet.toUpperCase(),
        )
      ) {
        throw new Error(
          `Unknown conditional placeholder: {${conditional.whenSet}}`,
        );
      }
      if (this.isSet(conditional.whenSet, context)) {
        result.push(
          ...conditional.arguments.map((argument) =>
            this.expand(argument, context),
          ),
        );
      }
    }
    return result;
  }

  expandEnvironment(
    environment: Record<string, string>,
    context: PlaceholderContext,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(environment).map(([key, value]) => [
        key,
        this.expand(value, context),
      ]),
    );
  }

  expandOutputPath(path: string, context: PlaceholderContext): string {
    return this.expand(path, context);
  }

  validate(value: string): void {
    for (const match of value.matchAll(/\{([^}]+)\}/g)) {
      const name = match[1];
      if (!PlaceholderRegistry.names.has(name.toUpperCase())) {
        throw new Error(`Unknown placeholder: {${name}}`);
      }
    }
  }

  private isSet(name: string, context: PlaceholderContext): boolean {
    const values = this.expand(`{${name}}`, context);
    return values.trim().length > 0;
  }
}

export const conditionalArguments = (
  groups: readonly ConditionalArguments[],
  context: PlaceholderContext,
  expander = new PlaceholderExpander(),
): string[] =>
  expander.expandArguments({ conditionalArguments: groups }, context);
