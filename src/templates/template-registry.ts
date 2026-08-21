import { defaultExtensionRegistry } from "../extensions/registry.js";

export type TemplateName = "goal" | "blueprint";
type LegacyTemplate = Record<string, string>;

const legacyTemplate = (name: TemplateName): LegacyTemplate =>
  Object.fromEntries(defaultExtensionRegistry.template(name)?.files ?? []);

export const templates = Object.freeze({
  goal: Object.freeze(legacyTemplate("goal")),
  blueprint: Object.freeze(legacyTemplate("blueprint")),
});

export function getTemplate(
  name: string,
): (typeof templates)[TemplateName] | undefined {
  const key = name.toLowerCase() as TemplateName;
  return key in templates ? templates[key] : undefined;
}