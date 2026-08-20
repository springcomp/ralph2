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

export interface ExtensionRegistry {
  actions: readonly ActionRegistration[];
  predicates: readonly PredicateRegistration[];
  action(name: string): ActionRegistration | undefined;
  predicate(name: string): PredicateRegistration | undefined;
}

import { scheduleTaskAction } from "./actions/schedule-task.js";
import { acceptedExitCodePredicate } from "./predicates/accepted-exit-code.js";
import { fileExistsPredicate } from "./predicates/file-exists.js";
import { fileMissingPredicate } from "./predicates/file-missing.js";

const actions: readonly ActionRegistration[] = [scheduleTaskAction];

const predicates: readonly PredicateRegistration[] = [
  fileExistsPredicate,
  fileMissingPredicate,
  acceptedExitCodePredicate,
];

function find<T extends ExtensionRegistration>(
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
  } = {},
): ExtensionRegistry {
  const registeredActions = [...actions, ...(extra.actions ?? [])];
  const registeredPredicates = [...predicates, ...(extra.predicates ?? [])];
  const assertUnique = (
    kind: string,
    registrations: readonly ExtensionRegistration[],
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
  return {
    actions: registeredActions,
    predicates: registeredPredicates,
    action: (name) => find(registeredActions, name),
    predicate: (name) => find(registeredPredicates, name),
  };
}

export const defaultExtensionRegistry = createExtensionRegistry();
