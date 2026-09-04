# multi-agent-workflow

End-to-end issue resolution as a deterministic, gate-driven codex-workflow. Reads an issue from GitHub or Linear, plans it adversarially, implements with TDD, runs lint/CI/E2E gates, audits the work, and opens a PR — with three human-approval checkpoints along the way.

## When to use

Reach for this when:

- You want one command to take an issue from "just opened" to "PR ready for review".
- You're okay with three human-approval gates (post-debrief, post-audit, pre-PR).
- You want a dedicated auditor agent (separate from the implementation reviewer) to verify DoD coverage, commit traceability, and scope honesty.
- You have a single issue per run; multi-issue parallelism comes from running multiple instances in parallel (e.g., in multiple Orca worktrees).

Skip this when:

- You need a fully autonomous loop with no human gates (this workflow deliberately blocks three times).
- The issue is a typo / docs fix / one-line change (overkill).
- You don't have a configured `minimax-default` provider in your `codex-workflow.config.ts` (see [SETUP.md](./SETUP.md)).

## What it does (10 phases, 3 gates)

| Phase | Agent | Purpose | Schema |
|---|---|---|---|
| 1. Debrief | `general-purpose` (provider: `minimax-default`) | Read issue → 3-level human narrative (Tese/Contexto/Imersão) with ASCII art. Save to `.multi-agent-workflow/debrief-<id>.md`. | `debriefPath`, `summary`, `approved` |
| **Gate 0** | human | Approve the debrief before planning starts. | — |
| 2. Plan Issue | `general-purpose` | Convert debrief into a structured plan with verifiable acceptance criteria. | `objective`, `scope`, `acceptanceCriteria[]`, `risks[]`, `dependencies[]`, `estimatedAgents` |
| 3. Review Plan | 2 parallel: `rgi-lens-scope`, `rgi-lens-dod-coverage` | Adversarial review of the issue plan. | `verdict`, `findings[]` |
| 4. Plan Implementation | `general-purpose` | File-by-file implementation plan with PR title/body/branch. | `filesToCreate[]`, `filesToModify[]`, `testFiles[]`, `prTitle`, `prBody`, `branchName` |
| 5. Review Impl Plan | 2 parallel: `rgi-lens-arch`, `rgi-lens-product` | Adversarial review of the implementation plan. | `verdict`, `findings[]` |
| 6. Implement + Unit Tests | `general-purpose` (worktree isolation) | TDD loop: test → implement → green. Commit per file. | `filesChanged[]`, `testResults`, `commits[]`, `summary` |
| 7. E2E Tests | `general-purpose` | Write Playwright specs, push branch, watch CI. | `testFiles[]`, `ciRunUrl`, `ciStatus` |
| 8. Lint + CI | `general-purpose` | Run lint, typecheck, architectural guardrails. Execute-only — no code changes. | `lintOk`, `typecheckOk`, `guardrailsOk`, `errors[]` |
| 9. Audit | `multi-agent-auditor` (dedicated) | Verify DoD coverage, commit traceability, scope honesty, ledger entry. | `verdict: pass\|warn\|fail`, `findings[]`, `ledgerEntryId` |
| **Gate 1** | human | Approve audit verdict (skip if pass, review if warn, block if fail). | — |
| 10. Commit + PR | `general-purpose` | Compose PR body (with audit section), HITL pre-PR gate, `gh pr create`. | `prUrl`, `prNumber`, `branchName`, `auditorVerdict` |
| **Gate 2** | human | Approve the PR body and branch before `gh pr create`. | — |

## How to run

```bash
bun codex-workflow run examples/multi-agent-workflow/workflow.js \
  --config examples/codex-workflow.config.ts \
  --args '{"tracker":"gh","issueId":123}'
```

`tracker` is `"gh"` (GitHub via `gh` CLI) or `"linear"` (Linear via GraphQL). `issueId` is the integer (GitHub) or alphanumeric identifier (Linear).

For multi-issue parallelism, run multiple instances concurrently in separate worktrees (typically via Orca Tasks UI — see [ORCA.md](./ORCA.md)).

## The seven subagents (vendored in [`agents/`](./agents/))

| Subagent | Used in | Purpose |
|---|---|---|
| `rgi-lens-arch` | Phase 5 | Architectural alignment: layering, primitive duplication, ADR compliance |
| `rgi-lens-product` | Phase 5 | Honest scope: no stubs/TODOs, PR body matches diff, no lies |
| `rgi-lens-scope` | Phase 3 | Scope clarity: ambiguous boundaries, divergent interpretations |
| `rgi-lens-dod-coverage` | Phase 3 | DoD verifiability: every acceptance criterion has a test |
| `rgi-lens-sec` | (available) | Security: secrets, egress, RBAC, cross-workspace leaks |
| `rgi-lens-test` | (available) | Test conformance: tautological tests, coverage, mocks of the function under test |
| `multi-agent-auditor` | Phase 9 | Meta-verification: DoD coverage, commit traceability, ledger entry |

`rgi-lens-arch`, `rgi-lens-product`, `rgi-lens-sec`, `rgi-lens-test` are reused from the four-lens pattern of `resolve-github-issues`. The other three (`scope`, `dod-coverage`, `auditor`) are new for this workflow.

To use these as Claude Code or OpenCode subagents, copy them to `~/.config/opencode/agents/`. The workflow calls them via the LLM (not as Claude Code subagents) — the `.md` files document the lens persona; the workflow invokes them by name.

## Constraints

- **One issue per run.** Multi-issue parallelism is achieved by running N instances in parallel (see ORCA.md).
- **Three human gates.** Phase 1 (debrief approval), Phase 9 (audit verdict), Phase 10 (pre-PR). All three are dual-mode: Orca gate UI when running inside an Orca-spawned TUI agent; TUI chat fallback otherwise.
- **Auditor verdict `fail` blocks the PR.** `pass` and `warn` continue; `warn` surfaces in the PR body for human review.
- **Code is original.** The structure is inspired by the small examples (`hello.js`, `complex-chain.js`), not by the larger reverse-engineered research notes (`deep-research.js`, `code-review.js`).

## See also

- [SETUP.md](./SETUP.md) — first-time setup (Bun, codex-workflow, pi-coding-agent, MiniMax provider).
- [ORCA.md](./ORCA.md) — running this inside Orca Tasks UI for single-issue and parallel multi-issue flows.
- [codex-workflow README](../../README.md) — upstream docs for the workflow runtime.