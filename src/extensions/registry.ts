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

export type ExtensionRegistration = ActionRegistration | PredicateRegistration;

export interface TemplateRegistration {
  name: string;
  files: ReadonlyMap<string, string>;
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
  action(name: string): ActionRegistration | undefined;
  predicate(name: string): PredicateRegistration | undefined;
  template(name: string): TemplateRegistration | undefined;
  producer(name: string): ProducerRegistration | undefined;
}

import { scheduleTaskAction } from "./actions/schedule-task.js";
import { acceptedExitCodePredicate } from "./predicates/accepted-exit-code.js";
import { fileExistsPredicate } from "./predicates/file-exists.js";
import { fileMissingPredicate } from "./predicates/file-missing.js";
import { goalProducerRegistration } from "./producers/goalProducer.js";
import { goalTemplateRegistration } from "./templates/goal.js";

const actions: readonly ActionRegistration[] = [scheduleTaskAction];

const predicates: readonly PredicateRegistration[] = [
  fileExistsPredicate,
  fileMissingPredicate,
  acceptedExitCodePredicate,
];

const builtinTemplates: readonly TemplateRegistration[] = [
  goalTemplateRegistration,
];

const builtinProducers: readonly ProducerRegistration[] = [
  goalProducerRegistration,
];

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
  } = {},
): ExtensionRegistry {
  const registeredActions = [...actions, ...(extra.actions ?? [])];
  const registeredPredicates = [...predicates, ...(extra.predicates ?? [])];
  const registeredTemplates = [...builtinTemplates, ...(extra.templates ?? [])];
  const registeredProducers = [...builtinProducers, ...(extra.producers ?? [])];
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
  return {
    actions: registeredActions,
    predicates: registeredPredicates,
    templates: registeredTemplates,
    producers: registeredProducers,
    action: (name) => find(registeredActions, name),
    predicate: (name) => find(registeredPredicates, name),
    template: (name) => find(registeredTemplates, name),
    producer: (name) => find(registeredProducers, name),
  };
}

export const defaultExtensionRegistry = createExtensionRegistry();
