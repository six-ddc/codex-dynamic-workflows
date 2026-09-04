// examples/multi-agent-workflow/workflow.js
//
// Resolve a GitHub or Linear issue end-to-end with planning, review,
// implementation, tests, audit, and PR. Pairs with the seven subagents
// vendored under ./agents/ (rgi-lens-{arch,product,sec,test,scope,dod-coverage}
// plus multi-agent-auditor).
//
// Usage:
//   bun codex-workflow run examples/multi-agent-workflow/workflow.js \
//     --config examples/codex-workflow.config.ts \
//     --args '{"tracker":"gh","issueId":123}'
//
// Tracker values: "gh" (GitHub via `gh` CLI) or "linear" (Linear via GraphQL).
//
// Required provider in --config: "minimax-default" — see SETUP.md for the
// provider block. Falls back to --config.default if not present.

export const meta = {
  name: 'multi-agent-workflow',
  description: 'End-to-end issue resolution: plan, adversarial review, implement, tests, audit, PR. Includes three human-approval gates.',
  whenToUse: 'Use when you want a structured, deterministic 10-phase pipeline that resolves a single issue with explicit human gates and a dedicated auditor. Pairs with ./agents/.',
  phases: [
    { title: 'Debrief' },
    { title: 'Plan Issue' },
    { title: 'Review Plan' },
    { title: 'Plan Implementation' },
    { title: 'Review Implementation Plan' },
    { title: 'Implement + Unit Tests' },
    { title: 'E2E Tests' },
    { title: 'Lint + CI' },
    { title: 'Audit' },
    { title: 'Commit + PR' },
  ],
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['approved', 'needs-work'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'text'],
        properties: {
          severity: { type: 'string', enum: ['low', 'med', 'high'] },
          text: { type: 'string' },
        },
      },
    },
  },
}

const tracker = (args && args.tracker) || 'gh'
const issueId = args && args.issueId
if (!issueId) {
  throw new Error('Missing required arg: issueId (provide --args \'{"tracker":"gh","issueId":123}\')')
}

phase('Debrief')
const debrief = await agent(
  `Read issue ${tracker === 'gh' ? '#' : ''}${issueId} from ${tracker === 'gh' ? 'GitHub via \`gh issue view ${issueId}\`' : 'Linear via the Linear GraphQL API (issue id ${issueId})'}.

Produce a 3-level narrative translation for a human who has never seen the codebase:
- Tese: one paragraph — the why, the pain, the affected user
- Contexto: 3-6 bullets — what's in scope, what's out, what the deliverable looks like
- Imersão: full detail — packages touched, lifecycle, risks, dependencies

Constraints:
- Talk like a human to a human. NO references to ADR-XXXX, internal file paths, or LLM-optimized jargon.
- Use ASCII art (boxes with ─ │ ┌ ┐ └ ┘ ──▶) for visual concepts wherever possible.
- Save the full debrief to .multi-agent-workflow/debrief-${issueId}.md (gitignored).
- Post a short skeleton comment back on the issue linking the local file.
- Block at a human-approval gate: do not proceed until the human explicitly approves via Orca gate UI OR types approval in the TUI chat.

Return { debriefPath, summary, approved: true } when approved. Return { approved: false } if still waiting.`,
  {
    label: 'debrief',
    provider: 'minimax-default',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['debriefPath', 'summary', 'approved'],
      properties: {
        debriefPath: { type: 'string' },
        summary: { type: 'string' },
        approved: { type: 'boolean' },
      },
    },
  },
)
if (!debrief.approved) {
  throw new Error('Debrief not approved by human gate — workflow blocked.')
}

