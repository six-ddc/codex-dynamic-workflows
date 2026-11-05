import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Ajv } from "ajv/dist/ajv.js";
import { WorkflowAbortError, WorkflowAgentCapError, WorkflowBudgetExceededError, WorkflowInputError } from "./errors.js";
import { cloneJournalResult, journalEntryFromCall, workflowAgentCacheKey } from "./journal.js";
import { parseWorkflowScript } from "./parser.js";
import type {
  AgentFailure,
  JsonSchema,
  WorkflowMeta,
  WorkflowAgentMeta,
  WorkflowAgentOptions,
  WorkflowAgentRunner,
  WorkflowRef,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowRunnerResolver,
} from "./types.js";

const MAX_ITEMS_PER_CALL = 4096;
const DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Cap the parent-side partial-line accumulator for child stdout (a giant no-newline line OOMs us). */
const MAX_CHILD_STDOUT_LINE_BYTES = 32 * 1024 * 1024;
/** Keep only this much of the child's stderr tail for the failure message. */
const MAX_CHILD_STDERR_TAIL_BYTES = 256 * 1024;

interface RuntimeState {
  logs: string[];
  phases: string[];
  agentCount: number;
  nextAgentIndex: number;
  cacheHits: number;
  spent: number;
  failures: AgentFailure[];
}

interface ChildRequestMessage {
  kind: "request";
  id: number;
  type: string;
  payload: {
    prompt?: unknown;
    options?: unknown;
    nameOrRef?: unknown;
    args?: unknown;
    depth?: unknown;
  };
}

interface ChildEventMessage {
  kind: "event";
  type: "phase" | "log";
  payload: Record<string, unknown>;
}

interface ChildResultMessage {
  kind: "result";
  value: unknown;
}

interface ChildErrorMessage {
  kind: "error";
  error: {
    message: string;
    stack?: string;
  };
}

type ChildMessage = ChildRequestMessage | ChildEventMessage | ChildResultMessage | ChildErrorMessage;

/**
 * Shared per-run state. Created once for the top-level workflow and reused by every nested
 * `workflow()` invocation so that all agents — across the root and nested scripts — share the same
 * concurrency limiter, agent-count cap, token budget, journal, and abort signal.
 */
interface RunContext {
  state: RuntimeState;
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  maxAgents: number;
  /** Total attempts per agent (1 = no retry). */
  agentMaxAttempts: number;
  tokenBudget: number | null | undefined;
  bunPath: string;
  cwd: string;
  /** Internal controller; aborted once the root workflow settles to cancel any leaked agents. */
  internalAbort: AbortController;
  /** Signal handed to the runner: fires on user cancel OR internal cleanup. */
  agentSignal: AbortSignal;
  /** In-flight runner promises, awaited on teardown so Codex threads stop cleanly. */
  inFlight: Set<Promise<unknown>>;
  options: WorkflowRunOptions;
  emitLog: (message: unknown) => void;
  recordPhase: (title: unknown) => void;
  runAgent: (prompt: unknown, options?: unknown) => Promise<unknown>;
  runNestedWorkflow: (nameOrRef: unknown, args: unknown, callerDepth: number) => Promise<unknown>;
}

interface BunChildOptions {
  bunPath: string;
  cwd: string;
  signal?: AbortSignal;
  idleTimeoutMs: number | null;
  emitLog: (message: unknown) => void;
  recordPhase: (title: unknown) => void;
  runAgent: (prompt: unknown, options?: unknown) => Promise<unknown>;
  runNestedWorkflow: (nameOrRef: unknown, args: unknown, callerDepth: number) => Promise<unknown>;
  spent: () => number;
}

interface BunChildRequestHooks {
  requestStarted: () => void;
  requestSettled: () => void;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const IPC_PREFIX = "__CODEX_WORKFLOW_IPC__";

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const parsed = parseWorkflowScript(script);
  const runId = options.runId ?? `wf_${cryptoRandomId()}`;
  const ctx = createRunContext(options, runId);

