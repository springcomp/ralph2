import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "./process-runner.js";

export class FakeProcessRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  private readonly results: ProcessResult[];

  constructor(results: readonly ProcessResult[] = []) {
    this.results = [...results];
  }

  enqueue(result: ProcessResult): void {
    this.results.push(result);
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return (
      this.results.shift() ?? {
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
      }
    );
  }
}