phase('Plan Issue')
const plan = await agent(
  `Read ${debrief.debriefPath} and produce a structured implementation plan as JSON: { objective, scope, acceptanceCriteria[], risks[], dependencies[], estimatedAgents }. Each acceptanceCriterion must be verifiable (a test or manual check could prove it). estimatedAgents is an integer hint for the implementation agent about how many parallel coding tasks to expect.`,
  {
    label: 'plan-issue',
    provider: 'minimax-default',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['objective', 'scope', 'acceptanceCriteria', 'risks', 'dependencies', 'estimatedAgents'],
      properties: {
        objective: { type: 'string' },
        scope: { type: 'string' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
        dependencies: { type: 'array', items: { type: 'string' } },
        estimatedAgents: { type: 'number' },
      },
    },
  },
)

phase('Review Plan')
const planReviews = await parallel([
  () => agent(
    `Review this issue plan for scope clarity: ${JSON.stringify(plan)}.

Lens (./agents/rgi-lens-scope.md): Is the scope well-defined? Are there ambiguous boundaries between in-scope and out-of-scope? Could two reasonable engineers interpret the scope differently?

Return { verdict, findings } where severity is high if the ambiguity could cause an implementation to diverge from intent.`,
    { label: 'review-scope', provider: 'minimax-default', schema: REVIEW_SCHEMA },
  ),
  () => agent(
    `Review this issue plan for DoD coverage: ${JSON.stringify(plan)}.

Lens (./agents/rgi-lens-dod-coverage.md): For each acceptanceCriterion, can a future test verify it? Are any criteria unmeasurable ("code is clean", "feels right")? Are any testable behaviors missing?

Return { verdict, findings } where severity is high if a critical acceptance criterion is unmeasurable.`,
    { label: 'review-dod', provider: 'minimax-default', schema: REVIEW_SCHEMA },
  ),
])
const planBlocked = planReviews.some(
  (r) => r.verdict === 'needs-work' && r.findings.some((f) => f.severity === 'high'),
)
if (planBlocked) {
  throw new Error(`Plan review blocked by high-severity findings: ${JSON.stringify(planReviews)}`)
}

phase('Plan Implementation')
const implPlan = await agent(
  `Convert this issue plan: ${JSON.stringify(plan)} into a file-by-file implementation plan: { filesToCreate: [{path, purpose, estLines}], filesToModify: [{path, changes, estLines}], testFiles: [{path, framework, testCount}], prTitle, prBody, branchName }.

Constraints:
- branchName must follow the repo's convention (usually fix/<id>-<slug> or feat/<id>-<slug>).
- prTitle format: "<type>(<scope>): <imperative summary> (#<issueId>)".
- prBody must include: Summary (1-3 bullets), Test Plan (how the human reviewer verifies), DoD Checklist (mapped to plan.acceptanceCriteria), Resolves #<issueId>.
- Respect existing layers: do not duplicate primitives from upstream dependencies; if a primitive exists in @scope/X, reuse it.
- estLines is a rough estimate for the implementer (10/50/200/500 buckets are fine).`,
  {
    label: 'plan-impl',
    provider: 'minimax-default',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['filesToCreate', 'filesToModify', 'testFiles', 'prTitle', 'prBody', 'branchName'],
      properties: {
        filesToCreate: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'purpose'],
            properties: {
              path: { type: 'string' },
              purpose: { type: 'string' },
              estLines: { type: 'number' },
            },
          },
        },
        filesToModify: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'changes'],
            properties: {
              path: { type: 'string' },
              changes: { type: 'string' },
              estLines: { type: 'number' },
            },
          },
        },
        testFiles: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'framework'],
            properties: {
              path: { type: 'string' },
              framework: { type: 'string' },
              testCount: { type: 'number' },
            },
          },
        },
        prTitle: { type: 'string' },
        prBody: { type: 'string' },
        branchName: { type: 'string' },
      },
    },
  },
)