  try {
    // The result already crossed the Bun-child IPC boundary as JSON (child-side `assertNoWorkflowPromises`
    // is the real serializability guard), so it is a fresh, structured-cloneable value — no extra clone here.
    const result = await executeWorkflow(parsed.body, parsed.meta, ctx, options.args, 0, undefined);

    return {
      meta: parsed.meta,
      result: result as T,
      logs: ctx.state.logs,
      phases: ctx.state.phases,
      agentCount: ctx.state.agentCount,
      durationMs: Date.now() - started,
      runId,
      cacheHits: ctx.state.cacheHits,
      failures: ctx.state.failures,
    };
  } finally {
    if (ctx.inFlight.size > 0) {
      ctx.emitLog(`workflow finished with ${ctx.inFlight.size} un-awaited agent(s) still in flight; cancelling them.`);
    }
    ctx.internalAbort.abort();
    await Promise.allSettled([...ctx.inFlight]);
  }
}

function createRunContext(options: WorkflowRunOptions, runId: string): RunContext {
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, nextAgentIndex: 0, cacheHits: 0, spent: 0, failures: [] };
  const limiter = createLimiter(resolveConcurrency(options.concurrency));
  const internalAbort = new AbortController();
  const agentSignal = options.signal ? anySignal([internalAbort.signal, options.signal]) : internalAbort.signal;
  const inFlight = new Set<Promise<unknown>>();
  // A single runner is just a resolver that ignores the options; a function is used as-is for routing.
  const resolveRunner: WorkflowRunnerResolver =
    typeof options.runner === "function"
      ? (options.runner as WorkflowRunnerResolver)
      : () => options.runner as WorkflowAgentRunner;

  const emitLog = (message: unknown) => {
    const text = String(message);
    state.logs.push(text);
    options.onProgress?.({ type: "log", message: text });
  };

  const recordPhase = (title: unknown) => {
    const text = requireString(title, "phase title");
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onProgress?.({ type: "phase", title: text });
  };

  const throwIfUserAborted = () => {
    if (options.signal?.aborted) throw new WorkflowAbortError();
  };

  const ctx: RunContext = {
    state,
    limiter,
    maxAgents: options.maxAgents ?? 1000,
    agentMaxAttempts: Math.max(1, Math.trunc(options.agentMaxAttempts ?? 3)),
    tokenBudget: options.tokenBudget,
    bunPath: options.bunPath ?? process.env.BUN_PATH ?? "bun",
    cwd: options.cwd ?? process.cwd(),
    internalAbort,
    agentSignal,
    inFlight,
    options,
    emitLog,
    recordPhase,
    runAgent: () => Promise.reject(new Error("runAgent not initialized")),
    runNestedWorkflow: () => Promise.reject(new Error("runNestedWorkflow not initialized")),
  };

  ctx.runAgent = async (prompt: unknown, rawOptions: unknown = {}) => {
    throwIfUserAborted();
    const taskPrompt = requireString(prompt, "agent prompt");
    const agentOptions = normalizeAgentOptions(rawOptions);
    if (state.agentCount >= ctx.maxAgents) {
      throw new WorkflowAgentCapError(
        `Workflow agent() call cap reached (${ctx.maxAgents}). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.`,
      );
    }
    if (ctx.tokenBudget !== null && ctx.tokenBudget !== undefined && remainingBudget(ctx.tokenBudget, state) <= 0) {
      throw new WorkflowBudgetExceededError("workflow token budget exhausted");
    }

    const assignedPhase = agentOptions.phase;
    state.agentCount++;
    const index = ++state.nextAgentIndex;
    const userLabel = agentOptions.label?.trim();
    const label = userLabel || defaultAgentLabel(assignedPhase, index);
    const callOptions = withAgentIdentity(agentOptions, label, assignedPhase);
    // The cache key excludes an AUTO-generated label: that label embeds `nextAgentIndex`, a run-global
    // arrival-order counter that interleaves nondeterministically when a nested workflow() runs
    // concurrently, so the same logical agent would hash differently across runs and miss the resume
    // cache. A user-set label is part of the caller's identity and stays in the key. The display/journal
    // label keeps its index.
    const cacheKeyOptions = userLabel ? callOptions : omitKey(callOptions, "label");
    const cacheKey = workflowAgentCacheKey({ prompt: taskPrompt, options: cacheKeyOptions });
    const call = {
      prompt: taskPrompt,
      options: callOptions,
      index,
      runId,
      cacheKey,
      ...(assignedPhase !== undefined ? { phase: assignedPhase } : {}),
    };

    return limiter(async () => {
      const liveDetail = { index, key: cacheKey, prompt: taskPrompt, options: callOptions };
      options.onProgress?.(agentProgress(label, assignedPhase, "started", liveDetail));

      throwIfUserAborted();
      const cached = await options.journal?.get(call.runId, cacheKey);
      if (cached) {
        const result = cloneJournalResult(cached);
        state.cacheHits++;
        // Cache hits cost no new tokens, so they do not move `spent`.
        options.onProgress?.(
          agentProgress(label, assignedPhase, "cached", {
            result,
            index,
            key: cacheKey,
            ...(cached.backend ? { backend: cached.backend } : {}),
            ...(cached.sessionId ? { sessionId: cached.sessionId } : {}),
          }),
        );
        return result;
      }

      // Pick the runner for this call (provider/model routing). Thrown here — after the cache check,
      // before the retry loop — so an unknown provider / ambiguous model hard-fails like cap/budget,
      // rather than being retried into a `null` failure. Cached agents never reach this.
      const runner = resolveRunner(callOptions);

      const maxAttempts = ctx.agentMaxAttempts;
      let lastMessage = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (ctx.internalAbort.signal.aborted) throw new WorkflowAbortError();
        throwIfUserAborted();

        let sessionId: string | undefined;
        let backend: string | undefined;
        let outputTokens: number | undefined;
        const onMeta = (meta: WorkflowAgentMeta) => {
          if (meta.backend) backend = meta.backend;
          if (meta.sessionId) {
            sessionId = meta.sessionId;
          }
          if (meta.backend || meta.sessionId) {
            options.onProgress?.(
              agentProgress(label, assignedPhase, "started", {
                ...liveDetail,
                ...(backend ? { backend } : {}),
                ...(sessionId ? { sessionId } : {}),
              }),
            );
          }
          if (typeof meta.outputTokens === "number") outputTokens = meta.outputTokens;
          if (meta.worktreePreserved && meta.worktreePath) {
            emitLog(`agent ${label} worktree preserved at ${meta.worktreePath} (had changes)`);
          }
        };
        const runPromise = Promise.resolve(runner.run(call, ctx.agentSignal, onMeta));
        inFlight.add(runPromise);
        let result: unknown;
        try {
          const raw = await runPromise;
          throwIfUserAborted();
          // Only the model turn + schema validation are retryable; an AJV validation failure re-runs.
          result = normalizeAgentResult(raw, agentOptions.schema);
        } catch (error) {
          if (error instanceof WorkflowAbortError || options.signal?.aborted || ctx.internalAbort.signal.aborted) {
            inFlight.delete(runPromise);
            throw error;
          }
          // A completed-but-rejected turn (e.g. AJV validation failure) still burned real tokens; count
          // them so budget-capped loops don't overspend by a multiple across retries.
          if (typeof outputTokens === "number") state.spent += outputTokens;
          inFlight.delete(runPromise);
          lastMessage = error instanceof Error ? error.message : String(error);
          if (attempt < maxAttempts) {
            emitLog(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${lastMessage}; retrying`);
            await abortableDelay(retryBackoffMs(attempt), ctx.agentSignal);
          }
          continue;
        }
        inFlight.delete(runPromise);

        // Success. Token accounting is deterministic bookkeeping and runs here. The journal write and the
        // onProgress callback are moved OUT of the retryable region and made best-effort — a disk-full put
        // or a throwing onProgress must never re-run (and re-spend) an already-paid-for model turn.
        state.spent += outputTokens ?? estimateTokens(result);
        try {
          await options.journal?.put(
            journalEntryFromCall(call, result, {
              ...(sessionId ? { sessionId } : {}),
              ...(backend ? { backend } : {}),
            }),
          );
        } catch (putError) {
          emitLog(`agent ${label} journal write failed (result not cached): ${errorMessage(putError)}`);
        }
        try {
          options.onProgress?.(
            agentProgress(label, assignedPhase, "completed", {
              result,
              index,
              key: cacheKey,
              ...(backend ? { backend } : {}),
              ...(sessionId ? { sessionId } : {}),
            }),
          );
        } catch (progressError) {
          emitLog(`agent ${label} onProgress(completed) threw (ignored): ${errorMessage(progressError)}`);
        }
        return result;
      }

      // Retries exhausted: record the failure and return null so `.filter(Boolean)` works (Claude parity).
      emitLog(`agent ${label} failed after ${maxAttempts} attempt(s): ${lastMessage}`);
      state.failures.push({
        label,
        ...(assignedPhase !== undefined ? { phase: assignedPhase } : {}),
        index,
        key: cacheKey,
        attempts: maxAttempts,
        error: lastMessage,
      });
      options.onProgress?.(agentProgress(label, assignedPhase, "failed", { error: lastMessage, index, key: cacheKey }));
      return null;
    });
  };

  ctx.runNestedWorkflow = (nameOrRef: unknown, args: unknown, callerDepth: number) => {
    // Register the nested run in `inFlight` SYNCHRONOUSLY (before any await), so a fire-and-forget
    // `workflow()` still running when the root settles is awaited (and its child killed) in the
    // runWorkflow finally instead of being orphaned. The nested child inherits ctx.agentSignal, so
    // internalAbort.abort() in that finally tears it down.
    const promise = (async () => {
      throwIfUserAborted();
      if (callerDepth >= 1) {
        throw new WorkflowInputError("workflow() nesting is one level only");
      }
      if (!options.resolveWorkflow) {
        throw new WorkflowInputError(
          "workflow() requires a resolver/registry, but none was configured for this run.",
        );
      }
      const ref = toWorkflowRef(nameOrRef);
      const resolved = await options.resolveWorkflow(ref);
      const parsed = parseWorkflowScript(resolved.script);
      return executeWorkflow(parsed.body, parsed.meta, ctx, args, callerDepth + 1, resolved.name);
    })();
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
    return promise;
  };

  return ctx;
}

/**
 * Generates the Bun runner source for one script and executes it in a child process. The child
 * routes `agent()`, `workflow()`, `phase()`, and `log()` back to the shared {@link RunContext}.
 */
async function executeWorkflow(
  body: string,
  meta: WorkflowMeta,
  ctx: RunContext,
  args: unknown,
  depth: number,
  phasePrefix: string | undefined,
): Promise<unknown> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-bun-"));
  try {
    const name = meta.name;
    const safeName = (name || "workflow").replace(/[^A-Za-z0-9_.-]/g, "_") || "workflow";
    const runnerPath = path.join(tempDir, `${safeName}.runner.ts`);
    await writeFile(
      runnerPath,
      bunRunnerSource(body, ctx.tokenBudget, args, ctx.cwd, depth, phasePrefix, phaseModelMap(meta)),
      "utf8",
    );
    const childOptions: BunChildOptions = {
      bunPath: ctx.bunPath,
      cwd: ctx.cwd,
      // The combined internal+user signal: user cancel OR internal cleanup (root settled) both tear the
      // child down. This is what stops a leaked/nested Bun child from re-arming its idle watchdog forever.
      signal: ctx.agentSignal,
      idleTimeoutMs: resolveWorkflowIdleTimeout(ctx.options.workflowIdleTimeoutMs),
      emitLog: ctx.emitLog,
      recordPhase: ctx.recordPhase,
      runAgent: ctx.runAgent,
      runNestedWorkflow: ctx.runNestedWorkflow,
      spent: () => ctx.state.spent,
    };
    return await runBunChild(runnerPath, childOptions);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function bunRunnerSource(
  body: string,
  tokenBudget: number | null | undefined,
  args: unknown,
  cwd: string,
  depth: number,
  phasePrefix: string | undefined,
  phaseModels: Record<string, string>,
): string {
  return `const IPC_PREFIX = ${JSON.stringify(IPC_PREFIX)};
let nextRequestId = 1;
const pendingRequests = new Map();
let stdinBuffer = "";
let sharedSpent = 0;
const tokenBudget = ${tokenBudget === undefined ? "null" : JSON.stringify(tokenBudget)};
const args = ${args === undefined ? "undefined" : JSON.stringify(args)};
const cwd = ${JSON.stringify(cwd)};
const __depth = ${JSON.stringify(depth)};
const __phasePrefix = ${phasePrefix === undefined ? "undefined" : JSON.stringify(phasePrefix)};
const __phaseModels = ${JSON.stringify(phaseModels)};
let currentPhase = __phasePrefix;
let currentPhaseModel = undefined;

function send(message) {
  process.stdout.write(IPC_PREFIX + JSON.stringify(message) + "\\n");
}

function finish(message) {
  // Write the final line honoring backpressure: process.exit() does NOT drain pending pipe writes, so a
  // multi-MB result line could be truncated (parent then reports "exited without producing a result").
  // Exit only once the write callback fires (the data has been handed to the OS).
  process.stdout.write(IPC_PREFIX + JSON.stringify(message) + "\\n", () => process.exit(0));
}

function emitLog(message) {
  send({ kind: "event", type: "log", payload: { message: String(message) } });
}

function request(type, payload) {
  const id = nextRequestId++;
  send({ kind: "request", id, type, payload });
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
  });
}

function trackWorkflowPromise(promise) {
  // Swallow rejections on a DERIVED promise so a fire-and-forget agent()/workflow() that rejects does not
  // crash the child with an unhandledRejection. The original promise still rejects for any awaiter.
  promise.catch(() => undefined);
  return promise;
}

function makeChildError(errorInfo) {
  const error = new Error(errorInfo && errorInfo.message ? errorInfo.message : String(errorInfo));
  // Fatal (cap/budget/abort/provider-resolution) errors must survive the IPC boundary as a structured
  // flag — the error TYPE is flattened to a message across IPC, so parallel()/pipeline() key off this
  // field (not instanceof) to decide whether to rethrow (hard-fail) or swallow into null.
  if (errorInfo && errorInfo.fatal) error.__workflowFatal = true;
  return error;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let index;
  while ((index = stdinBuffer.indexOf("\\n")) >= 0) {
    const line = stdinBuffer.slice(0, index);
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (!line.startsWith(IPC_PREFIX)) continue;
    const message = JSON.parse(line.slice(IPC_PREFIX.length));
    if (message.kind !== "response") continue;
    if (typeof message.spent === "number") sharedSpent = message.spent;
    const pending = pendingRequests.get(message.id);
    if (!pending) continue;
    pendingRequests.delete(message.id);
    if (message.error) pending.reject(makeChildError(message.error));
    else pending.resolve(message.value);
  }
});

console.log = (...values) => emitLog(values.join(" "));
console.info = console.log;
console.warn = (...values) => emitLog("[warn] " + values.join(" "));
console.error = (...values) => emitLog("[error] " + values.join(" "));

function phase(title) {
  const text = String(title);
  currentPhase = __phasePrefix ? __phasePrefix + " \\u00b7 " + text : text;
  currentPhaseModel = __phaseModels[text];
  send({ kind: "event", type: "phase", payload: { title: currentPhase } });
}

function log(message) {
  emitLog(message);
}

function agent(prompt, options = {}) {
  const opts = options && typeof options === "object" ? { ...options } : options;
  if (opts && typeof opts === "object" && opts.phase === undefined && currentPhase !== undefined) {
    opts.phase = currentPhase;
  }
  if (opts && typeof opts === "object" && opts.model === undefined) {
    const phaseModel = typeof opts.phase === "string" ? modelForPhase(opts.phase) : currentPhaseModel;
    if (phaseModel !== undefined) opts.model = phaseModel;
  }
  return trackWorkflowPromise(request("agent", { prompt, options: opts }));
}

function modelForPhase(phaseTitle) {
  if (Object.prototype.hasOwnProperty.call(__phaseModels, phaseTitle)) return __phaseModels[phaseTitle];
  if (__phasePrefix && typeof phaseTitle === "string") {
    const prefix = __phasePrefix + " \\u00b7 ";
    if (phaseTitle.startsWith(prefix)) return __phaseModels[phaseTitle.slice(prefix.length)];
  }
  return undefined;
}

function workflow(nameOrRef, workflowArgs) {
  if (__depth > 0) {
    throw new Error("workflow() nesting is one level only");
  }
  return trackWorkflowPromise(request("workflow", { nameOrRef, args: workflowArgs, depth: __depth }));
}

async function parallel(thunks) {
  if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
  if (thunks.length > ${MAX_ITEMS_PER_CALL}) {
    throw new Error("parallel() accepts at most ${MAX_ITEMS_PER_CALL} items; received " + thunks.length);
  }
  if (thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
  }
  return Promise.all(
    thunks.map(async (thunk, index) => {
      try {
        return await thunk();
      } catch (error) {
        if (error && error.__workflowFatal) throw error;
        emitLog("parallel[" + index + "] failed: " + errorMessage(error));
        return null;
      }
    }),
  );
}

async function pipeline(items, ...stages) {
  if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
  if (items.length > ${MAX_ITEMS_PER_CALL}) {
    throw new Error("pipeline() accepts at most ${MAX_ITEMS_PER_CALL} items; received " + items.length);
  }
  if (stages.some((stage) => typeof stage !== "function")) {
    throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
  }
  return Promise.all(
    items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) {
        try {
          value = await stage(value, item, index);
        } catch (error) {
          if (error && error.__workflowFatal) throw error;
          emitLog("pipeline[" + index + "] failed: " + errorMessage(error));
          return null;
        }
      }
      return value;
    }),
  );
}

