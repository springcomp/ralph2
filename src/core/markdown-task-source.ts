import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StateLock } from "./locks.js";

export interface MarkdownTask {
  readonly typ: string;
  readonly num: string;
  readonly id: string;
  readonly description: string;
  readonly rawLine: string;
  readonly model?: string;
  readonly agent?: string;
  readonly lineIndex: number;
}

export class MarkdownTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownTaskError";
  }
}

interface ParsedLine {
  readonly task: MarkdownTask;
  readonly unchecked: boolean;
}
interface Line {
  text: string;
  newline: string;
}

const taskPattern =
  /^\s*-\s\[(?<state>[ xX])\]\s(?<typ>[A-Za-z][A-Za-z0-9]*)-(?<num>\d\w*)\s-\s(?<task>.*)$/;
const metadataPattern = /\((?<key>model|agent):\s*`?(?<value>[^`)]+)`?\)/gi;

/** Parse one Markdown task line. Non-task Markdown returns null. */
export function parseTaskLine(
  text: string,
  lineIndex = 0,
): MarkdownTask | null {
  const match = taskPattern.exec(text);
  if (!match?.groups) return null;
  const taskText = match.groups.task.trim();
  const metadata = [...taskText.matchAll(metadataPattern)];
  const values = new Map<string, string>();
  for (const item of metadata) {
    const key = item.groups?.key.toLowerCase();
    if (!key) continue;
    if (values.has(key))
      throw new MarkdownTaskError(
        `Task metadata '${key}' is duplicated on line ${lineIndex + 1}.`,
      );
    values.set(key, item.groups?.value.trim() ?? "");
  }
  const description = taskText.replace(metadataPattern, "").trim();
  const typ = match.groups.typ;
  const num = match.groups.num;
  return {
    typ,
    num,
    id: `${typ}-${num}`,
    description,
    rawLine: text,
    ...(values.has("model") ? { model: values.get("model") } : {}),
    ...(values.has("agent") ? { agent: values.get("agent") } : {}),
    lineIndex,
  };
}

function parseDocument(text: string): {
  lines: Line[];
  defaultNewline: string;
} {
  const lines: Line[] = [];
  let start = 0;
  let firstNewline: string | undefined;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\r" && text[i] !== "\n") continue;
    const newline = text[i] === "\r" && text[i + 1] === "\n" ? "\r\n" : text[i];
    if (newline === "\r\n") i++;
    firstNewline ??= newline;
    lines.push({ text: text.slice(start, i + 1 - newline.length), newline });
    start = i + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), newline: "" });
  return { lines, defaultNewline: firstNewline ?? "\n" };
}

function tasks(lines: Line[]): ParsedLine[] {
  return lines.flatMap((line, index) => {
    const task = parseTaskLine(line.text, index);
    return task ? [{ task, unchecked: /\[ \]/.test(line.text) }] : [];
  });
}

function ensureUniqueUnchecked(parsed: ParsedLine[]): void {
  const seen = new Map<string, number>();
  for (const { task, unchecked } of parsed) {
    if (!unchecked) continue;
    const prior = seen.get(task.id.toLowerCase());
    if (prior !== undefined)
      throw new MarkdownTaskError(
        `Task identity '${task.id}' is ambiguous on lines ${prior + 1}, ${task.lineIndex + 1}.`,
      );
    seen.set(task.id.toLowerCase(), task.lineIndex);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function update(
  path: string,
  operation: (lines: Line[]) => boolean,
): Promise<void> {
  const lock = new StateLock(path);
  await lock.withLock(async () => {
    const original = await readFile(path, "utf8").catch(() => "");
    const document = parseDocument(original);
    if (!operation(document.lines)) return;
    await atomicWrite(
      path,
      document.lines.map((line) => line.text + line.newline).join(""),
    );
  });
}

export class MarkdownTaskSource {
  async remediationDepth(
    prdPath: string,
    target: MarkdownTask,
  ): Promise<{ depth: number; rootId: string }> {
    const parsed = tasks(parseDocument(await readFile(prdPath, "utf8")).lines);
    const byId = new Map(
      parsed.map(({ task }) => [task.id.toLowerCase(), task]),
    );
    const parentPattern = /\(parent:\s*([A-Za-z][A-Za-z0-9]*-\d\w*)\)/gi;
    const visited = new Set<string>();
    let current = target;
    let depth = 0;
    while (true) {
      const key = current.id.toLowerCase();
      if (visited.has(key))
        throw new MarkdownTaskError(
          `Remediation parent cycle detected at task '${current.id}'.`,
        );
      visited.add(key);
      // The immediate parent is the last (most recently appended) tag: a
      // description can carry inherited ancestor tags too.
      const matches = [...current.description.matchAll(parentPattern)];
      const parentId = matches.at(-1)?.[1];
      if (!parentId) return { depth, rootId: current.id };
      const parent = byId.get(parentId.toLowerCase());
      if (!parent)
        throw new MarkdownTaskError(
          `Remediation parent '${parentId}' for task '${current.id}' no longer exists.`,
        );
      current = parent;
      depth++;
    }
  }

  async isTaskUnchecked(
    prdPath: string,
    target: MarkdownTask,
  ): Promise<boolean> {
    const parsed = tasks(parseDocument(await readFile(prdPath, "utf8")).lines);
    ensureUniqueUnchecked(parsed);
    const candidates = parsed.filter(
      ({ task }) => task.id.toLowerCase() === target.id.toLowerCase(),
    );
    const normalized = (line: string) => line.replace(/\[[ xX]\]/, "[ ]");
    const exact = candidates.find(
      ({ task }) => normalized(task.rawLine) === normalized(target.rawLine),
    );
    if (exact) return exact.unchecked;
    if (candidates.some(({ unchecked }) => !unchecked)) return false;
    if (candidates.length)
      throw new MarkdownTaskError(`Task '${target.id}' no longer matches.`);
    throw new MarkdownTaskError(`Task '${target.id}' no longer exists.`);
  }

  async getFirstUncheckedTask(prdPath: string): Promise<MarkdownTask | null> {
    const parsed = tasks(parseDocument(await readFile(prdPath, "utf8")).lines);
    ensureUniqueUnchecked(parsed);
    return parsed.find(({ unchecked }) => unchecked)?.task ?? null;
  }

  async checkTask(prdPath: string, task: MarkdownTask): Promise<void> {
    await update(prdPath, (lines) => {
      const index = lines.findIndex((line) => line.text === task.rawLine);
      if (index < 0)
        throw new MarkdownTaskError(`Task '${task.id}' no longer exists.`);
      const parsed = parseTaskLine(lines[index].text, index);
      if (!parsed || parsed.id !== task.id)
        throw new MarkdownTaskError(`Task '${task.id}' no longer matches.`);
      lines[index].text = lines[index].text
        .replace("[ ]", "[x]")
        .replace("[X]", "[x]");
      return true;
    });
  }

  async scheduleTask(prdPath: string, taskLine: string): Promise<void> {
    const generated = parseTaskLine(taskLine);
    if (!generated || !taskLine.includes("[ ]"))
      throw new MarkdownTaskError(
        "Generated task is not a valid unchecked Markdown task.",
      );
    await update(prdPath, (lines) => {
      const parsed = tasks(lines);
      ensureUniqueUnchecked(parsed);
      const duplicate = parsed.find(
        ({ task, unchecked }) =>
          unchecked && task.id.toLowerCase() === generated.id.toLowerCase(),
      );
      if (duplicate) lines.splice(duplicate.task.lineIndex, 1);
      const refreshed = tasks(lines);
      const first =
        refreshed.find(({ unchecked }) => unchecked)?.task.lineIndex ??
        lines.length;
      let newline = "\n";
      if (lines[first - 1]?.newline) newline = lines[first - 1].newline;
      const lastLine = lines.at(-1);
      if (first === lines.length && lastLine?.newline === "") {
        lastLine.newline = newline;
      }
      lines.splice(first, 0, {
        text: taskLine,
        newline: first < lines.length ? newline : "",
      });
      ensureUniqueUnchecked(tasks(lines));
      return true;
    });
  }

  async seedBlueprintTask(
    prdPath: string,
    blueprintPath: string,
  ): Promise<string | null> {
    if (!(await exists(blueprintPath))) return null;
    const paths = [resolve(blueprintPath), resolve(prdPath)].sort((a, b) =>
      a.localeCompare(b),
    );
    const first = new StateLock(paths[0]);
    const second = paths[1] === paths[0] ? undefined : new StateLock(paths[1]);
    await first.acquire();
    if (second) await second.acquire();
    try {
      const source = parseDocument(await readFile(blueprintPath, "utf8"));
      const sourceTasks = tasks(source.lines);
      ensureUniqueUnchecked(sourceTasks);
      const selected = sourceTasks.find(({ unchecked }) => unchecked);
      if (!selected) return null;
      const prd = parseDocument(
        await readFile(prdPath, "utf8").catch(() => ""),
      );
      const lastLine = prd.lines.at(-1);
      if (lastLine && lastLine.newline === "")
        lastLine.newline = prd.defaultNewline;
      prd.lines.push({ text: selected.task.rawLine, newline: "" });
      source.lines[selected.task.lineIndex].text = source.lines[
        selected.task.lineIndex
      ].text.replace("[ ]", "[x]");
      ensureUniqueUnchecked(tasks(prd.lines));
      await atomicWrite(
        blueprintPath,
        source.lines.map((l) => l.text + l.newline).join(""),
      );
      await atomicWrite(
        prdPath,
        prd.lines.map((l) => l.text + l.newline).join(""),
      );
      return selected.task.rawLine;
    } finally {
      await second?.release();
      await first.release();
    }
  }
}
