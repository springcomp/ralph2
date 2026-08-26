export interface ExtensionProperty {
  name: string;
  description: string;
  required?: boolean;
  type?: string;
}

interface ExtensionDocumentation {
  name: string;
  description: string;
  properties: readonly ExtensionProperty[];
}

export interface ActionRegistration extends ExtensionDocumentation {
  callback: import("./types.js").ActionCallback;
}

export interface PredicateRegistration extends ExtensionDocumentation {
  callback: import("./types.js").PredicateCallback;
}

export interface TriggerRegistration extends ExtensionDocumentation {
  callback: import("./types.js").TriggerCallback;
}

export interface CircuitBreakerRegistration extends ExtensionDocumentation {
  callback: import("./types.js").CircuitBreakerCallback;
}

export type ExtensionRegistration = ActionRegistration | PredicateRegistration;

export interface TemplateRegistration {
  name: string;
  files: ReadonlyMap<string, string>;
  actions?: readonly ActionRegistration[];
  predicates?: readonly PredicateRegistration[];
  producers?: readonly ProducerRegistration[];
  triggers?: readonly TriggerRegistration[];
  circuitBreakers?: readonly CircuitBreakerRegistration[];
  continuationLowerings?: readonly ContinuationLowering[];
  triggerLowerings?: readonly TriggerLowering[];
  circuitBreakerLowerings?: readonly CircuitBreakerLowering[];
}

export interface ProducerRegistration {
  name: string;
  create(): import("../config/schema-v1.js").CommandDto;
}

export interface ExtensionRegistry {
  actions: readonly ActionRegistration[];
  predicates: readonly PredicateRegistration[];
  templates: readonly TemplateRegistration[];
  producers: readonly ProducerRegistration[];
  triggers: readonly TriggerRegistration[];
  circuitBreakers: readonly CircuitBreakerRegistration[];
  continuationLowerings: readonly ContinuationLowering[];
  triggerLowerings: readonly TriggerLowering[];
  circuitBreakerLowerings: readonly CircuitBreakerLowering[];
  action(name: string): ActionRegistration | undefined;
  predicate(name: string): PredicateRegistration | undefined;
  template(name: string): TemplateRegistration | undefined;
  producer(name: string): ProducerRegistration | undefined;
  trigger(name: string): TriggerRegistration | undefined;
  circuitBreaker(name: string): CircuitBreakerRegistration | undefined;
  continuationLowering(name: string): ContinuationLowering | undefined;
  triggerLowering(name: string): TriggerLowering | undefined;
  circuitBreakerLowering(name: string): CircuitBreakerLowering | undefined;
}

import { TriggerWorkSource } from "../config/lowering/worksource.js";
import type { CoreContext, Guard } from "../core/plan.js";
import { scheduleTaskAction } from "./actions/schedule-task.js";
import { noProgressCircuitBreaker } from "./circuit-breakers/no-progress.js";
import { repeatedFailureSignatureCircuitBreaker } from "./circuit-breakers/repeated-failure-signature.js";
import { acceptedExitCodePredicate } from "./predicates/accepted-exit-code.js";
import { fileExistsPredicate } from "./predicates/file-exists.js";
import { fileMissingPredicate } from "./predicates/file-missing.js";
import { blueprintTemplateRegistration } from "./templates/blueprint/index.js";
import { goalTemplateRegistration } from "./templates/goal.js";
import type {
  CircuitBreakerLowering,
  ContinuationLowering,
  TriggerLowering,
} from "./types.js";

const actions: readonly ActionRegistration[] = [scheduleTaskAction];

const predicates: readonly PredicateRegistration[] = [
  fileExistsPredicate,
  fileMissingPredicate,
  acceptedExitCodePredicate,
];

const builtinTemplates: readonly TemplateRegistration[] = [
  goalTemplateRegistration,
  blueprintTemplateRegistration,
];

const builtinCircuitBreakers: readonly CircuitBreakerRegistration[] = [
  noProgressCircuitBreaker,
  repeatedFailureSignatureCircuitBreaker,
];

const continuationLowerings: readonly ContinuationLowering[] = [];

const triggerLowerings: readonly TriggerLowering[] = [
  {
    name: "taskAppears",
    lower: (dto, ctx) =>
      new TriggerWorkSource(
        ctx.inner,
        dto,
        ctx.source,
        ctx.plan,
        ctx.extensions,
      ),
  },
];

const circuitBreakerLowerings: readonly CircuitBreakerLowering[] = [
  {
    name: "noProgress",
    lower: (dto, ctx) => breakerGuard(dto, ctx),
  },
  {
    name: "repeatedFailureSignature",
    lower: (dto, ctx) => breakerGuard(dto, ctx),
  },
];

function breakerGuard(
  check: import("../config/compiler.js").CircuitBreakerCheckPlan,
  ctx: import("./types.js").CircuitBreakerLoweringContext,
): Guard {
  const registration = ctx.extensions.circuitBreaker(check.kind);
  return {
    kind: check.kind,
    threshold: check.threshold,
    signature: (core: CoreContext) => {
      if (!registration)
        throw new Error(
          `Circuit breaker check '${check.kind}' is not registered.`,
        );
      return registration.callback({
        kind: check.kind,
        workspace: ctx.plan.workspace,
        iteration: core.iteration,
        lastFailure: core.lastFailure as
          | { stage: string; exitCode: number | null }
          | undefined,
        expand: (value: string) => ctx.expander.expand(value, ctx.values(core)),
      });
    },
  };
}