const budget = Object.freeze({
  total: tokenBudget,
  spent: () => sharedSpent,
  remaining: () => tokenBudget == null ? Infinity : Math.max(0, tokenBudget - sharedSpent),
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertNoWorkflowPromises(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (typeof value.then === "function") {
    throw new Error("workflow result must be serializable; did you forget to await agent(), parallel(), pipeline(), or workflow()?");
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoWorkflowPromises(item, seen);
    return;
  }
  for (const item of Object.values(value)) assertNoWorkflowPromises(item, seen);
}

async function __workflow_main() {
${body}
}

try {
  const result = await __workflow_main();
  assertNoWorkflowPromises(result);
  finish({ kind: "result", value: result });
} catch (error) {
  finish({
    kind: "error",
    error: {
      message: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
}
`;
}

async function runBunChild(runnerPath: string, options: BunChildOptions): Promise<unknown> {
  const child = spawn(options.bunPath, [runnerPath], {
    cwd: options.cwd,
    env: process.env,
    stdio: "pipe",
  });
  // Decode incrementally so multibyte characters can span pipe chunks.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let pendingChildRequests = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };

    const armIdleTimer = () => {
      clearIdleTimer();
      if (settled || options.idleTimeoutMs === null || pendingChildRequests > 0) return;
      idleTimer = setTimeout(() => {
        settle(
          new WorkflowInputError(
            `Bun workflow made no progress for ${options.idleTimeoutMs}ms while not waiting on an agent/workflow request. ` +
              "Check for an infinite loop or pass workflowIdleTimeoutMs: null to disable the watchdog.",
          ),
        );
      }, options.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const requestHooks: BunChildRequestHooks = {
      requestStarted: () => {
        pendingChildRequests++;
        clearIdleTimer();
      },
      requestSettled: () => {
        pendingChildRequests = Math.max(0, pendingChildRequests - 1);
        armIdleTimer();
      },
    };

    const settle = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      options.signal?.removeEventListener("abort", abort);
      // Whenever we settle with an error while the child is still alive (malformed IPC, stdin write
      // failure, idle watchdog, abort, oversized buffer), kill it — otherwise it is orphaned and keeps
      // re-arming its own idle watchdog forever. Guarded so an already-exited child is not re-signalled.
      if (error && !child.killed && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      if (error) reject(error);
      else resolve(value);
    };

    const abort = () => {
      settle(new WorkflowAbortError());
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });

    armIdleTimer();

    child.on("error", (error) => settle(normalizeBunSpawnError(error, options.bunPath)));
    child.stdin.on("error", (error) => {
      if (isClosedPipeError(error)) return;
      settle(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settle(new WorkflowInputError("Bun workflow exited without producing a result"));
        return;
      }
      const detail = stderrBuffer.trim() || `exit code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}`;
      settle(new WorkflowInputError(`Bun workflow failed: ${detail}`));
    });

    child.stdout.on("data", (chunk: string) => {
      armIdleTimer();
      if (settled) return;
      stdoutBuffer += chunk;
      let index: number;
      while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        handleChildStdoutLine(child, line, options, settle, requestHooks);
        if (settled) return;
      }
      // Bound the partial-line accumulator: the child runs unrestricted user code, so a single giant
      // no-newline line would OOM the parent. (The backend runners bound theirs; the workflow child did not.)
      if (stdoutBuffer.length > MAX_CHILD_STDOUT_LINE_BYTES) {
        settle(
          new WorkflowInputError(
            `Bun workflow emitted over ${MAX_CHILD_STDOUT_LINE_BYTES} bytes on one line without a newline; aborting to avoid unbounded memory growth.`,
          ),
        );
      }
    });

    child.stderr.on("data", (text: string) => {
      armIdleTimer();
      // Keep only a bounded tail for the failure message; chatty stderr must not grow without limit.
      stderrBuffer = (stderrBuffer + text).slice(-MAX_CHILD_STDERR_TAIL_BYTES);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) options.emitLog(`[stderr] ${line}`);
      }
    });
  });
}

function handleChildStdoutLine(
  child: ChildProcessWithoutNullStreams,
  line: string,
  options: BunChildOptions,
  settle: (error: unknown, value?: unknown) => void,
  requestHooks: BunChildRequestHooks,
): void {
  if (!line.startsWith(IPC_PREFIX)) {
    if (line.trim()) options.emitLog(line);
    return;
  }

  let message: ChildMessage;
  try {
    message = JSON.parse(line.slice(IPC_PREFIX.length)) as ChildMessage;
  } catch (error) {
    settle(new WorkflowInputError(`Invalid Bun workflow IPC message: ${errorMessage(error)}`));
    return;
  }

  if (message.kind === "event") {
    if (message.type === "phase") options.recordPhase(message.payload.title);
    else if (message.type === "log") options.emitLog(message.payload.message);
    return;
  }

  if (message.kind === "request") {
    if (message.type === "agent") {
      requestHooks.requestStarted();
      options
        .runAgent(message.payload.prompt, message.payload.options)
        .then((value) => sendChildResponse(child, message.id, value, undefined, options.spent()))
        // Any runAgent rejection is a hard-fail (cap/budget/abort/provider-resolution): ordinary agent
        // failures resolve to null. Tag it `fatal` so parallel()/pipeline() rethrow instead of null-ing it.
        .catch((error) => sendChildResponse(child, message.id, undefined, error, options.spent(), true))
        .finally(requestHooks.requestSettled);
      return;
    }
    if (message.type === "workflow") {
      const callerDepth = typeof message.payload.depth === "number" ? message.payload.depth : 0;
      requestHooks.requestStarted();
      options
        .runNestedWorkflow(message.payload.nameOrRef, message.payload.args, callerDepth)
        .then((value) => sendChildResponse(child, message.id, value, undefined, options.spent()))
        .catch((error) => sendChildResponse(child, message.id, undefined, error, options.spent(), true))
        .finally(requestHooks.requestSettled);
      return;
    }
    sendChildResponse(child, message.id, undefined, new WorkflowInputError(`Unknown workflow request: ${message.type}`), options.spent(), true);
    return;
  }

  if (message.kind === "result") {
    settle(undefined, message.value);
    return;
  }

  if (message.kind === "error") {
    const error = new WorkflowInputError(message.error.message);
    if (message.error.stack) error.stack = message.error.stack;
    settle(error);
  }
}

function sendChildResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  value: unknown,
  error?: unknown,
  spent?: number,
  fatal?: boolean,
): void {
  const message = error
    ? { kind: "response", id, error: { message: errorMessage(error), ...(fatal ? { fatal: true } : {}) }, spent }
    : { kind: "response", id, value, spent };
  // The child may have already exited (e.g. fire-and-forget agent() left in flight); guard the write.
  if (child.killed || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed || child.stdin.writableEnded || !child.stdin.writable) return;
  try {
    child.stdin.write(`${IPC_PREFIX}${JSON.stringify(message)}\n`, (writeError) => {
      if (writeError && !isClosedPipeError(writeError)) child.emit("error", writeError);
    });
  } catch {
    // Child gone; nothing to deliver to.
  }
}

function isClosedPipeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
}

function normalizeAgentOptions(value: unknown): WorkflowAgentOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as WorkflowAgentOptions;
  const normalized: WorkflowAgentOptions = { ...options };
  setOptionalString(normalized, "label", options.label, "agent label");
  setOptionalString(normalized, "phase", options.phase, "agent phase");
  setOptionalString(normalized, "model", options.model, "agent model");
  setOptionalString(normalized, "provider", options.provider, "agent provider");
  setOptionalString(normalized, "isolation", options.isolation, "agent isolation");
  setOptionalString(normalized, "agentType", options.agentType, "agent type");
  return normalized;
}

function normalizeAgentResult(result: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema) return result;
  if (result === null) return null;
  const value = typeof result === "string" ? parseJsonResult(result) : result;
  const normalized = stripNullOptionalFields(value, schema);
  const validate = ajv.compile(schema);
  if (!validate(normalized)) {
    throw new WorkflowInputError(`StructuredOutput validation failure: ${ajv.errorsText(validate.errors)}`);
  }
  return normalized;
}

function stripNullOptionalFields(value: unknown, schema: JsonSchema): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    const itemSchema = !Array.isArray(schema.items) ? schema.items : undefined;
    if (!itemSchema) return value;
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripNullOptionalFields(item, itemSchema);
      if (stripped !== item) changed = true;
      return stripped;
    });
    return changed ? next : value;
  }

  if (typeof value !== "object") return value;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return value;

  const input = value as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let output: Record<string, unknown> | undefined;

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in input)) continue;
    const propertyValue = input[key];
    if (propertyValue === null && !required.has(key)) {
      output ??= { ...input };
      delete output[key];
      continue;
    }
    const stripped = stripNullOptionalFields(propertyValue, propertySchema);
    if (stripped !== propertyValue) {
      output ??= { ...input };
      output[key] = stripped;
    }
  }

  return output ?? value;
}

function parseJsonResult(text: string): unknown {
  try {
    return JSON.parse(stripJsonFences(text));
  } catch {
    throw new WorkflowInputError("agent({schema}) completed without JSON structured output");
  }
}

/** Strips a leading/trailing Markdown code fence (```json ... ```), tolerating chatty models. */
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
}

function resolveConcurrency(requested: number | undefined): number {
  const cpuBased = Math.max(1, (os.cpus()?.length ?? 4) - 2);
  const ceiling = Math.min(16, cpuBased);
  if (requested === undefined) return ceiling;
  return Math.max(1, Math.min(requested, 16));
}

function resolveWorkflowIdleTimeout(requested: number | null | undefined): number | null {
  if (requested === null) return null;
  if (requested === undefined) return DEFAULT_WORKFLOW_IDLE_TIMEOUT_MS;
  if (requested <= 0) return null;
  return requested;
}

function normalizeBunSpawnError(error: Error, bunPath: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new WorkflowInputError(
      `Bun runtime not found at "${bunPath}". Install Bun, add it to PATH, or pass --bun <path> / bunPath in the library API.`,
    );
  }
  return error;
}

function phaseModelMap(meta: WorkflowMeta): Record<string, string> {
  const models: Record<string, string> = {};
  for (const phase of meta.phases ?? []) {
    if (phase.model !== undefined) models[phase.title] = phase.model;
  }
  return models;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function toWorkflowRef(value: unknown): WorkflowRef {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { scriptPath?: unknown }).scriptPath === "string") {
    return { scriptPath: (value as { scriptPath: string }).scriptPath };
  }
  throw new WorkflowInputError('workflow() expects a name string or { scriptPath: "..." }');
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function setOptionalString<T extends WorkflowAgentOptions, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  name: string,
): void {
  if (value === undefined) delete target[key];
  else target[key] = requireString(value, name) as T[K];
}

function withAgentIdentity(
  options: WorkflowAgentOptions,
  label: string,
  phase: string | undefined,
): WorkflowAgentOptions {
  return {
    ...options,
    label,
    ...(phase !== undefined ? { phase } : {}),
  };
}

function omitKey<T extends object, K extends keyof T>(source: T, key: K): T {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

function agentProgress(
  label: string,
  phase: string | undefined,
  state: "started" | "completed" | "cached" | "failed" | "skipped",
  extra: Record<string, unknown> = {},
) {
  return {
    type: "agent" as const,
    label,
    state,
    ...(phase !== undefined ? { phase } : {}),
    ...extra,
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

/** Exponential backoff between agent retries, capped at 5s. */
function retryBackoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 5000);
}

/** Resolves after `ms`, or early if `signal` aborts (the loop re-checks abort on the next pass). */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function remainingBudget(tokenBudget: number, state: RuntimeState): number {
  return Math.max(0, tokenBudget - state.spent);
}

function cryptoRandomId(): string {
  return randomUUID().slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
