import { parse } from "yaml";
import { PlaceholderRegistry } from "../core/placeholders.js";
import {
  defaultExtensionRegistry,
  type ExtensionRegistry,
} from "../extensions/registry.js";
import type { CommandDto, V1WorkflowDocument } from "./schema-v1.js";

export interface Diagnostic {
  path: string;
  message: string;
}
export class WorkflowValidationError extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n"));
  }
}
const string = (v: unknown): v is string => typeof v === "string";
const nonempty = (v: unknown): v is string => string(v) && v.trim().length > 0;
const known = PlaceholderRegistry.names;
function placeholders(path: string, values: unknown[], out: Diagnostic[]) {
  values.forEach((value, i) => {
    if (!string(value)) return;
    for (const m of value.matchAll(/\{([^}]+)\}/g))
      if (!known.has(m[1].toUpperCase()))
        out.push({
          path: `${path}[${i}]`,
          message: `unknown placeholder {${m[1]}}`,
        });
  });
}
function command(
  path: string,
  value: unknown,
  out: Diagnostic[],
  extensions: ExtensionRegistry,
) {
  if (!value || typeof value !== "object") {
    out.push({ path, message: "must be an object" });
    return;
  }
  const c = value as CommandDto;
  if (!nonempty(c.executable))
    out.push({ path: `${path}.executable`, message: "is required" });
  if (
    c.arguments !== undefined &&
    (!Array.isArray(c.arguments) || c.arguments.some((x) => !string(x)))
  )
    out.push({ path: `${path}.arguments`, message: "must be a string array" });
  placeholders(
    `${path}.arguments`,
    Array.isArray(c.arguments) ? c.arguments : [],
    out,
  );
  if (
    c.timeout !== undefined &&
    (!string(c.timeout) || parseTimeout(c.timeout) <= 0)
  )
    out.push({ path: `${path}.timeout`, message: "must be greater than zero" });
  if (
    c.conditionalArguments !== undefined &&
    !Array.isArray(c.conditionalArguments)
  )
    out.push({
      path: `${path}.conditionalArguments`,
      message: "must be an array",
    });
  for (const [i, g] of (Array.isArray(c.conditionalArguments)
    ? c.conditionalArguments
    : []
  ).entries()) {
    const x = g as { whenSet?: unknown; arguments?: unknown };
    if (!nonempty(x.whenSet))
      out.push({
        path: `${path}.conditionalArguments[${i}].whenSet`,
        message: "is required",
      });
    else if (!PlaceholderRegistry.conditionalNames.has(x.whenSet.toUpperCase()))
      out.push({
        path: `${path}.conditionalArguments[${i}].whenSet`,
        message: `unknown conditional placeholder ${x.whenSet}`,
      });
    placeholders(
      `${path}.conditionalArguments[${i}].arguments`,
      Array.isArray(x.arguments) ? x.arguments : [],
      out,
    );
  }
  if (c.environment !== undefined && !Array.isArray(c.environment))
    out.push({ path: `${path}.environment`, message: "must be an array" });
  for (const [i, e] of (Array.isArray(c.environment)
    ? c.environment
    : []
  ).entries()) {
    const x = e as { name?: unknown; value?: unknown };
    if (!nonempty(x.name))
      out.push({
        path: `${path}.environment[${i}].name`,
        message: "is required",
      });
    if (!string(x.value))
      out.push({
        path: `${path}.environment[${i}].value`,
        message: "is required",
      });
    else placeholders(`${path}.environment[${i}].value`, [x.value], out);
  }
  if (c.onFailure) {
    if (!nonempty(c.onFailure.action) || !extensions.action(c.onFailure.action))
      out.push({
        path: `${path}.onFailure.action`,
        message: "must name a registered action",
      });
    if (!nonempty(c.onFailure.task))
      out.push({ path: `${path}.onFailure.task`, message: "is required" });
  }
}
export function parseWorkflowYaml(text: string): V1WorkflowDocument {
  try {
    const value = parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("document must be a mapping");
    return value as V1WorkflowDocument;
  } catch (e) {
    throw new WorkflowValidationError([
      { path: "$", message: e instanceof Error ? e.message : String(e) },
    ]);
  }
}
export function validateWorkflow(
  document: V1WorkflowDocument,
  extensions: ExtensionRegistry = defaultExtensionRegistry,
): Diagnostic[] {
  const d: Diagnostic[] = [];
  if (document.schemaVersion !== 1)
    d.push({ path: "schemaVersion", message: "must be 1" });
  if (!nonempty(document.workspace))
    d.push({ path: "workspace", message: "is required" });
  if (typeof document.maxIterations !== "number" || document.maxIterations <= 0)
    d.push({ path: "maxIterations", message: "must be greater than zero" });
  const t = document.tasks;
  if (!t || typeof t !== "object")
    d.push({ path: "tasks", message: "is required" });
  else
    for (const key of ["prd", "progress", "prompt"])
      if (!nonempty(t[key as keyof typeof t]))
        d.push({ path: `tasks.${key}`, message: "is required" });
  const defs = document.defaults;
  if (!defs || typeof defs !== "object")
    d.push({ path: "defaults", message: "is required" });
  else if (!nonempty(defs.harness))
    d.push({ path: "defaults.harness", message: "is required" });
  else if (
    !document.harnesses ||
    !Object.keys(document.harnesses).some(
      (x) => x.toLowerCase() === defs.harness?.toString().toLowerCase(),
    )
  )
    d.push({
      path: "defaults.harness",
      message: "must name configured harness",
    });
  if (!document.harnesses || Object.keys(document.harnesses).length === 0)
    d.push({ path: "harnesses", message: "must contain at least one harness" });
  else
    for (const [name, c] of Object.entries(document.harnesses))
      command(`harnesses.${name}`, c, d, extensions);
  for (const [key, list] of [
    ["preAgent", document.preAgent],
    ["postAgent", document.postAgent],
  ] as const)
    for (const [i, c] of (list ?? []).entries())
      command(`${key}[${i}]`, c, d, extensions);
  const cont = document.continuation;
  if (cont) {
    if (!nonempty(cont.kind))
      d.push({ path: "continuation.kind", message: "is required" });
    else if (!["blueprint", "generatedGoal"].includes(cont.kind))
      d.push({
        path: "continuation.kind",
        message: "must be blueprint or generatedGoal",
      });
    if (cont.kind === "blueprint" && !nonempty(cont.source))
      d.push({ path: "continuation.source", message: "is required" });
    if (cont.kind === "generatedGoal") {
      if (!cont.producer)
        d.push({ path: "continuation.producer", message: "is required" });
      else command("continuation.producer", cont.producer, d, extensions);
      if (!cont.completeWhen)
        d.push({ path: "continuation.completeWhen", message: "is required" });
      if (!nonempty(cont.nextTask))
        d.push({ path: "continuation.nextTask", message: "is required" });
      else placeholders("continuation.nextTask", [cont.nextTask], d);
    }
  }
  if (defs?.statusFormat)
    placeholders("defaults.statusFormat", [defs.statusFormat], d);
  return d;
}
export function parseTimeout(value: unknown): number {
  if (value === undefined || value === null || value === "") return 300000;
  if (!string(value)) return 0;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)([smh])$/i);
  return m
    ? Number(m[1]) *
        { s: 1000, m: 60000, h: 3600000 }[m[2].toLowerCase() as "s" | "m" | "h"]
    : Number(value) > 0
      ? Number(value)
      : 0;
}
