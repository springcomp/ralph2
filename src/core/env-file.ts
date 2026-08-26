import { readTextFile } from "./file-io.js";

export function parseEnvAssignment(
  entry: string,
): { name: string; value: string } | undefined {
  const equals = entry.indexOf("=");
  if (equals < 1) return undefined;
  const name = entry.slice(0, equals).trim();
  if (!name) return undefined;
  let value = entry.slice(equals + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  )
    value = value.slice(1, -1);
  return { name, value };
}

export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const assignment = parseEnvAssignment(trimmed);
    if (assignment) values[assignment.name] = assignment.value;
  }
  return values;
}

export async function loadEnvFile(
  path: string,
): Promise<Record<string, string>> {
  return parseEnvFile(await readTextFile(path));
}
