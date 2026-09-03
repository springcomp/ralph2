import { pathToFileURL } from "node:url";
import { MarkdownTaskSource } from "../task-source/markdown-task-source.js";

interface StuntOptions {
  readonly queue: string;
  readonly check: boolean;
}

function parseArgs(argv: readonly string[]): StuntOptions {
  let queue: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--queue") queue = argv[++i];
    else if (argv[i] === "--check") check = true;
  }
  if (!queue) throw new Error("stunt: --queue <path> is required");
  return { queue, check };
}

/** Stand-in AI harness: finds the current task and optionally checks it off, like a real agent would. */
export async function runStunt(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const source = new MarkdownTaskSource(options.queue);
  const task = await source.getFirstUncheckedTask();
  if (!task) {
    console.log("stunt: no unchecked task found");
    return 0;
  }
  if (options.check) {
    await source.checkTask(task);
    console.log(`stunt: completed ${task.id} (checked)`);
  } else {
    console.log(`stunt: completed ${task.id} (left unchecked)`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runStunt(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
