import { stringify } from "yaml";
import type { ExtensionRegistry } from "../extensions/registry.js";
import { PlaceholderRegistry } from "../placeholders/placeholders.js";

export interface JsonSchema {
  [key: string]: unknown;
}

export function workflowSchema(registry: ExtensionRegistry): JsonSchema {
  const environmentItem = {
    oneOf: [
      {
        type: "object",
        required: ["name", "value"],
        properties: {
          name: { type: "string", minLength: 1 },
          value: { type: "string" },
          secret: { type: "boolean" },
        },
      },
      {
        type: "string",
        pattern: "^[A-Za-z_][A-Za-z0-9_]*=.*$",
      },
    ],
  };
  const extensionNames = (
    kind: "actions" | "predicates" | "triggers" | "circuitBreakers" | "messages",
  ) => registry[kind].map((registration) => registration.name);
  const command: JsonSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      executable: { type: "string", minLength: 1 },
      arguments: { type: "array", items: { type: "string" } },
      conditionalArguments: {
        type: "array",
        items: {
          type: "object",
          required: ["whenSet"],
          properties: {
            whenSet: { enum: [...PlaceholderRegistry.conditionalNames] },
            arguments: { type: "array", items: { type: "string" } },
          },
        },
      },
      environment: {
        type: "array",
        items: environmentItem,
      },
      envFile: { type: "string", minLength: 1 },
      failurePolicy: { enum: ["stop", "continue"] },
      timeout: { type: ["string", "number"] },
      successExitCodes: { type: "array", items: { type: "number" } },
      output: { type: "object" },
      pty: { type: "boolean" },
      mandatory: { type: "boolean" },
      result: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          required: { type: "boolean" },
        },
      },
      onFailure: {
        type: "object",
        required: ["action", "task"],
        properties: {
          action: { enum: extensionNames("actions") },
          task: { type: "string", minLength: 1 },
        },
      },
      onSuccess: {
        type: "object",
        required: ["message", "target", "task"],
        properties: {
          message: { enum: extensionNames("messages") },
          target: { type: "string", minLength: 1 },
          task: { type: "string", minLength: 1 },
        },
      },
    },
    required: ["executable"],
  };

  const producerSchema: JsonSchema =
    registry.producers.length > 0
      ? {
          oneOf: [
            {
              type: "string",
              minLength: 1,
              enum: registry.producers.map((p) => p.name),
            },
            { $ref: "#/$defs/command" },
          ],
        }
      : { $ref: "#/$defs/command" };

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Ralph workflow configuration",
    type: "object",
    required: [
      "schemaVersion",
      "workspace",
      "maxIterations",
      "tasks",
      "defaults",
      "harnesses",
    ],
    properties: {
      schemaVersion: { const: 1 },
      workspace: { type: "string", minLength: 1 },
      envFile: { type: "string", minLength: 1 },
      environment: { type: "array", items: environmentItem },
      maxIterations: { type: "number", exclusiveMinimum: 0 },
      goal: { type: "string", minLength: 1 },
      maxRemediationAttempts: {
        type: "number",
        minimum: 0,
        multipleOf: 1,
      },
      tasks: {
        type: "object",
        required: ["progress", "prompt"],
        anyOf: [{ required: ["queue"] }, { required: ["prd"] }],
        properties: {
          format: { type: "string" },
          queue: { type: "string", minLength: 1 },
          prd: { type: "string", minLength: 1 },
          progress: { type: "string", minLength: 1 },
          prompt: { type: "string", minLength: 1 },
          completion: { enum: ["agent", "engine"] },
          metadata: { type: "object" },
        },
      },
      defaults: {
        type: "object",
        required: ["harness"],
        properties: {
          harness: { type: "string", minLength: 1 },
          model: { type: ["string", "null"] },
          agent: { type: ["string", "null"] },
          statusFormat: { type: "string" },
        },
      },
      harnesses: {
        type: "object",
        minProperties: 1,
        additionalProperties: { $ref: "#/$defs/command" },
      },
      preAgent: { type: "array", items: { $ref: "#/$defs/command" } },
      postAgent: { type: "array", items: { $ref: "#/$defs/command" } },
      verification: {
        type: "object",
        properties: {
          requireTaskChecked: { type: "boolean" },
          retries: { type: "number" },
          prompt: { type: "string" },
        },
      },
      continuation: {
        type: "object",
        properties: {
          kind: {
            enum: registry.continuationLowerings.map(
              (lowering) => lowering.name,
            ),
          },
        },
        allOf: registry.continuationLowerings
          .map((lowering) => {
            const properties: Record<string, JsonSchema> = {
              ...(lowering.schema?.properties ?? {}),
              ...(lowering.schema?.usesProducer
                ? { producer: producerSchema }
                : {}),
            };
            if (
              !Object.keys(properties).length &&
              !lowering.schema?.required?.length
            )
              return null;
            const entry: JsonSchema = {
              if: { properties: { kind: { const: lowering.name } } },
            };
            const thenSchema: JsonSchema = {};
            if (Object.keys(properties).length)
              thenSchema.properties = properties;
            if (lowering.schema?.required?.length)
              thenSchema.required = lowering.schema?.required;
            // biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then keyword, not a thenable
            entry.then = thenSchema;
            return entry;
          })
          .filter((entry): entry is JsonSchema => entry !== null),
      },
      trigger: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { enum: extensionNames("triggers") },
          source: { type: "string", minLength: 1 },
          pollInterval: { type: ["string", "number"] },
        },
      },
      circuitBreaker: {
        type: "object",
        properties: {
          checks: {
            type: "array",
            items: {
              type: "object",
              required: ["kind"],
              properties: {
                kind: { enum: extensionNames("circuitBreakers") },
                threshold: { type: "number", exclusiveMinimum: 0 },
              },
            },
          },
        },
      },
    },
    $defs: {
      command,
      placeholders: { enum: [...PlaceholderRegistry.names] },
      actions: { enum: extensionNames("actions") },
      predicates: { enum: extensionNames("predicates") },
      messages: { enum: extensionNames("messages") },
    },
  };
}

export function workflowSchemaYaml(registry: ExtensionRegistry): string {
  return stringify(workflowSchema(registry));
}
