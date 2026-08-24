import { stringify } from "yaml";
import { PlaceholderRegistry } from "../core/placeholders.js";
import type { ExtensionRegistry } from "../extensions/registry.js";

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
  const extensionNames = (kind: "actions" | "predicates") =>
    registry[kind].map((registration) => registration.name);
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
    },
    required: ["executable"],
  };

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
      tasks: {
        type: "object",
        required: ["prd", "progress", "prompt"],
        properties: {
          format: { type: "string" },
          prd: { type: "string", minLength: 1 },
          progress: { type: "string", minLength: 1 },
          prompt: { type: "string", minLength: 1 },
          completionSignal: { type: "string" },
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
          kind: { enum: ["blueprint", "generatedGoal"] },
          source: { type: "string", minLength: 1 },
          seedPrdFromSource: { type: "boolean" },
          completeWhenSourceExhausted: { type: "boolean" },
          producer:
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
              : { $ref: "#/$defs/command" },
          completeWhen: {
            type: "object",
            properties: {
              kind: { type: "string", minLength: 1 },
              path: { type: "string" },
              check: { $ref: "#/$defs/command" },
            },
          },
          nextTask: { type: "string", minLength: 1 },
        },
        allOf: [
          {
            if: { properties: { kind: { const: "blueprint" } } },
            then: { required: ["source"] },
          },
          {
            if: { properties: { kind: { const: "generatedGoal" } } },
            then: { required: ["producer", "completeWhen", "nextTask"] },
          },
        ],
      },
    },
    $defs: {
      command,
      placeholders: { enum: [...PlaceholderRegistry.names] },
      actions: { enum: extensionNames("actions") },
      predicates: { enum: extensionNames("predicates") },
    },
  };
}

export function workflowSchemaYaml(registry: ExtensionRegistry): string {
  return stringify(workflowSchema(registry));
}
