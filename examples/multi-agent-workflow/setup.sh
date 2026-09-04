#!/usr/bin/env bash
# examples/multi-agent-workflow/setup.sh
#
# Idempotent first-time setup for multi-agent-workflow. Re-runnable; safe
# to run multiple times. Checks for required tools, installs missing ones,
# prompts for secrets, validates the result.
#
# Usage:
#   bash examples/multi-agent-workflow/setup.sh
#
# After running, follow ORCA.md for Orca integration or invoke the workflow
# directly:
#   bun codex-workflow run examples/multi-agent-workflow/workflow.js \
#     --config examples/codex-workflow.config.ts \
#     --args '{"tracker":"gh","issueId":123}'

set -euo pipefail

# Colors (no-op if stdout is not a TTY)
if [[ -t 1 ]]; then
  BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; RESET='\033[0m'
else
  BOLD=''; GREEN=''; YELLOW=''; RED=''; RESET=''
fi

step()   { printf "${BOLD}==> %s${RESET}\n" "$*"; }
ok()     { printf "${GREEN}✓ %s${RESET}\n" "$*"; }
warn()   { printf "${YELLOW}! %s${RESET}\n" "$*"; }
fail()   { printf "${RED}✗ %s${RESET}\n" "$*" >&2; exit 1; }

# --- Step 1: Bun ---
step "Checking for Bun"
if command -v bun >/dev/null 2>&1; then
  ok "Bun $(bun --version) already installed"
else
  warn "Bun not found — installing"
  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    fail "Auto-install not supported on Windows. Run: irm bun.sh/install.ps1 | iex"
  else
    curl -fsSL https://bun.sh/install | bash
    # shellcheck disable=SC1091
    source "${HOME}/.bun/bin/bun" 2>/dev/null || true
    export PATH="${HOME}/.bun/bin:${PATH}"
    command -v bun >/dev/null 2>&1 || fail "Bun install failed — see https://bun.sh"
    ok "Bun $(bun --version) installed"
  fi
fi

# --- Step 2: codex-workflow ---
step "Checking for codex-workflow"
if command -v codex-workflow >/dev/null 2>&1; then
  ok "codex-workflow $(codex-workflow --version) already installed"
else
  warn "codex-workflow not found — installing globally via npm"
  npm install -g github:six-ddc/codex-dynamic-workflows
  command -v codex-workflow >/dev/null 2>&1 || fail "codex-workflow install failed"
  ok "codex-workflow installed"
fi

# --- Step 3: pi-coding-agent ---
step "Checking for pi-coding-agent"
if command -v pi >/dev/null 2>&1; then
  ok "pi $(pi --version 2>/dev/null || echo 'unknown') already installed"
else
  warn "pi-coding-agent not found — installing globally via npm"
  npm install -g @earendil-works/pi-coding-agent
  command -v pi >/dev/null 2>&1 || fail "pi-coding-agent install failed"
  ok "pi-coding-agent installed"
fi

# --- Step 4: MINIMAX_API_KEY ---
step "Checking for MINIMAX_API_KEY"
if [[ -n "${MINIMAX_API_KEY:-}" ]]; then
  ok "MINIMAX_API_KEY already set (length: ${#MINIMAX_API_KEY})"
else
  warn "MINIMAX_API_KEY not set"
  printf "Get one at: https://platform.minimax.io/user-center/payment/token-plan\n"
  printf "Enter your MiniMax API key (input hidden): "
  read -rs MINIMAX_API_KEY
  echo
  [[ -z "$MINIMAX_API_KEY" ]] && fail "MINIMAX_API_KEY cannot be empty"

  if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    # PowerShell persistent set
    powershell.exe -NoProfile -Command "[Environment]::SetEnvironmentVariable('MINIMAX_API_KEY', '$MINIMAX_API_KEY', 'User')"
    ok "MINIMAX_API_KEY set as User-level env var (restart shell to pick up)"
  else
    # Persist to ~/.bashrc and/or ~/.zshrc
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      if [[ -f "$rc" ]]; then
        grep -q "MINIMAX_API_KEY" "$rc" 2>/dev/null || \
          printf '\n# MiniMax API key for codex-workflow multi-agent-workflow\nexport MINIMAX_API_KEY="%s"\n' "$MINIMAX_API_KEY" >> "$rc"
      fi
    done
    export MINIMAX_API_KEY
    ok "MINIMAX_API_KEY set in shell rc files"
  fi
fi

# --- Step 5: GitHub CLI auth (only needed for tracker: "gh") ---
step "Checking GitHub CLI auth (only required for tracker=gh)"
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    ok "gh authenticated: $(gh auth status 2>&1 | grep -i 'account' | head -1)"
  else
    warn "gh not authenticated"
    printf "Run: gh auth login\n"
  fi
else
  warn "gh CLI not installed (https://cli.github.com)"
fi

# --- Step 6: Linear API key (only needed for tracker: "linear") ---
step "Checking for LINEAR_API_KEY (only required for tracker=linear)"
if [[ -n "${LINEAR_API_KEY:-}" ]]; then
  ok "LINEAR_API_KEY already set"
else
  printf "Enter your Linear API key (or press Enter to skip): "
  read -rs LINEAR_API_KEY
  echo
  if [[ -n "$LINEAR_API_KEY" ]]; then
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
      powershell.exe -NoProfile -Command "[Environment]::SetEnvironmentVariable('LINEAR_API_KEY', '$LINEAR_API_KEY', 'User')"
    else
      for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [[ -f "$rc" ]]; then
          grep -q "LINEAR_API_KEY" "$rc" 2>/dev/null || \
            printf '\n# Linear API key for codex-workflow multi-agent-workflow\nexport LINEAR_API_KEY="%s"\n' "$LINEAR_API_KEY" >> "$rc"
        fi
      done
    fi
    ok "LINEAR_API_KEY set"
  else
    warn "LINEAR_API_KEY skipped (you won't be able to use tracker=linear until set)"
  fi
fi

# --- Step 7: codex-workflow doctor ---
step "Running codex-workflow doctor"
codex-workflow doctor || warn "doctor reported issues (often non-fatal — see output above)"

# --- Step 8: Validate the example workflow ---
step "Validating examples/multi-agent-workflow/workflow.js"
# Resolve script directory regardless of where setup.sh was invoked from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW_FILE="${SCRIPT_DIR}/workflow.js"
if [[ -f "$WORKFLOW_FILE" ]]; then
  codex-workflow validate "$WORKFLOW_FILE" && ok "workflow parses cleanly"
else
  warn "workflow.js not found at $WORKFLOW_FILE (skipping validation)"
fi

# --- Step 9: Dry-run with fake agent ---
step "Dry-run with fake agent (no API calls)"
CODEX_WORKFLOW_FAKE_AGENT=1 codex-workflow run "$WORKFLOW_FILE" \
  --args '{"tracker":"gh","issueId":123}' \
  >/dev/null 2>&1 || true
ok "dry-run completed (expected to fail at schema validation — fake agent doesn't return schema objects)"

# --- Done ---
echo
printf "${GREEN}${BOLD}Setup complete.${RESET}\n\n"
printf "Next steps:\n"
printf "  1. Add the 'minimax-default' provider to your codex-workflow.config.ts (see SETUP.md Step 4)\n"
printf "  2. Run a real workflow: bun codex-workflow run %s --config <your-config> --args '{\"tracker\":\"gh\",\"issueId\":<n>}'\n" "$WORKFLOW_FILE"
printf "  3. For Orca integration, read ORCA.md\n\n"