function find<T extends { name: string }>(
  registrations: readonly T[],
  name: string,
): T | undefined {
  return registrations.find(
    (registration) => registration.name.toLowerCase() === name.toLowerCase(),
  );
}

export function createExtensionRegistry(
  extra: {
    actions?: readonly ActionRegistration[];
    predicates?: readonly PredicateRegistration[];
    templates?: readonly TemplateRegistration[];
    producers?: readonly ProducerRegistration[];
    triggers?: readonly TriggerRegistration[];
    circuitBreakers?: readonly CircuitBreakerRegistration[];
    continuationLowerings?: readonly ContinuationLowering[];
    triggerLowerings?: readonly TriggerLowering[];
    circuitBreakerLowerings?: readonly CircuitBreakerLowering[];
  } = {},
): ExtensionRegistry {
  const registeredTemplates = [...builtinTemplates, ...(extra.templates ?? [])];
  const registeredActions = [
    ...actions,
    ...registeredTemplates.flatMap((t) => t.actions ?? []),
    ...(extra.actions ?? []),
  ];
  const registeredPredicates = [
    ...predicates,
    ...registeredTemplates.flatMap((t) => t.predicates ?? []),
    ...(extra.predicates ?? []),
  ];
  const registeredProducers = [
    ...registeredTemplates.flatMap((t) => t.producers ?? []),
    ...(extra.producers ?? []),
  ];
  const registeredTriggers = [
    ...registeredTemplates.flatMap((t) => t.triggers ?? []),
    ...(extra.triggers ?? []),
  ];
  const registeredCircuitBreakers = [
    ...builtinCircuitBreakers,
    ...registeredTemplates.flatMap((t) => t.circuitBreakers ?? []),
    ...(extra.circuitBreakers ?? []),
  ];
  const assertUnique = (
    kind: string,
    registrations: readonly { name: string }[],
  ) => {
    const names = new Set<string>();
    for (const registration of registrations) {
      const key = registration.name.toLowerCase();
      if (!registration.name.trim())
        throw new Error(`${kind} name is required.`);
      if (names.has(key))
        throw new Error(`Duplicate ${kind}: ${registration.name}`);
      names.add(key);
    }
  };
  assertUnique("action", registeredActions);
  assertUnique("predicate", registeredPredicates);
  assertUnique("template", registeredTemplates);
  assertUnique("producer", registeredProducers);
  assertUnique("trigger", registeredTriggers);
  assertUnique("circuitBreaker", registeredCircuitBreakers);
  const registeredContinuationLowerings = [
    ...continuationLowerings,
    ...registeredTemplates.flatMap((t) => t.continuationLowerings ?? []),
    ...(extra.continuationLowerings ?? []),
  ];
  const templateTriggers = registeredTemplates.flatMap((t) => t.triggers ?? []);
  const templateCircuitBreakers = registeredTemplates.flatMap(
    (t) => t.circuitBreakers ?? [],
  );
  const registeredTriggerLowerings = [
    ...triggerLowerings,
    ...registeredTemplates.flatMap((t) => t.triggerLowerings ?? []),
    ...[...(extra.triggers ?? []), ...templateTriggers]
      .filter(
        (trigger) =>
          !triggerLowerings.some(
            (lowering) =>
              lowering.name.toLowerCase() === trigger.name.toLowerCase(),
          ),
      )
      .map((trigger) => ({
        name: trigger.name,
        lower: (
          dto: import("../config/compiler.js").TriggerPlan,
          context: import("./types.js").TriggerLoweringContext,
        ) =>
          new TriggerWorkSource(
            context.inner,
            dto,
            context.source,
            context.plan,
            context.extensions,
          ),
      })),
    ...(extra.triggerLowerings ?? []),
  ];
  const registeredCircuitBreakerLowerings = [
    ...circuitBreakerLowerings,
    ...registeredTemplates.flatMap((t) => t.circuitBreakerLowerings ?? []),
    ...[...(extra.circuitBreakers ?? []), ...templateCircuitBreakers]
      .filter(
        (breaker) =>
          !circuitBreakerLowerings.some(
            (lowering) =>
              lowering.name.toLowerCase() === breaker.name.toLowerCase(),
          ),
      )
      .map((breaker) => ({
        name: breaker.name,
        lower: (
          dto: import("../config/compiler.js").CircuitBreakerCheckPlan,
          context: import("./types.js").CircuitBreakerLoweringContext,
        ) => breakerGuard(dto, context),
      })),
    ...(extra.circuitBreakerLowerings ?? []),
  ];
  return {
    actions: registeredActions,
    predicates: registeredPredicates,
    templates: registeredTemplates,
    producers: registeredProducers,
    triggers: registeredTriggers,
    circuitBreakers: registeredCircuitBreakers,
    continuationLowerings: registeredContinuationLowerings,
    triggerLowerings: registeredTriggerLowerings,
    circuitBreakerLowerings: registeredCircuitBreakerLowerings,
    action: (name) => find(registeredActions, name),
    predicate: (name) => find(registeredPredicates, name),
    template: (name) => find(registeredTemplates, name),
    producer: (name) => find(registeredProducers, name),
    trigger: (name) => find(registeredTriggers, name),
    circuitBreaker: (name) => find(registeredCircuitBreakers, name),
    continuationLowering: (name) => find(registeredContinuationLowerings, name),
    triggerLowering: (name) => find(registeredTriggerLowerings, name),
    circuitBreakerLowering: (name) =>
      find(registeredCircuitBreakerLowerings, name),
  };
}

export const defaultExtensionRegistry = createExtensionRegistry();