phase('Review Implementation Plan')
const implReviews = await parallel([
  () => agent(
    `Review this implementation plan for architectural alignment: ${JSON.stringify(implPlan)}.

Lens (./agents/rgi-lens-arch.md): Does it follow existing patterns in the repo? Does it duplicate any primitive from upstream dependencies? Does it respect the ADR-XXXX layering rules? Are AgentsKitError subtypes (with AK_* codes) used at boundaries instead of throw new Error?

Return { verdict, findings } where severity is high if it duplicates a primitive or violates a hard ADR.`,
    { label: 'review-arch', provider: 'minimax-default', schema: REVIEW_SCHEMA },
  ),
  () => agent(
    `Review this implementation plan for honest scope: ${JSON.stringify(implPlan)}.

Lens (./agents/rgi-lens-product.md): Does it cut scope appropriately? Are there TODOs or stubs masquerading as complete work? Does the PR body match the actual changes? Does any acceptanceCriterion become unmeasurable in the implementation?

Return { verdict, findings } where severity is high if any deliverable is a stub/TODO or the PR body lies about scope.`,
    { label: 'review-product', provider: 'minimax-default', schema: REVIEW_SCHEMA },
  ),
])
const implBlocked = implReviews.some(
  (r) => r.verdict === 'needs-work' && r.findings.some((f) => f.severity === 'high'),
)
if (implBlocked) {
  throw new Error(`Implementation-plan review blocked: ${JSON.stringify(implReviews)}`)
}

phase('Implement + Unit Tests')
const implResult = await agent(
  `Implement this plan in a TDD loop: ${JSON.stringify(implPlan)}.

Steps:
1. Create the worktree if not already in one (Orca handles this; if standalone, \`git worktree add\` for impl/${implPlan.branchName}).
2. For each file in implPlan.filesToCreate and implPlan.filesToModify:
   a. Read the existing file (if modifying) — match style, types, naming.
   b. Write the test FIRST (red). Run it; confirm it fails for the right reason.
   c. Implement (green). Run the test; confirm it passes.
   d. Refactor if needed; tests still green.
3. After all files: \`pnpm --filter <affected-pkg> test\` for the touched packages. All green.
4. \`pnpm --filter <affected-pkg> build\` to confirm d.ts and ESM/CJS bundles are emitted.
5. Commit with message referencing the issue: \`git commit -m "<type>(<scope>): <summary> (#${issueId})\\n\\nResolves #${issueId}"\`.

Return { filesChanged, testResults, commits, summary } where commits is the list of commit SHAs.`,
  {
    label: 'impl-unit',
    provider: 'minimax-default',
    isolation: 'worktree',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['filesChanged', 'testResults', 'commits', 'summary'],
      properties: {
        filesChanged: { type: 'array', items: { type: 'string' } },
        testResults: { type: 'string' },
        commits: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
    },
  },
)

phase('E2E Tests')
const e2eResult = await agent(
  `Write Playwright E2E tests for the new behavior described in ${debrief.debriefPath}.

Steps:
1. Identify which user-visible flows the issue affects.
2. Author \`tests/e2e-playwright/<flow-name>.spec.ts\` covering each flow (happy path + 1 negative).
3. \`git push origin ${implPlan.branchName}\` to push the branch.
4. Trigger CI: \`gh workflow run e2e-pr-smoke.yml --ref ${implPlan.branchName}\` OR \`gh run watch <runId>\` if push auto-triggered.
5. Wait for CI to complete. Capture the run URL.
6. If tests pass, return ciStatus:'pass'. If fail, return ciStatus:'fail' with the failing test names.

Return { testFiles, ciRunUrl, ciStatus, summary }.`,
  {
    label: 'e2e-tests',
    provider: 'minimax-default',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['testFiles', 'ciRunUrl', 'ciStatus', 'summary'],
      properties: {
        testFiles: { type: 'array', items: { type: 'string' } },
        ciRunUrl: { type: 'string' },
        ciStatus: { type: 'string', enum: ['pass', 'fail', 'pending'] },
        summary: { type: 'string' },
      },
    },
  },
)
if (e2eResult.ciStatus !== 'pass') {
  throw new Error(`E2E tests failed in CI: ${e2eResult.ciRunUrl}`)
}

