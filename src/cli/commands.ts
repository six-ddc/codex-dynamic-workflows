import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodexSdkAgentRunner, type CodexSdkAgentRunnerOptions } from "../runners/codex-sdk.js";
import { GeminiCliAgentRunner, type GeminiCliAgentRunnerOptions } from "../runners/gemini-cli.js";
import { PiCliAgentRunner, type PiCliAgentRunnerOptions } from "../runners/pi-cli.js";
import { AgyCliAgentRunner, type AgyCliAgentRunnerOptions } from "../runners/agy-cli.js";
import type { SandboxMode, ThreadOptions } from "@openai/codex-sdk";
import { defaultWorkflowDirs, WorkflowController } from "../controller.js";
import { WorkflowAbortError, WorkflowInputError } from "../errors.js";
import { parseWorkflowScript } from "../parser.js";
import { FileRunStore, type RunnerConfig, type RunRecord } from "../run-store.js";
import { acquireRunLock, type RunLock } from "../run-lock.js";
import type { WorkflowAgentCall, WorkflowAgentMeta, WorkflowAgentRunner, WorkflowProgressEvent } from "../types.js";
import { WorkflowRegistry, type WorkflowInput } from "../workflow-tool.js";
import { ProgressRenderer, type ProgressMode } from "./progress.js";
import { createWebServer, type WorkflowWebServer } from "../web/server.js";
import { RunEventLog, runEventsPath } from "../web/event-log.js";
import { openBrowser, pickPort } from "../web/launcher.js";
import { workflowDataDir, runsDir, journalDir, piHomeDir, piSessionsDir } from "../paths.js";

const exec = promisify(execFile);

export interface RunFlags {
  args?: string;
  backend?: string;
  model?: string;
  concurrency?: string;
  budget?: string;
  "max-agents"?: string;
  "agent-retries"?: string;
  "agent-timeout"?: string;
  cwd?: string;
  sandbox?: string;
  approval?: string;
  reasoning?: string;
  reasoningEffort?: string;
  bun?: string;
  "gemini-command"?: string;
  "pi-command"?: string;
  "agy-command"?: string;
  provider?: string;
  "base-url"?: string;
  "api-key"?: string;
  "pi-api"?: string;
  thinking?: string;
  tools?: string;
  "exclude-tools"?: string;
  "no-tools"?: boolean;
  "idle-timeout"?: string;
  json?: boolean;
  quiet?: boolean;
  "no-progress"?: boolean;
  port?: string;
  open?: boolean;
  "no-open"?: boolean;
  "no-web"?: boolean;
}

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_MODES = ["never", "on-request", "on-failure", "untrusted"];
const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const AGENT_BACKENDS = ["codex", "gemini", "pi", "agy"] as const;
type AgentBackend = (typeof AGENT_BACKENDS)[number];
const PI_API_SHAPES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

