# ORCA — Running multi-agent-workflow inside Orca Orchestrator

This guide is for using `multi-agent-workflow` as the agent inside an Orca-spawned TUI terminal. Orca handles worktree creation, TUI agent lifecycle, and parallel pane management; the workflow handles the deterministic multi-agent pipeline.

## TL;DR

```
1. Open Orca desktop
2. Go to Tasks
3. Find the GitHub/Linear task you want to resolve
4. Click "Start"
5. In the new TUI agent pane, run:
   /multi-agent-workflow gh:123
6. Approve gates as they appear (Orca UI or TUI chat)
7. Repeat for other issues in parallel panes
```

`/multi-agent-workflow` is not a real slash command — it's the convention for what you type into the TUI agent's prompt. What actually runs is `bun codex-workflow run examples/multi-agent-workflow/workflow.js --args '{"tracker":"gh","issueId":123}'`. The slash convention makes the intent clear.

## Prerequisites

- Orca desktop app installed and running (Electron app from <https://orca.so> or local build)
- `orca` CLI on PATH (usually `C:\Users\<you>\AppData\Local\Programs\orca\resources\bin\orca.exe`)
- A repo registered with Orca (see [Step 1: Register your repo](#step-1-register-your-repo))
- The full setup from [SETUP.md](./SETUP.md) done

## Step 1: Register your repo

Once per repo:

```bash
cd ~/code/my-project
orca repo add . --display-name my-project
```

Verify:

```bash
orca repo list --json
```

You should see your repo with an id (a UUID). You'll reference it in worktree commands (Orca usually resolves by name so you rarely need the UUID directly).

## Step 2: Single-issue flow (happy path)

### 2.1. Find the task

In the Orca desktop app:
- Sidebar → **Tasks**
- Locate the GitHub or Linear task you want to resolve
- Filters by label / milestone / assignee work as expected
- Click the task to see its detail panel (description, comments, linked PRs)

### 2.2. Start the agent

In the task detail panel:
- Click the **Start** button (top-right of the panel)
- Orca creates a fresh worktree at `~/orca/workspaces/<repo>/<branch>/`
- Orca spawns a TUI agent (Claude Code or OpenCode-MiniMax, depending on your account settings) in a new pane/tab
- The agent opens with its default prompt

### 2.3. Invoke the workflow

In the TUI agent's prompt:

```
/multi-agent-workflow gh:123
```

(`123` is the GitHub issue number. Use `linear:ABC-456` for Linear issues.)

What happens under the hood:

1. The agent parses your slash command (or treats it as a literal prompt to follow)
2. The agent runs:
   ```
   bun codex-workflow run examples/multi-agent-workflow/workflow.js \
     --config examples/codex-workflow.config.ts \
     --args '{"tracker":"gh","issueId":123}'
   ```
3. The workflow begins Phase 1 (Debrief)

### 2.4. Wait for Gate 0 (Debrief approval)

The Debrief agent:
- Reads the issue via `gh issue view 123`
- Writes `.multi-agent-workflow/debrief-123.md` (gitignored, inside the worktree)
- Posts a skeleton comment back on the issue
- Surfaces an Orca gate: **"Approve debrief for issue #123?"**

Approve via either mode:

**Option A — Orca UI (recommended):**
- Switch back to the Orca Tasks view
- The gate appears as a card on the task
- Click **"yes"** (or any other option you defined)
- The workflow resumes automatically

**Option B — TUI chat fallback:**
- Stay in the TUI agent pane
- Type one of: `pode prosseguir`, `ok`, `vai`, `segue`, `bora`, `aprovado`, `pode`, `prossiga`
- The agent matches the keyword and the workflow resumes

### 2.5. Watch the workflow run

The workflow runs Phases 2 through 9 autonomously. You don't need to interact unless a gate appears or an agent returns `verdict: "needs-work"` with high-severity findings (which blocks the workflow with an error).

Progress visibility:
- **Orca Tasks view**: each phase shows as a subtask with status (planning / impl / tests / audit)
- **TUI agent pane**: codex-workflow prints live progress to stdout (phase markers, agent labels, retry counts)
- **GitHub**: comments on the issue (debrief skeleton, audit section on PR body)

### 2.6. Gate 1 (Audit verdict) and Gate 2 (Pre-PR)

After Phase 9 (Audit), the workflow surfaces **Gate 1**:
- Auditor verdict `pass` → no human action needed, workflow continues
- Auditor verdict `warn` → human reviews findings, decides to continue or block
- Auditor verdict `fail` → workflow blocks automatically (you must fix the underlying issue)

After Phase 10 (PR composition), the workflow surfaces **Gate 2** (HITL pre-PR):
- Shows the proposed PR title and body
- Human approves via Orca UI or TUI chat
- On approval: `gh pr create --fill` runs
- PR URL appears in Orca + TUI pane + GitHub

### 2.7. Result

Final output is in the TUI agent pane:

```
✓ multi-agent-workflow (wf_xxxxxxxx-xxxx) — 12 agents, 0 failed, 4m32s
{
  issue: "gh:123",
  debriefPath: ".multi-agent-workflow/debrief-123.md",
  plan: { ... },
  implPlan: { ... },
  implResult: { filesChanged: [...], commits: [...] },
  e2eResult: { ciStatus: "pass", ciRunUrl: "..." },
  lintResult: { lintOk: true, typecheckOk: true, guardrailsOk: true },
  audit: { verdict: "pass", ledgerEntryId: "..." },
  pr: { prUrl: "https://github.com/.../pull/456", prNumber: 456, branchName: "fix/123-..." }
}
```

## Step 3: Multi-issue parallel flow

This is where Orca shines. You can resolve N issues concurrently, each in its own worktree, each with its own codex-workflow run.

### 3.1. Start N agents

For each issue you want to resolve in parallel:

1. Go to **Tasks** in Orca
2. Click on the task
3. Click **Start**
4. Wait for the TUI agent to open
5. Type `/multi-agent-workflow gh:123` (or whatever the issue id is)

Don't wait for the first one to finish. Start the second one immediately, then the third, etc.

### 3.2. Monitor all in parallel

The Orca Tasks view shows all N tasks with their current phase status. Each pane has its own gate UI. You approve each gate independently.

You can switch between panes with Orca's pane switcher (usually `Cmd+K` / `Ctrl+K` or a sidebar tab list).

### 3.3. Concurrency limits

This machine (i7-11800H, 16 GB free RAM) comfortably handles:

- **3–5 parallel workflows** with full 10-phase execution: ~5–6 GB RAM, ~16 CPU threads saturated
- **6–10 parallel workflows**: monitor memory; if pages start, kill a few with `orca worker-stop`
- **11+ parallel workflows**: probable memory pressure; consider batching

If you hit limits, `codex-workflow runs` lists the active ones so you can identify and abandon the lowest-priority.

## Step 4: HITL gate dual mode

The three gates (post-debrief, post-audit, pre-PR) work in dual mode:

| Environment | Gate UI | Fallback |
|---|---|---|
| Inside an Orca TUI agent | Orca Tasks view gate card | TUI chat keyword |
| Standalone Claude Code / OpenCode (no Orca) | TUI chat keyword only | — |

The workflow detects Orca via the `ORCA_AGENT_HOOK_PORT` environment variable (set automatically by Orca when spawning a TUI agent). If detected, gates surface as Orca gate-create commands. If not, gates block on TUI chat input.

## Step 5: Monitoring and troubleshooting

### 5.1. Where to look

```bash
# codex-workflow runs (recent history)
codex-workflow runs --limit 20

# A specific run in detail
codex-workflow show <runId>

# Resume a failed run (replays cached agents, re-executes failed ones)
codex-workflow resume <runId>
```

### 5.2. Inside Orca

```bash
# All tasks and their statuses
orca task list --json

# Memory and CPU per pane
orca diagnostics memory --json

# Stop a runaway pane (kills its codex-workflow run)
orca worker-stop --handle <termHandle>
```

### 5.3. Common errors

| Error | Cause | Fix |
|---|---|---|
| `agent_unconfigured` | Tried `orca worker-start --terminal` for a bun pane | Use `orca terminal create --command "bun ..."` directly (the workflow handles this) |
| Gate never appears in Orca UI | TUI agent not running through Orca runtime (env var missing) | Verify with `echo $env:ORCA_AGENT_HOOK_PORT` in the TUI pane |
| `MINIMAX_API_KEY` is null inside the pane | Env var not inherited from parent shell | Either set as Windows User-level env var, or pass inline: `set MINIMAX_API_KEY=...&&bun ...` in the terminal command |
| `gh auth status` fails inside the pane | gh CLI not authenticated at the OS level | `gh auth login` outside Orca (persists globally) |
| Multiple panes hit the same issue | You clicked Start twice on the same task | Cancel one with `orca worker-stop --handle <handle>` |
| Auditor verdict `fail` blocks forever | Legitimate audit finding | Read `audit.findings[]`, fix the issue in the worktree, then `codex-workflow resume <runId>` from Phase 9 |

## Daily workflow (after first-time setup)

```
1. Open Orca
2. Tasks → pick an issue
3. Click Start → slash command in pane → approve gates
4. Repeat for other issues in parallel panes
5. Review PRs as they open
```

That's the whole loop. The rest of the workflow runs autonomously.