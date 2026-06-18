import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import type { AgentFailure } from "./types.js";
import type { WorkflowSourceKind } from "./workflow-tool.js";

export type RunRecordStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Runner configuration a run used. Persisted so `resume` reuses the same backend/model instead of
 * silently falling back to defaults (the journal cache key is NOT backend-aware, so resuming under a
 * different backend would mix results). Historical records omit it and are treated as the codex backend.
 */
export interface RunnerConfig {
  /** Agent backend, e.g. "codex", "gemini", or "pi". */
  backend: string;
  /** Model passed to the backend (runner/CLI `--model`), when set. */
  model?: string;
  /** Gemini CLI executable, when overridden (`--gemini-command`). */
  geminiCommand?: string;
  /** pi CLI executable, when overridden (`--pi-command`). */
  piCommand?: string;
  /** agy CLI executable, when overridden (`--agy-command`). */
  agyCommand?: string;
  /** Backend provider name (`--provider`), for the pi backend. */
  provider?: string;
  /** Custom OpenAI/Anthropic-compatible endpoint (`--base-url`), for the pi backend. */
  baseUrl?: string;
  /** Thinking level (`--thinking`), for the pi backend. NOTE: the API key is deliberately NOT persisted. */
  thinking?: string;
  /** Provider API shape (`--pi-api`), for the pi backend — must travel with `baseUrl` across resume. */
  piApi?: string;
  /** Tool allowlist (`--tools`, raw comma-separated string), for the pi backend. */
  tools?: string;
  /** Tool denylist (`--exclude-tools`, raw comma-separated string), for the pi backend. */
  excludeTools?: string;
  /** All tools disabled (`--no-tools`), for the pi backend. */
  noTools?: boolean;
}

export interface RunRecord {
  runId: string;
  name: string;
  description?: string;
  status: RunRecordStatus;
  source: WorkflowSourceKind;
  scriptPath?: string;
  /** Runner config this run used (backend/model/gemini-command) — lets `resume` reuse it. */
  runner?: RunnerConfig;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  agentCount?: number;
  cacheHits?: number;
  /** Count of agents that failed after exhausting retries. */
  failureCount?: number;
  /**
   * Detail of agents that failed after exhausting retries. Failed agents are deliberately NOT
   * journaled (so `--resume` re-attempts them), so this is the only place their detail is persisted —
   * promoted here from the in-memory run result so the viewer can render them as historical nodes.
   */
  failures?: AgentFailure[];
  /** Declared pipeline (meta.phases titles, in order) — the canonical phase order for the viewer. */
  declaredPhases?: string[];
  phases?: string[];
  logs?: string[];
  error?: string;
  /** The arguments passed into the workflow (the `args` value). Shown in the viewer. */
  args?: unknown;
  /** The workflow's final return value (what the script `return`ed). Shown in the viewer. */
  result?: unknown;
}

/**
 * Tiny file-backed history of workflow runs, one JSON document per run under `<dir>`. Powers the
 * CLI `runs` / `show` commands so completed runs can be browsed after the process exits.
 */
export class FileRunStore {
  constructor(private readonly dir: string) {}

  async save(record: RunRecord): Promise<void> {
    await atomicWriteFile(this.recordPath(record.runId), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** Merges a partial update into an existing record (no-op if the run is unknown). */
  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const existing = await this.get(runId);
    if (!existing) return;
    await this.save({ ...existing, ...patch });
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.recordPath(runId), "utf8")) as RunRecord;
    } catch {
      return undefined;
    }
  }

  /** Returns all records, newest first. */
  async list(): Promise<RunRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(this.dir, entry), "utf8")) as RunRecord);
      } catch {
        // Skip unreadable records.
      }
    }
    return records.sort((a, b) => b.startedAt - a.startedAt);
  }

  private recordPath(runId: string): string {
    return path.join(this.dir, `${sanitizeRunId(runId)}.json`);
  }
}

/** Maps a runId to a filesystem-safe basename, shared by the record file and its live-events file. */
export function sanitizeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