/** `codex-workflow run <file>` */
export async function runCommand(target: string | undefined, flags: RunFlags): Promise<number> {
  if (!target) {
    process.stderr.write("error: `run` requires a workflow file path or registered name\n");
    return 2;
  }

  const cwd = path.resolve(flags.cwd ?? process.cwd());
  let input: WorkflowInput;
  try {
    input = await buildRunInput(target, cwd, flags);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return executeRun(input, `wf_${randomId()}`, cwd, flags);
}

/**
 * `codex-workflow resume <runId>` — re-run a recorded run, reusing its journal cache. Reconstructs the
 * workflow input (script path / registered name + the original `args`) straight from the saved run record,
 * so the user need not re-type the file path or `--args`. CLI flags (`--args`, `--model`, …) still override.
 */
export async function resumeCommand(runId: string | undefined, flags: RunFlags): Promise<number> {
  if (!runId) {
    process.stderr.write("error: `resume` requires a runId\n");
    return 2;
  }
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  const record = await new FileRunStore(runsDir(workflowDataDir())).get(runId);
  if (!record) {
    process.stderr.write(`error: run ${runId} not found (see \`codex-workflow runs\`)\n`);
    return 1;
  }

  let input: WorkflowInput;
  if (record.source === "named") {
    input = { name: record.name };
  } else if (record.scriptPath) {
    input = { scriptPath: record.scriptPath };
  } else {
    process.stderr.write(`error: run ${runId} was an inline workflow with no saved script — cannot resume from the CLI\n`);
    return 1;
  }

  // --args overrides the recorded args; without it, executeRun inherits the run record's stored args.
  let override: unknown;
  try {
    override = await parseArgsValue(flags.args, cwd);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (override !== undefined) input.args = override;

  // A run's backend is part of "what ran it" and must survive resume: the journal cache key is NOT
  // backend-aware, so resuming a codex run under gemini would silently mix results. Inherit the
  // recorded runner config when this invocation omits it; refuse an explicit backend that disagrees.
  const recordedBackend = record.runner?.backend ?? "codex";
  if (flags.backend !== undefined) {
    let requested: AgentBackend;
    try {
      requested = resolveBackend(flags.backend);
    } catch (error) {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
    if (requested !== recordedBackend) {
      process.stderr.write(
        `error: run ${runId} used backend "${recordedBackend}"; cannot resume it with --backend "${requested}". ` +
          `Drop --backend to reuse "${recordedBackend}", or start a fresh run (the journal cache is not backend-aware).\n`,
      );
      return 2;
    }
  } else {
    flags.backend = recordedBackend;
  }
  // Inherit the rest of the runner config when omitted (model can still be overridden explicitly).
  if (flags.model === undefined && record.runner?.model !== undefined) flags.model = record.runner.model;
  if (flags["gemini-command"] === undefined && record.runner?.geminiCommand !== undefined) {
    flags["gemini-command"] = record.runner.geminiCommand;
  }
  if (flags["agy-command"] === undefined && record.runner?.agyCommand !== undefined) {
    flags["agy-command"] = record.runner.agyCommand;
  }
  // pi backend: inherit the full recorded runner config — provider/base-url/pi-api/thinking/tool
  // selection/pi-command. pi-api and the tool flags must travel with base-url, or resume would
  // silently switch API shape / tool set on the uncached agents. The API key is never persisted, so
  // resume re-reads it from --api-key or the provider env var.
  if (flags["pi-command"] === undefined && record.runner?.piCommand !== undefined) flags["pi-command"] = record.runner.piCommand;
  if (flags.provider === undefined && record.runner?.provider !== undefined) flags.provider = record.runner.provider;
  if (flags["base-url"] === undefined && record.runner?.baseUrl !== undefined) flags["base-url"] = record.runner.baseUrl;
  if (flags.thinking === undefined && record.runner?.thinking !== undefined) flags.thinking = record.runner.thinking;
  if (flags["pi-api"] === undefined && record.runner?.piApi !== undefined) flags["pi-api"] = record.runner.piApi;
  if (flags.tools === undefined && record.runner?.tools !== undefined) flags.tools = record.runner.tools;
  if (flags["exclude-tools"] === undefined && record.runner?.excludeTools !== undefined) flags["exclude-tools"] = record.runner.excludeTools;
  if (flags["no-tools"] === undefined && record.runner?.noTools) flags["no-tools"] = true;

  return executeRun(input, runId, cwd, flags, { resumeRecord: record });
}

/**
 * Shared run engine behind `run` and `resume`: sets up the journal-resume run id, the run record, the
 * in-process viewer, Ctrl-C handling, and the controller, then executes and persists the outcome.
 */
async function executeRun(
  input: WorkflowInput,
  runId: string,
  cwd: string,
  flags: RunFlags,
  options: { resumeRecord?: RunRecord } = {},
): Promise<number> {
  const json = flags.json === true;
  const mode: ProgressMode = json || flags.quiet ? "silent" : flags["no-progress"] ? "plain" : "pretty";
  const renderer = new ProgressRenderer(mode);

  // Runtime data (runs/journal/links) lives in the global data dir so it's shared across projects;
  // `cwd` stays the project dir (where Codex agents run).
  const dataDir = workflowDataDir();
  let runner: WorkflowAgentRunner;
  try {
    runner = buildAgentRunner(cwd, flags, dataDir);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const runsPath = runsDir(dataDir);
  const runStore = new FileRunStore(runsPath);
  let runLock: RunLock;
  try {
    runLock = await acquireRunLock(runsPath, runId);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let lockReleased = false;
  const releaseRunLock = async (): Promise<void> => {
    if (lockReleased) return;
    lockReleased = true;
    await runLock.release();
  };

  try {
    input.resumeFromRunId = runId;

    // A re-run (resume) inherits the recorded run's args unless this invocation overrides them. The
    // workflow script is the deterministic orchestrator and is re-executed from the top on resume; it
    // needs its original inputs to reproduce the same agent() calls (same prompts → same journal cache
    // keys → cache hits). Inheriting here means the stored args are never silently dropped — and are
    // re-persisted into the record below, so they survive every subsequent resume.
    if (input.args === undefined) {
      const prior = options.resumeRecord ?? (await runStore.get(runId));
      if (prior?.args !== undefined) input.args = prior.args;
    }

    // Surface the declared pipeline (meta.phases, in order) so the viewer can order and pre-render the
    // phases before any agent runs — independent of which phases the script actually enters via phase().
    const declaredPhases = await readDeclaredPhases(input);

    const startedAt = Date.now();
    const baseRecord: RunRecord = {
      runId,
      name: options.resumeRecord?.name ?? input.name ?? path.basename(String(input.scriptPath ?? "inline")),
      ...(options.resumeRecord?.description ? { description: options.resumeRecord.description } : {}),
      status: "running",
      source: input.name ? "named" : input.scriptPath ? "scriptPath" : "inline",
      runner: resolveRunnerConfig(flags),
      startedAt,
      ...(declaredPhases ? { declaredPhases } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.scriptPath ? { scriptPath: path.resolve(String(input.scriptPath)) } : {}),
    };
    const protectPriorRecordOnFailure = options.resumeRecord?.status === "completed";
    if (!options.resumeRecord) await runStore.save(baseRecord);

    // Live-event bus: every progress event is appended to `runs/<id>.events.jsonl` as the single
    // cross-process liveness transport. Any server — this run's in-process viewer AND a standalone
    // `serve` — tails that file and fans events to its SSE clients. The file is deleted once the run
    // ends (its durable content is promoted into the run record). Best-effort: never breaks the run.
    const eventLog = new RunEventLog(runEventsPath(dataDir, runId));
    await eventLog.open();
    eventLog.append({ runId, type: "run-meta", record: baseRecord });

    // In-process viewer: each run binds its own server on a random (OS-assigned) port (skipped for
    // --json machine output and --no-web). It tails the events file like any other server. All viewer
    // I/O is best-effort: a failed viewer must never break the run.
    const webEnabled = !json && flags["no-web"] !== true;
    let server: WorkflowWebServer | undefined;
    let viewerUrl: string | undefined;
    if (webEnabled) {
      try {
        server = createWebServer({ dataDir, version: readPkgVersion() });
        const bound = await server.listen(0);
        viewerUrl = bound.url;
        process.stderr.write(`${dim("▸")} Viewer: ${bold(`${bound.url}/runs/${runId}`)}\n`);
        if (flags.open) openBrowser(`${bound.url}/runs/${runId}`);
      } catch (error) {
        server = undefined;
        viewerUrl = undefined;
        process.stderr.write(`${yellow("!")} viewer unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    const onProgress = (event: WorkflowProgressEvent): void => {
      renderer.handle(event);
      eventLog.append({ runId, type: "progress", event });
    };

    // Terminal handshake: append the run-finished event, flush+close the stream, let this process's own
    // server drain it to EOF (so its SSE clients get run-finished regardless of fs.watch timing), then
    // delete the now-redundant file. A remote `serve` self-heals via the client's backstop poll.
    const finishEvents = async (event: Record<string, unknown>): Promise<void> => {
      eventLog.append({ runId, ...event });
      await eventLog.close();
      await server?.drainRun(runId);
      await eventLog.remove();
    };

    // Ctrl-C handling: the first signal aborts the workflow (the runtime winds down in-flight Codex
    // threads, then controller.run() rejects with WorkflowAbortError → the cancel branch below). A second
    // signal during winddown force-quits. Handlers are removed before finishViewer so the lingering-viewer
    // gets its own clean SIGINT handler.
    const abort = new AbortController();
    let interrupted = false;
    const onInterrupt = (): void => {
      if (interrupted) {
        process.stderr.write(`\n${yellow("⊘")} Force quit.\n`);
        process.exit(130);
      }
      interrupted = true;
      abort.abort();
      renderer.finish();
      process.stderr.write(`\n${yellow("⊘")} Interrupting — winding down running agents (Ctrl-C again to force quit)…\n`);
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
    const clearInterruptHandlers = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
    };

    const controller = new WorkflowController({
      cwd,
      runner,
      onProgress,
      signal: abort.signal,
      persistDir: runsDir(dataDir),
      journalDir: journalDir(dataDir),
      ...numericFlag("concurrency", flags.concurrency),
      ...numericFlag("maxAgents", flags["max-agents"]),
      ...agentAttemptsFlag(flags["agent-retries"]),
      ...numericFlag("tokenBudget", flags.budget),
      ...numericFlag("workflowIdleTimeoutMs", flags["idle-timeout"]),
      ...(flags.bun ? { bunPath: flags.bun } : {}),
    });

    try {
      const output = await controller.run(input);
      clearInterruptHandlers();
      renderer.finish();
      await runStore.save({
        ...baseRecord,
        name: output.workflowName,
        description: output.summary,
        status: "completed",
        source: output.source,
        completedAt: Date.now(),
        durationMs: output.stats.durationMs,
        agentCount: output.stats.agentCount,
        cacheHits: output.stats.cacheHits,
        failureCount: output.stats.failures.length,
        // Promote failure detail into the record — the events file (its only other home) is about to be
        // deleted, and failed agents are never journaled, so this is where the viewer reads them from.
        ...(output.stats.failures.length ? { failures: output.stats.failures } : {}),
        phases: output.stats.phases,
        logs: output.stats.logs,
        result: output.result,
        ...(output.scriptPath ? { scriptPath: output.scriptPath } : {}),
      });
      await finishEvents({ type: "run-finished", status: "completed" });

      if (json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      } else {
        printRunSummary(output.workflowName, output.runId, output.stats, output.scriptPath);
        process.stdout.write(`${stringifyResult(output.result)}\n`);
      }
      await releaseRunLock();
      return finishViewer(server, viewerUrl, runId, 0);
    } catch (error) {
      clearInterruptHandlers();
      renderer.finish();
      if (interrupted || error instanceof WorkflowAbortError) {
        if (!protectPriorRecordOnFailure) await runStore.save({ ...baseRecord, status: "cancelled", completedAt: Date.now() });
        await finishEvents({ type: "run-finished", status: "cancelled" });
        process.stderr.write(`\n${yellow("⊘")} Cancelled ${dim(`(${runId})`)} — partial progress saved.\n`);
        process.stderr.write(`${dim(`  Resume (reuse completed agents): codex-workflow resume ${runId}`)}\n`);
        if (server) await server.close();
        await releaseRunLock();
        return 130;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!protectPriorRecordOnFailure) await runStore.save({ ...baseRecord, status: "failed", completedAt: Date.now(), error: message });
      await finishEvents({ type: "run-finished", status: "failed", error: message });
      process.stderr.write(`\nworkflow failed: ${message}\n`);
      await releaseRunLock();
      return finishViewer(server, viewerUrl, runId, 1);
    }
  } finally {
    await releaseRunLock();
  }
}

/**
 * After a run prints its result, decide the in-process viewer's fate: when stdout is a TTY, keep it
 * live (the open socket holds the foreground process up) and exit on Ctrl-C; otherwise (piped/scripted)
 * close it and return immediately. Returns the exit code (or a never-resolving promise while lingering).
 */
function finishViewer(
  server: WorkflowWebServer | undefined,
  viewerUrl: string | undefined,
  runId: string,
  exitCode: number,
): Promise<number> | number {
  if (!server) return exitCode;
  if (process.stdout.isTTY !== true) {
    return server.close().then(() => exitCode);
  }
  const deepUrl = `${viewerUrl}/runs/${runId}`;
  process.stderr.write(`${dim("▸")} Viewer still live at ${bold(deepUrl)} ${dim("— press Ctrl-C to stop")}\n`);
  const shutdown = () => {
    void server.close().finally(() => process.exit(exitCode));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Never resolves; the listening server keeps the foreground process alive until a signal arrives.
  return new Promise<number>(() => {});
}

/** `codex-workflow validate <file>` */
export async function validateCommand(target: string | undefined, flags: { json?: boolean }): Promise<number> {
  if (!target) {
    process.stderr.write("error: `validate` requires a workflow file path\n");
    return 2;
  }
  let script: string;
  try {
    script = await readFile(path.resolve(target), "utf8");
  } catch (error) {
    process.stderr.write(`error: cannot read ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const { meta } = parseWorkflowScript(script);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ valid: true, meta }, null, 2)}\n`);
    } else {
      process.stdout.write(`${green("✓")} valid workflow: ${bold(meta.name)}\n`);
      process.stdout.write(`  ${meta.description}\n`);
      if (meta.phases?.length) process.stdout.write(`  phases: ${meta.phases.map((p) => p.title).join(" → ")}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json) process.stdout.write(`${JSON.stringify({ valid: false, error: message }, null, 2)}\n`);
    else process.stderr.write(`${red("✗")} invalid workflow: ${message}\n`);
    return 1;
  }
}

/** `codex-workflow list` */
export async function listCommand(flags: { cwd?: string; json?: boolean }): Promise<number> {
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  const dirs = defaultWorkflowDirs(cwd);
  const registry = new WorkflowRegistry(dirs);
  const workflows = await registry.list();

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        workflows.map((workflow) => ({
          name: workflow.name,
          description: workflow.meta.description,
          source: workflow.source,
          path: workflow.path,
          phases: workflow.meta.phases ?? [],
        })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (workflows.length === 0) {
    process.stdout.write(`No workflows found in ${dirs.map((entry) => entry.dir).join(", ")}.\n`);
    return 0;
  }

  for (const workflow of workflows) {
    const source = workflow.path ? `${workflow.source}:${workflow.path}` : workflow.source;
    process.stdout.write(`${bold(workflow.name)}  ${dim(source)}\n`);
    process.stdout.write(`  ${workflow.meta.description}\n`);
    if (workflow.meta.phases?.length) {
      process.stdout.write(`  phases: ${workflow.meta.phases.map((phase) => phase.title).join(" → ")}\n`);
    }
  }
  return 0;
}

/** `codex-workflow runs` */
export async function runsCommand(flags: { cwd?: string; json?: boolean }): Promise<number> {
  const store = new FileRunStore(runsDir());
  const records = await store.list();

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  if (records.length === 0) {
    process.stdout.write("No runs recorded yet.\n");
    return 0;
  }
  for (const r of records) {
    const when = new Date(r.startedAt).toISOString().replace("T", " ").slice(0, 19);
    const dur = r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : "—";
    const agents = r.agentCount !== undefined ? `${r.agentCount} agents` : "";
    process.stdout.write(`${statusGlyph(r.status)} ${bold(r.runId)}  ${r.name}  ${dim(`${when} · ${dur} · ${agents}`)}\n`);
    if (r.error) process.stdout.write(`  ${red(r.error)}\n`);
  }
  return 0;
}

/** `codex-workflow show <runId>` */
export async function showCommand(runId: string | undefined, flags: { cwd?: string; json?: boolean }): Promise<number> {
  if (!runId) {
    process.stderr.write("error: `show` requires a runId\n");
    return 2;
  }
  const store = new FileRunStore(runsDir());
  const record = await store.get(runId);
  if (!record) {
    process.stderr.write(`error: run ${runId} not found\n`);
    return 1;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${statusGlyph(record.status)} ${bold(record.name)}  ${dim(record.runId)}\n`);
  if (record.description) process.stdout.write(`  ${record.description}\n`);
  process.stdout.write(`  status: ${record.status}\n`);
  if (record.scriptPath) process.stdout.write(`  script: ${record.scriptPath}\n`);
  if (record.durationMs !== undefined) process.stdout.write(`  duration: ${(record.durationMs / 1000).toFixed(1)}s\n`);
  if (record.agentCount !== undefined) process.stdout.write(`  agents: ${record.agentCount} (cache hits: ${record.cacheHits ?? 0})\n`);
  if (record.failureCount) process.stdout.write(`  ${yellow(`failed agents: ${record.failureCount}`)} (use \`resume ${record.runId}\` to re-attempt)\n`);
  if (record.phases?.length) process.stdout.write(`  phases: ${record.phases.join(" → ")}\n`);
  if (record.error) process.stdout.write(`  ${red(`error: ${record.error}`)}\n`);
  if (record.logs?.length) {
    process.stdout.write("  logs:\n");
    for (const line of record.logs) process.stdout.write(`    ${dim(line)}\n`);
  }
  return 0;
}

/**
 * `codex-workflow serve` — the standalone viewer for browsing the full run history (foreground;
 * blocks until signalled). Distinct from `run`'s in-process per-run viewer: this is a plain server
 * with no daemon/`web.json` state. Prefers port 4173 for a stable URL, or `--port` to pin one.
 */
export async function serveCommand(flags: RunFlags): Promise<number> {
  const dataDir = workflowDataDir();

  let requestedPort: number | undefined;
  if (flags.port !== undefined) {
    requestedPort = Number(flags.port);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      process.stderr.write("error: --port must be an integer 0–65535\n");
      return 2;
    }
  }

  const port = requestedPort ?? (await pickPort());
  const server = createWebServer({ dataDir, version: readPkgVersion() });
  let bound: { port: number; url: string };
  try {
    bound = await server.listen(port);
  } catch (error) {
    process.stderr.write(`error: could not start viewer on port ${port}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  process.stdout.write(`${green("✓")} Viewer running at ${bold(bound.url)}  ${dim("(Ctrl-C to stop)")}\n`);
  if (flags["no-open"] !== true) openBrowser(bound.url);

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Stay alive until signalled; the server keeps serving in the meantime.
  return new Promise<number>(() => {});
}

/** `codex-workflow doctor` */
export async function doctorCommand(flags: { cwd?: string; backend?: string; "gemini-command"?: string; "pi-command"?: string; "agy-command"?: string }): Promise<number> {
  let ok = true;
  let backend: AgentBackend;
  try {
    backend = resolveBackend(flags.backend);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const required = (good: boolean, label: string, hint?: string) => {
    if (!good) ok = false;
    process.stdout.write(`${good ? green("✓") : red("✗")} ${label}${good || !hint ? "" : `\n    ${dim(hint)}`}\n`);
  };
  const optional = (good: boolean, label: string, hint?: string) => {
    process.stdout.write(`${good ? green("✓") : yellow("!")} ${label}${good || !hint ? "" : `\n    ${dim(hint)}`}\n`);
  };

  const bun = await tryExec("bun", ["--version"]);
  required(bun.ok, `Bun runtime${bun.ok ? ` (${bun.out.trim()})` : ""}`, "Install Bun: https://bun.sh — workflows execute in a Bun child process.");

  const codex = await tryExec("codex", ["--version"]);
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  const auth = await pathExists(authPath);
  const geminiCommand = flags["gemini-command"] ?? process.env.CODEX_WORKFLOW_GEMINI_COMMAND ?? "gemini";
  const gemini = await tryExec(geminiCommand, ["--version"]);
  const piCommand = flags["pi-command"] ?? process.env.CODEX_WORKFLOW_PI_COMMAND ?? "pi";
  const pi = await tryExec(piCommand, ["--version"]);
  const agyCommand = flags["agy-command"] ?? process.env.CODEX_WORKFLOW_AGY_COMMAND ?? "agy";
  const agy = await tryExec(agyCommand, ["--version"]);

  if (backend === "codex") {
    required(codex.ok, `Codex CLI${codex.ok ? ` (${codex.out.trim()})` : ""}`, "Install Codex CLI and run `codex login`.");
    required(auth, "Codex auth (~/.codex/auth.json)", "Run `codex login` to authenticate.");
    optional(gemini.ok, `Gemini CLI${gemini.ok ? ` (${gemini.out.trim()})` : ""}`, "Only needed for `--backend gemini`.");
    optional(pi.ok, `pi CLI${pi.ok ? ` (${pi.out.trim()})` : ""}`, "Only needed for `--backend pi`.");
  } else if (backend === "pi") {
    required(pi.ok, `pi CLI${pi.ok ? ` (${pi.out.trim()})` : ""}`, "Install pi (npm i -g @earendil-works/pi-coding-agent), add it to PATH, or pass --pi-command <path>.");
    optional(codex.ok, `Codex CLI${codex.ok ? ` (${codex.out.trim()})` : ""}`, "Only needed for the default Codex backend.");
    optional(gemini.ok, `Gemini CLI${gemini.ok ? ` (${gemini.out.trim()})` : ""}`, "Only needed for `--backend gemini`.");
  } else if (backend === "agy") {
    required(agy.ok, `agy CLI${agy.ok ? ` (${agy.out.trim()})` : ""}`, "Install agy, add it to PATH, or pass --agy-command <path>.");
    optional(codex.ok, `Codex CLI${codex.ok ? ` (${codex.out.trim()})` : ""}`, "Only needed for the default Codex backend.");
    optional(gemini.ok, `Gemini CLI${gemini.ok ? ` (${gemini.out.trim()})` : ""}`, "Only needed for `--backend gemini`.");
    optional(pi.ok, `pi CLI${pi.ok ? ` (${pi.out.trim()})` : ""}`, "Only needed for `--backend pi`.");
  } else {
    required(gemini.ok, `Gemini CLI${gemini.ok ? ` (${gemini.out.trim()})` : ""}`, "Install Gemini CLI, add it to PATH, or pass --gemini-command <path>.");
    optional(codex.ok, `Codex CLI${codex.ok ? ` (${codex.out.trim()})` : ""}`, "Only needed for the default Codex backend.");
    optional(auth, "Codex auth (~/.codex/auth.json)", "Only needed for the default Codex backend.");
    optional(pi.ok, `pi CLI${pi.ok ? ` (${pi.out.trim()})` : ""}`, "Only needed for `--backend pi`.");
  }

  const dataDir = workflowDataDir();
  process.stdout.write(`${green("✓")} data dir: ${dataDir}\n`);
  process.stdout.write(`${dim("·")} backend: ${dim(backend)}\n`);
  process.stdout.write(`${dim("·")} viewer: ${dim("starts in-process per `run` (random port); `codex-workflow serve` browses history")}\n`);

  process.stdout.write(ok ? `\n${green("Ready.")}\n` : `\n${yellow("Some checks failed — see hints above.")}\n`);
  return ok ? 0 : 1;
}

function readPkgVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// --- helpers ------------------------------------------------------------------------------------

async function buildRunInput(
  target: string,
  cwd: string,
  flags: RunFlags,
): Promise<WorkflowInput> {
  const args = await parseArgsValue(flags.args, cwd);
  const asPath = path.resolve(cwd, target);
  if (await isFile(asPath)) {
    return { scriptPath: asPath, ...(args !== undefined ? { args } : {}) };
  }
  if (looksLikeWorkflowPath(target)) {
    throw new WorkflowInputError(`workflow file not found: ${target}`);
  }
  return { name: target, ...(args !== undefined ? { args } : {}) };
}

async function parseArgsValue(raw: string | undefined, cwd: string): Promise<unknown> {
  if (raw === undefined) return undefined;
  const text = raw.startsWith("@") ? await readFile(path.resolve(cwd, raw.slice(1)), "utf8") : raw;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WorkflowInputError(`--args must be JSON (or @file.json): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildAgentRunner(cwd: string, flags: RunFlags, dataDir: string): WorkflowAgentRunner {
  if (process.env.CODEX_WORKFLOW_FAKE_AGENT) return new FakeAgentRunner();

  const backend = resolveBackend(flags.backend);
  if (backend === "gemini") return buildGeminiRunner(cwd, flags);
  if (backend === "pi") return buildPiRunner(cwd, flags, dataDir);
  if (backend === "agy") return buildAgyRunner(cwd, flags);
  return buildCodexRunner(cwd, flags);
}

function buildCodexRunner(cwd: string, flags: RunFlags): WorkflowAgentRunner {
  rejectPiOnlyFlags(flags, "codex");
  const options: CodexSdkAgentRunnerOptions = { cwd };
  if (flags.model) options.model = flags.model;
  if (flags.sandbox) options.sandboxMode = assertOneOf(flags.sandbox, SANDBOX_MODES, "--sandbox") as SandboxMode;
  if (flags.approval) options.approvalPolicy = assertOneOf(flags.approval, APPROVAL_MODES, "--approval") as ThreadOptions["approvalPolicy"];
  const reasoning = flags.reasoning ?? flags.reasoningEffort;
  if (reasoning) options.modelReasoningEffort = assertOneOf(reasoning, REASONING_EFFORTS, "--reasoning") as ThreadOptions["modelReasoningEffort"];
  const codexTimeout = parseAgentTimeoutFlag(flags["agent-timeout"]);
  if (codexTimeout !== undefined) options.agentTimeoutMs = codexTimeout;
  // Web search + network access are always enabled for agents.
  options.webSearchEnabled = true;
  options.networkAccessEnabled = true;
  return new CodexSdkAgentRunner(options);
}

function buildGeminiRunner(cwd: string, flags: RunFlags): WorkflowAgentRunner {
  const unsupported = [
    flags.sandbox !== undefined ? "--sandbox" : undefined,
    flags.approval !== undefined ? "--approval" : undefined,
    (flags.reasoning ?? flags.reasoningEffort) !== undefined ? "--reasoning" : undefined,
  ].filter(Boolean);
  if (unsupported.length) {
    throw new WorkflowInputError(`${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} only supported with --backend codex`);
  }

  rejectPiOnlyFlags(flags, "gemini");
  const options: GeminiCliAgentRunnerOptions = { cwd };
  options.command = flags["gemini-command"] ?? process.env.CODEX_WORKFLOW_GEMINI_COMMAND ?? "gemini";
  if (flags.model) options.model = flags.model;
  const geminiTimeout = parseAgentTimeoutFlag(flags["agent-timeout"]);
  if (geminiTimeout !== undefined) options.agentTimeoutMs = geminiTimeout;
  return new GeminiCliAgentRunner(options);
}

function buildPiRunner(cwd: string, flags: RunFlags, dataDir: string): WorkflowAgentRunner {
  const codexOnly = [
    flags.sandbox !== undefined ? "--sandbox" : undefined,
    flags.approval !== undefined ? "--approval" : undefined,
    (flags.reasoning ?? flags.reasoningEffort) !== undefined ? "--reasoning" : undefined,
  ].filter(Boolean);
  if (codexOnly.length) {
    throw new WorkflowInputError(`${codexOnly.join(", ")} ${codexOnly.length === 1 ? "is" : "are"} only supported with --backend codex (pi uses --thinking)`);
  }

  const options: PiCliAgentRunnerOptions = { cwd };
  options.command = flags["pi-command"] ?? process.env.CODEX_WORKFLOW_PI_COMMAND ?? "pi";
  // pi writes session JSONL here; the viewer reads linked sessions from the same path.
  options.sessionDir = piSessionsDir(dataDir);
  if (flags.model) options.model = flags.model;
  if (flags.provider) options.provider = flags.provider;
  if (flags["base-url"]) {
    options.baseUrl = flags["base-url"];
    // A custom endpoint needs a config home to host the generated models.json.
    options.agentDir = piHomeDir(dataDir);
  }
  if (flags["api-key"]) options.apiKey = flags["api-key"];
  if (flags["pi-api"]) {
    options.api = assertOneOf(flags["pi-api"], PI_API_SHAPES, "--pi-api") as NonNullable<PiCliAgentRunnerOptions["api"]>;
  }
  if (flags.thinking) options.thinking = assertOneOf(flags.thinking, REASONING_EFFORTS, "--thinking");
  if (flags["no-tools"]) options.noTools = true;
  if (flags.tools) options.tools = splitList(flags.tools);
  if (flags["exclude-tools"]) options.excludeTools = splitList(flags["exclude-tools"]);
  const piTimeout = parseAgentTimeoutFlag(flags["agent-timeout"]);
  if (piTimeout !== undefined) options.agentTimeoutMs = piTimeout;

  if (options.baseUrl && !options.model) {
    throw new WorkflowInputError("--base-url requires --model (the model id sent to the endpoint)");
  }
  return new PiCliAgentRunner(options);
}

function buildAgyRunner(cwd: string, flags: RunFlags): WorkflowAgentRunner {
  const unsupported = [
    flags.sandbox !== undefined ? "--sandbox" : undefined,
    flags.approval !== undefined ? "--approval" : undefined,
    (flags.reasoning ?? flags.reasoningEffort) !== undefined ? "--reasoning" : undefined,
  ].filter(Boolean);
  if (unsupported.length) {
    throw new WorkflowInputError(`${unsupported.join(", ")} ${unsupported.length === 1 ? "is" : "are"} only supported with --backend codex`);
  }

  rejectPiOnlyFlags(flags, "agy");
  const options: AgyCliAgentRunnerOptions = { cwd };
  options.command = flags["agy-command"] ?? process.env.CODEX_WORKFLOW_AGY_COMMAND ?? "agy";
  if (flags.model) options.model = flags.model;
  const agyTimeout = parseAgentTimeoutFlag(flags["agent-timeout"]);
  if (agyTimeout !== undefined) options.agentTimeoutMs = agyTimeout;
  return new AgyCliAgentRunner(options);
}

/** pi-only flags must not silently no-op on the codex/gemini backends. */
function rejectPiOnlyFlags(flags: RunFlags, backend: string): void {
  const piOnly = [
    flags.provider !== undefined ? "--provider" : undefined,
    flags["base-url"] !== undefined ? "--base-url" : undefined,
    flags["api-key"] !== undefined ? "--api-key" : undefined,
    flags["pi-api"] !== undefined ? "--pi-api" : undefined,
    flags.thinking !== undefined ? "--thinking" : undefined,
    flags.tools !== undefined ? "--tools" : undefined,
    flags["exclude-tools"] !== undefined ? "--exclude-tools" : undefined,
    flags["no-tools"] ? "--no-tools" : undefined,
  ].filter(Boolean);
  if (piOnly.length) {
    throw new WorkflowInputError(`${piOnly.join(", ")} ${piOnly.length === 1 ? "is" : "are"} only supported with --backend pi`);
  }
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveBackend(raw: string | undefined): AgentBackend {
  const value = raw ?? process.env.CODEX_WORKFLOW_BACKEND ?? "codex";
  return assertOneOf(value, [...AGENT_BACKENDS], "--backend") as AgentBackend;
}

/** Snapshots the runner config a run used so `resume` can reuse it (see `RunnerConfig`). */
function resolveRunnerConfig(flags: RunFlags): RunnerConfig {
  const config: RunnerConfig = { backend: resolveBackend(flags.backend) };
  if (flags.model) config.model = flags.model;
  if (config.backend === "gemini") {
    const command = flags["gemini-command"] ?? process.env.CODEX_WORKFLOW_GEMINI_COMMAND;
    if (command) config.geminiCommand = command;
  }
  if (config.backend === "agy") {
    const command = flags["agy-command"] ?? process.env.CODEX_WORKFLOW_AGY_COMMAND;
    if (command) config.agyCommand = command;
  }
  if (config.backend === "pi") {
    const command = flags["pi-command"] ?? process.env.CODEX_WORKFLOW_PI_COMMAND;
    if (command) config.piCommand = command;
    if (flags.provider) config.provider = flags.provider;
    if (flags["base-url"]) config.baseUrl = flags["base-url"];
    if (flags.thinking) config.thinking = flags.thinking;
    if (flags["pi-api"]) config.piApi = flags["pi-api"];
    if (flags.tools) config.tools = flags.tools;
    if (flags["exclude-tools"]) config.excludeTools = flags["exclude-tools"];
    if (flags["no-tools"]) config.noTools = true;
    // The API key is intentionally NOT persisted; resume reads it from --api-key or the provider env var.
  }
  return config;
}

/** Parses `--agent-timeout` (ms): a non-negative number, where 0 disables the timeout. */
function parseAgentTimeoutFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const timeout = Number(raw);
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new WorkflowInputError(`--agent-timeout must be a non-negative number of ms (0 disables), got "${raw}"`);
  }
  return timeout;
}

/** Deterministic, token-free runner used by tests via CODEX_WORKFLOW_FAKE_AGENT=1. */
class FakeAgentRunner implements WorkflowAgentRunner {
  async run(call: WorkflowAgentCall): Promise<unknown> {
    if (call.options.schema) return "{}";
    return `fake:${call.prompt}`;
  }
}

function numericFlag<K extends string>(key: K, raw: string | undefined): Partial<Record<K, number>> {
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new WorkflowInputError(`${key} must be a number, got "${raw}"`);
  return { [key]: value } as Record<K, number>;
}

/** `--agent-retries <n>` → agentMaxAttempts = n + 1 (n retries means n+1 total attempts). */
function agentAttemptsFlag(raw: string | undefined): { agentMaxAttempts?: number } {
  if (raw === undefined) return {};
  const retries = Number(raw);
  if (!Number.isFinite(retries) || retries < 0) throw new WorkflowInputError(`--agent-retries must be a non-negative number, got "${raw}"`);
  return { agentMaxAttempts: Math.trunc(retries) + 1 };
}

function looksLikeWorkflowPath(target: string): boolean {
  return target.includes("/") || target.includes("\\") || /\.(m?[jt]s)$/.test(target);
}

/** Parses meta.phases titles for the declared pipeline order. Best-effort (CLI runs are path-based). */
async function readDeclaredPhases(input: WorkflowInput): Promise<string[] | undefined> {
  try {
    const script = input.scriptPath ? await readFile(String(input.scriptPath), "utf8") : input.script;
    if (!script) return undefined;
    const phases = parseWorkflowScript(script).meta.phases;
    return phases?.length ? phases.map((phase) => phase.title) : undefined;
  } catch {
    return undefined; // fall back to executed-phase order
  }
}

function assertOneOf(value: string, allowed: string[], flag: string): string {
  if (!allowed.includes(value)) {
    throw new WorkflowInputError(`${flag} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function tryExec(cmd: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; out: string }> {
  try {
    // `doctor` probes external binaries (bun/codex/gemini --version); a misbehaving same-named binary
    // on PATH must not hang the whole check, so cap each probe with a timeout (SIGTERM on expiry).
    const { stdout } = await exec(cmd, args, { timeout: timeoutMs });
    return { ok: true, out: stdout };
  } catch {
    return { ok: false, out: "" };
  }
}

function printRunSummary(
  name: string,
  runId: string,
  stats: { agentCount: number; cacheHits: number; durationMs: number; phases: string[]; failures: { label: string }[] },
  scriptPath?: string,
): void {
  const failed = stats.failures.length;
  const failedSuffix = failed > 0 ? `, ${yellow(`${failed} failed`)}` : "";
  process.stderr.write(
    `\n${green("✓")} ${bold(name)} ${dim(`(${runId})`)} — ${stats.agentCount} agents, ${stats.cacheHits} cached${failedSuffix}, ${(stats.durationMs / 1000).toFixed(1)}s\n`,
  );
  if (scriptPath) {
    process.stderr.write(`${dim(`  Iterate: edit ${scriptPath} then re-run`)}\n`);
  }
  process.stderr.write(`${dim(`  Resume (reuse completed agents): codex-workflow resume ${runId}`)}\n`);
  if (failed > 0) {
    process.stderr.write(`${dim(`  ${failed} agent(s) failed — \`resume ${runId}\` will re-attempt them.`)}\n`);
  }
  process.stderr.write("\n");
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

// Minimal ANSI helpers (stdout is not assumed to be a TTY; colors only when interactive).
const useColor = process.stderr.isTTY === true && !process.env.NO_COLOR;
function paint(text: string, code: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const bold = (t: string) => paint(t, "1");
const dim = (t: string) => paint(t, "2");
const red = (t: string) => paint(t, "31");
const green = (t: string) => paint(t, "32");
const yellow = (t: string) => paint(t, "33");

function statusGlyph(status: RunRecord["status"]): string {
  switch (status) {
    case "completed":
      return green("✓");
    case "failed":
      return red("✗");
    case "cancelled":
      return yellow("⊘");
    default:
      return dim("⟳");
  }
}

function randomId(): string {
  return randomUUID().slice(0, 12);
}

export type { WorkflowProgressEvent };
