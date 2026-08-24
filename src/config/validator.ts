import Ajv2020Module, { type ErrorObject } from "ajv/dist/2020.js";
const Ajv2020 = Ajv2020Module as unknown as typeof Ajv2020Module.default;
import { parse } from "yaml";
import { parseEnvAssignment } from "../core/env-file.js";
import { PlaceholderRegistry } from "../core/placeholders.js";
import {
  type ExtensionRegistry,
  defaultExtensionRegistry,
} from "../extensions/registry.js";
import type { CommandDto, V1WorkflowDocument } from "./schema-v1.js";
import { workflowSchema } from "./schema.js";

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
const known = PlaceholderRegistry.names;

/** Convert an Ajv JSON-Pointer instancePath (e.g. "/tasks/prd") into the
 * dot/bracket path notation used throughout this codebase's diagnostics
 * (e.g. "tasks.prd"). Falls back to "$" for the document root. */
function toDiagnosticPath(instancePath: string): string {
  if (!instancePath) return "$";
  return instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<string>((path, segment) => {
      if (/^\d+$/.test(segment)) return `${path}[${segment}]`;
      return path ? `${path}.${segment}` : segment;
    }, "");
}

function ajvDiagnostics(
  errors: ErrorObject[] | null | undefined,
): Diagnostic[] {
  return (errors ?? [])
    .filter((e) => e.keyword !== "oneOf" && e.keyword !== "anyOf")
    .map((e) => {
      const base = toDiagnosticPath(e.instancePath);
      if (e.keyword === "required") {
        const missing = (e.params as { missingProperty?: string })
          .missingProperty;
        return {
          path: missing
            ? base && base !== "$"
              ? `${base}.${missing}`
              : missing
            : base,
          message: "is required",
        };
      }
      return { path: base, message: e.message ?? "is invalid" };
    });
}

/** Runs schema-driven structural validation using Ajv against the same
 * JSON Schema document exposed by `ralph schema show`. */
export function validateWorkflowSchema(
  document: unknown,
  extensions: ExtensionRegistry = defaultExtensionRegistry,
): Diagnostic[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(workflowSchema(extensions));
  validate(document);
  return ajvDiagnostics(validate.errors);
}

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

/** Semantic checks that cannot be expressed as static JSON Schema:
 * placeholder-token validation and cross-field references (e.g.
 * `defaults.harness` naming a configured harness). Structural shape,
 * required fields, and types are validated separately via Ajv against
 * the schema document shared with `ralph schema show`. */
function semanticDiagnostics(
  document: V1WorkflowDocument,
  extensions: ExtensionRegistry,
): Diagnostic[] {
  const d: Diagnostic[] = [];
  const collectCommandPlaceholders = (path: string, value: unknown) => {
    if (!value || typeof value !== "object") return;
    const c = value as CommandDto;
    if (
      c.timeout !== undefined &&
      (!string(c.timeout) || parseTimeout(c.timeout) <= 0)
    )
      d.push({
        path: `${path}.timeout`,
        message: "must be greater than zero",
      });
    if (c.result?.path !== undefined && string(c.result.path))
      placeholders(`${path}.result.path`, [c.result.path], d);
    if (c.result?.required === true && !string(c.result?.path))
      d.push({
        path: `${path}.result.path`,
        message: "is required when result.required is true",
      });
    placeholders(
      `${path}.arguments`,
      Array.isArray(c.arguments) ? c.arguments : [],
      d,
    );
    for (const [i, g] of (Array.isArray(c.conditionalArguments)
      ? c.conditionalArguments
      : []
    ).entries()) {
      const x = g as { arguments?: unknown };
      placeholders(
        `${path}.conditionalArguments[${i}].arguments`,
        Array.isArray(x.arguments) ? x.arguments : [],
        d,
      );
    }
    for (const [i, e] of (Array.isArray(c.environment)
      ? c.environment
      : []
    ).entries()) {
      const value =
        typeof e === "string"
          ? parseEnvAssignment(e)?.value
          : (e as { value?: unknown }).value;
      if (string(value))
        placeholders(`${path}.environment[${i}].value`, [value], d);
    }
  };

  for (const [i, e] of (document.environment ?? []).entries()) {
    const value =
      typeof e === "string"
        ? parseEnvAssignment(e)?.value
        : (e as { value?: unknown })?.value;
    if (string(value)) placeholders(`environment[${i}].value`, [value], d);
  }

  for (const [name, c] of Object.entries(document.harnesses ?? {}))
    collectCommandPlaceholders(`harnesses.${name}`, c);
  for (const [key, list] of [
    ["preAgent", document.preAgent],
    ["postAgent", document.postAgent],
  ] as const)
    for (const [i, c] of (list ?? []).entries())
      collectCommandPlaceholders(`${key}[${i}]`, c);

  const defs = document.defaults;
  if (
    defs &&
    typeof defs === "object" &&
    string(defs.harness) &&
    document.harnesses &&
    typeof document.harnesses === "object" &&
    !Object.keys(document.harnesses).some(
      (x) => x.toLowerCase() === defs.harness?.toString().toLowerCase(),
    )
  )
    d.push({
      path: "defaults.harness",
      message: "must name configured harness",
    });

  const cont = document.continuation;
  if (cont && typeof cont === "object") {
    if (cont.kind === "generatedGoal" && typeof cont.producer === "string") {
      const producer = cont.producer.trim();
      if (producer && !extensions.producer(producer))
        d.push({
          path: "continuation.producer",
          message: `unknown producer '${cont.producer}'`,
        });
    } else if (cont.kind === "generatedGoal" && cont.producer) {
      collectCommandPlaceholders(
        "continuation.producer",
        cont.producer as CommandDto,
      );
    }
    if (string(cont.nextTask))
      placeholders("continuation.nextTask", [cont.nextTask], d);
  }

  if (defs && typeof defs === "object" && string(defs.statusFormat))
    placeholders("defaults.statusFormat", [defs.statusFormat], d);

  return d;
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
  const structural = validateWorkflowSchema(document, extensions);
  const semantic = semanticDiagnostics(document, extensions);
  return [...structural, ...semantic];
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
