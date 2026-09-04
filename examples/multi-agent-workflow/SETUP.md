# SETUP — First-time configuration for multi-agent-workflow

This guide walks you through installing everything `multi-agent-workflow` needs on a fresh machine. If you already have Bun, codex-workflow, and pi-coding-agent installed, jump to [Step 4: Add the MiniMax provider](#step-4-add-the-minimax-provider).

Time: ~10 minutes.

## Prerequisites

- macOS, Linux, or Windows (PowerShell 5.1+)
- A MiniMax API key (get one at <https://platform.minimax.io/user-center/payment/token-plan>)
- A GitHub personal access token with `repo` scope (for `gh` CLI auth)
- (Optional) A Linear API key if you'll use `tracker: "linear"`

## Step 1: Install Bun

codex-workflow runs scripts under Bun.

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
exec $SHELL -l  # reload shell to pick up PATH

# Windows (PowerShell)
irm bun.sh/install.ps1 | iex
# Restart PowerShell after install

bun --version  # 1.4.0+
```

## Step 2: Install codex-workflow

```bash
# Global install (works from any project)
npm install -g github:six-ddc/codex-dynamic-workflows

# Verify
codex-workflow --version
codex-workflow doctor  # checks Bun, provider config, codex CLI presence
```

If `codex-workflow` is not found in your shell, ensure your npm global bin is on `PATH`:

```bash
# Get the global bin path
npm config get prefix
# Add <prefix>/bin (Unix) or <prefix> (Windows) to your PATH
```

## Step 3: Install pi-coding-agent

The `pi` backend is the only one in codex-workflow that talks to OpenAI-compatible / Anthropic-compatible endpoints via `baseUrl` + `apiKeyEnv`. We use it to reach MiniMax.

```bash
npm install -g @earendil-works/pi-coding-agent

# Verify
pi --version
```

## Step 4: Add the MiniMax provider

`multi-agent-workflow` calls agents with `provider: "minimax-default"`. You need to register that provider in your `codex-workflow.config.ts`.

### Where to put the config

Three options, in order of preference:

1. **Project root** (recommended): `<your-project>/codex-workflow.config.ts`
2. **Per-example**: `examples/codex-workflow.config.ts` (vendored in the upstream repo, do not modify upstream — copy it locally instead)
3. **Pass via `--config`** every invocation: `bun codex-workflow run ... --config /path/to/config.ts`

### The provider block

Add this to your `codex-workflow.config.ts` (do not edit the upstream `examples/codex-workflow.config.ts` directly — copy it first):

```ts
export default {
  providers: {
    // ... existing providers (codex-default, claude-smart, gemini-pro, etc.) ...

    'minimax-default': {
      backend: 'pi',
      baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io',
      api: 'openai-completions',
      piProvider: 'openai',
      model: 'MiniMax-M3',
      models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'],
      apiKeyEnv: 'MINIMAX_API_KEY',
      thinking: 'high',
      contextFiles: true,
    },
  },
  default: 'minimax-default',  // or keep your existing default
}
```

### Why `pi` and not a new backend?

`pi` is the canonical codex-workflow backend for any OpenAI/Anthropic-compatible HTTP endpoint. MiniMax exposes both `/v1` (OpenAI shape) and `/anthropic` (Anthropic shape); we use OpenAI-completions for broadest compatibility. The runner reads `MINIMAX_API_KEY` from your env at build time and never writes it to disk.

If you prefer Anthropic shape, change `api: 'openai-completions'` to `api: 'anthropic-messages'`. The `models` list and `baseUrl` stay the same.

## Step 5: Set environment variables

```bash
# Required
export MINIMAX_API_KEY="sk-cp-..."     # your MiniMax token-plan key

# Required for tracker: "gh"
gh auth login                          # one-time, opens browser

# Optional for tracker: "linear"
export LINEAR_API_KEY="lin_api_..."

# Optional — useful for debugging
export CODEX_WORKFLOW_HOME="$HOME/.codex-workflow"   # default location
```

### Windows PowerShell (persistent)

```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_API_KEY", "sk-cp-...", "User")
[Environment]::SetEnvironmentVariable("LINEAR_API_KEY", "lin_api_...", "User")  # if using Linear
# Restart PowerShell to pick up User-level vars
```

## Step 6: Validate the setup

Run a no-cost dry-run:

```bash
CODEX_WORKFLOW_FAKE_AGENT=1 bun codex-workflow run \
  examples/multi-agent-workflow/workflow.js \
  --config examples/codex-workflow.config.ts \
  --args '{"tracker":"gh","issueId":123}' \
  --json
```

Expected output:
- All 10 phases parse
- `agent debrief` will fail with `StructuredOutput validation failure` (fake agent doesn't return schema-valid objects — this is expected)
- The failure is at Phase 1 (Debrief), not at parse time — that means the workflow is valid

### Real-provider smoke test

```bash
bun codex-workflow run \
  examples/multi-agent-workflow/workflow.js \
  --config examples/codex-workflow.config.ts \
  --args '{"tracker":"gh","issueId":0}'
```

(`issueId: 0` is invalid for GitHub but exercises the full schema validation path against the real MiniMax provider — you'll see a real LLM error from Agent 1 about an invalid issue number.)

## Step 7: Run for real

```bash
bun codex-workflow run \
  examples/multi-agent-workflow/workflow.js \
  --config examples/codex-workflow.config.ts \
  --args '{"tracker":"gh","issueId":<your-issue-id>}'
```

You'll hit Gate 0 (debrief approval) first. Approve via:
- **Orca Tasks UI**: open the gate, click "yes"
- **TUI chat fallback**: type `pode prosseguir` (or `ok`, `vai`, `segue`, `bora`) into the agent prompt

See [ORCA.md](./ORCA.md) for the full Orca flow and parallel multi-issue usage.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `bun: command not found` | Bun not on PATH | Re-run installer, restart shell |
| `codex-workflow: command not found` | npm global bin not on PATH | Run `npm config get prefix`, add `bin` to PATH |
| `spawn EINVAL` on Windows | codex-workflow Node trying to spawn `pi.cmd` | Use `bun codex-workflow run` instead of `node` — Bun handles `.cmd` correctly |
| `provider "minimax-default" not found in config` | Provider block missing | Add the block from [Step 4](#step-4-add-the-minimax-provider) to your `codex-workflow.config.ts` |
| `MINIMAX_API_KEY is not set` | Env var not loaded | Restart shell, or check `[Environment]::GetEnvironmentVariable("MINIMAX_API_KEY", "User")` (Windows) |
| `gh auth status` fails | GitHub CLI not authenticated | Run `gh auth login` |
| Workflow hangs at Gate 0 | No human in the loop | Approve via Orca UI or TUI chat; the gate is intentional, not a bug |
| Auditor returns `verdict: "fail"` | Scope/DoD violation | Read `audit.findings[]`, fix the underlying issue, re-run the workflow from phase 9 (or from scratch) |
| Run fails mid-way | Transient provider error | `codex-workflow resume <runId>` — replays cached agents and re-executes failed ones |

## Next steps

- Read [ORCA.md](./ORCA.md) for the Orca Tasks UI flow (single-issue + parallel multi-issue).
- Read the [main README](./README.md) for an overview of phases and gates.
- Subscribe to issues at <https://github.com/six-ddc/codex-dynamic-workflows/issues> for updates to the runtime.