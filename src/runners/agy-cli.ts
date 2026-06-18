import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WorkflowInputError } from "../errors.js";
import type { WorkflowAgentCall, WorkflowAgentMeta, WorkflowAgentRunner } from "../types.js";
import { buildSubagentPrompt } from "./prompt.js";
import { agentTimeoutError, DEFAULT_AGENT_TIMEOUT_MS, startAgentTimeout } from "./turn-control.js";
import { createDetachedWorktree } from "./worktree.js";

const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;

export interface AgyCliAgentRunnerOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  model?: string;
  baseInstructions?: string;
  agentTimeoutMs?: number;
}

export class AgyCliAgentRunner implements WorkflowAgentRunner {
  constructor(private readonly options: AgyCliAgentRunnerOptions = {}) {}

  async run(
    call: WorkflowAgentCall,
    signal?: AbortSignal,
    onMeta?: (meta: WorkflowAgentMeta) => void,
  ): Promise<unknown> {
    const baseCwd = this.options.cwd ?? process.cwd();
    const worktree = call.options.isolation === "worktree" ? await createDetachedWorktree(baseCwd) : undefined;
    const workingDirectory = worktree?.dir ?? baseCwd;
    const prompt = buildSubagentPrompt(call, {
      baseInstructions: this.options.baseInstructions,
      backendName: "agy",
      inWorktree: Boolean(worktree),
      embedSchema: true,
    });

    const timeoutMs = this.options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const timeout = startAgentTimeout(timeoutMs, signal);

    onMeta?.({ backend: "agy" });

    try {
      const result = await runAgyProcess(
        buildAgyArgs(prompt, this.options.model, this.options),
        {
          command: this.options.command ?? "agy",
          cwd: workingDirectory,
          signal: timeout.signal,
          timedOut: timeout.timedOut,
          timeoutMs,
        },
      );
      return result.response;
    } finally {
      timeout.clear();
      if (worktree) await worktree.cleanup(onMeta);
    }
  }
}

function buildAgyArgs(
  prompt: string,
  model: string | undefined,
  options: AgyCliAgentRunnerOptions,
): string[] {
  const args = [...(options.args ?? [])];
  if (model !== undefined) args.push("--model", model);
  args.push("-p", prompt);
  return args;
}

async function runAgyProcess(
  args: string[],
  options: {
    command: string;
    cwd: string;
    signal: AbortSignal | undefined;
    timedOut: () => boolean;
    timeoutMs: number;
  },
): Promise<{ response: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const settle = (error: unknown, value?: { response: string }) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value ?? { response: "" });
    };

    const abort = () => {
      child.kill("SIGTERM");
      settle(options.timedOut() ? agentTimeoutError(options.timeoutMs) : new Error("agent aborted"));
    };

    const overflow = (stream: string, limit: number) => {
      child.kill("SIGTERM");
      settle(new Error(`agy ${stream} exceeded ${limit} bytes — aborting to avoid unbounded buffering`));
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return overflow("stdout", MAX_STDOUT_BYTES);
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) return overflow("stderr", MAX_STDERR_BYTES);
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => settle(normalizeAgySpawnError(error, options.command)));
    child.on("exit", (code, signal) => {
      if (settled) return;
      
      const text = stdout.trim();
      if (code === 0 && text) {
        settle(undefined, { response: text });
        return;
      }

      const detail = cleanErrorText(stderr) || text || `exit code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}`;
      settle(new Error(`agy failed: ${detail}`));
    });
  });
}

function cleanErrorText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("at ") && !line.startsWith("file://"))
    .join("\n")
    .slice(0, 2000);
}

function normalizeAgySpawnError(error: Error, command: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new WorkflowInputError(
      `agy not found at "${command}". Install agy, add it to PATH, or pass --agy-command <path>.`,
    );
  }
  return error;
}