phase('Lint + CI')
const lintResult = await agent(
  `Run lint, typecheck, and architectural guardrails on the touched files. EXECUTE ONLY — do not modify code, do not add new check scripts.

Run in sequence:
- \`pnpm --filter <affected-pkg> lint\`
- \`pnpm --filter <affected-pkg> typecheck\` (or \`pnpm check:typecheck\`)
- \`pnpm check:layers\`
- \`pnpm check:no-raw-error\`
- \`pnpm check:no-duplicate-agentskit\`
- \`pnpm check:api-surface\`

For each, capture pass/fail and the first 3 error lines if fail.

Return { lintOk, typecheckOk, guardrailsOk, errors[] } where errors is the concatenated first-lines of failures.`,
  {
    label: 'lint-ci',
    provider: 'minimax-default',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['lintOk', 'typecheckOk', 'guardrailsOk', 'errors'],
      properties: {
        lintOk: { type: 'boolean' },
        typecheckOk: { type: 'boolean' },
        guardrailsOk: { type: 'boolean' },
        errors: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)
if (!lintResult.lintOk || !lintResult.typecheckOk || !lintResult.guardrailsOk) {
  throw new Error(`Lint/CI failed: ${JSON.stringify(lintResult.errors)}`)
}

phase('Audit')
const audit = await agent(
  `Audit the implementation end-to-end as the dedicated auditor.

Verify (./agents/multi-agent-auditor.md persona):
1. Each acceptanceCriterion from plan has a verifying test that would fail if the criterion were violated. Look at implPlan.testFiles and the actual test code in implResult.filesChanged.
2. All commits in implResult.commits trace back to the plan — no out-of-scope changes.
3. CI is green (e2eResult.ciStatus === 'pass').
4. PR body (implPlan.prBody) matches the actual diff scope — no lies.
5. No secrets in the diff, no console.log left behind, no commented-out code blocks.

Append an audit-ledger entry via os-audit appendAuditLedgerEntry with category:'multi-agent-workflow.audit', verdict, findings, runId.

Return { verdict: 'pass' | 'warn' | 'fail', findings, ledgerEntryId, summary }.`,
  {
    label: 'audit',
    provider: 'minimax-default',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'findings', 'ledgerEntryId', 'summary'],
      properties: {
        verdict: { type: 'string', enum: ['pass', 'warn', 'fail'] },
        findings: { type: 'array', items: { type: 'string' } },
        ledgerEntryId: { type: 'string' },
        summary: { type: 'string' },
      },
    },
  },
)
if (audit.verdict === 'fail') {
  throw new Error(`Auditor blocked PR: ${audit.findings.join('; ')}`)
}

phase('Commit + PR')
const pr = await agent(
  `Open the pull request with a HITL pre-PR gate.

Steps:
1. Confirm branch ${implPlan.branchName} is pushed and CI is green.
2. Compose final PR title and body:
   - title = implPlan.prTitle
   - body = implPlan.prBody + audit section ("Auditor verdict: ${audit.verdict} — ${audit.summary}")
3. Block at HITL gate: do NOT call gh pr create yet. Surface the title+body via an Orca gate-create OR via TUI chat asking the human to approve. Wait for explicit approval.
4. When approved, run \`gh pr create --title "<title>" --body "<body>" --base main\` (or whatever the repo's default branch is).
5. Return the PR URL and number.

Return { prUrl, prNumber, branchName, auditorVerdict: '${audit.verdict}' }.`,
  {
    label: 'commit-pr',
    provider: 'minimax-default',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['prUrl', 'prNumber', 'branchName', 'auditorVerdict'],
      properties: {
        prUrl: { type: 'string' },
        prNumber: { type: 'number' },
        branchName: { type: 'string' },
        auditorVerdict: { type: 'string' },
      },
    },
  },
)

return {
  issue: `${tracker}:${issueId}`,
  debriefPath: debrief.debriefPath,
  plan,
  planReviews,
  implPlan,
  implReviews,
  implResult,
  e2eResult,
  lintResult,
  audit,
  pr,
}