#!/usr/bin/env bash
#
# Verifies that the RLS proof suite is actually load-bearing.
#
# A security test only means something once it has been seen to fail. This
# breaks each tenant table's SELECT policy in turn, re-runs test/rls.e2e-spec.ts,
# and requires the suite to FAIL every time. A mutation the suite survives is
# reported as an alarm and exits non-zero: it means that policy could vanish in a
# future migration without anything noticing.
#
# Two mutations are applied:
#   drop  — the policy is removed. Postgres then denies by default, so this makes
#           the table MORE restrictive. Tests asserting emptiness still pass; only
#           tests asserting real rows, and the configuration test, catch it.
#   leak  — the policy is replaced with USING (true): present, plausible, and
#           wide open. This is the realistic bug, and the one that must never pass.
#
# The original policy expression is read back from pg_policies before each
# mutation and restored afterwards, including on Ctrl-C or any error, so an
# interrupted run cannot leave the database unprotected.
#
# Requires: npm run db:up, and a migrated database.
# Usage:    npm run test:rls-mutation

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

TENANT_TABLES=(organizations users surveys questions responses answers)
LEAK_TABLE=surveys           # the table the behavioural assertions actually read
LOG="$(mktemp -t rls-proof)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

# Credentials come from the container's own environment, so they are never
# duplicated here or in package.json.
psql_owner() {
  docker compose exec -T postgres sh -c \
    'PGPASSWORD="$OWNER_PASSWORD" PGOPTIONS="-c client_min_messages=warning" \
     psql -h 127.0.0.1 -U "$OWNER_ROLE" -d "$POSTGRES_DB" -qtAX -v ON_ERROR_STOP=1 -c "$0"' "$1"
}

MUTATED_TABLE=""
MUTATED_POLICY=""
MUTATED_QUAL=""

# Written to disk before each mutation, so a run killed hard enough to skip the
# trap (SIGKILL, a closed terminal, a dead laptop) still leaves a record of what
# to put back. The next run repairs it before doing anything else.
STATE_FILE="$PWD/.rls-mutation-state"

put_policy_back() {
  psql_owner "DROP POLICY IF EXISTS \"$2\" ON \"$1\";
              CREATE POLICY \"$2\" ON \"$1\" FOR SELECT USING ($3);" >/dev/null
}

restore() {
  if [[ -n "$MUTATED_TABLE" ]]; then
    put_policy_back "$MUTATED_TABLE" "$MUTATED_POLICY" "$MUTATED_QUAL" || true
    MUTATED_TABLE=""
  fi
  rm -f "$STATE_FILE"
}

# A bare `trap ... INT` runs the handler and then CARRIES ON, which would restore
# the policy and keep mutating after the operator asked it to stop. Signals get
# their own handler that actually exits.
on_signal() {
  printf '\n'
  fail "interrupted — restoring ${MUTATED_POLICY:-nothing} before exiting"
  restore
  rm -f "$LOG"
  exit 130
}
trap 'restore; rm -f "$LOG"' EXIT
trap on_signal INT TERM

# Repairs a policy left dropped by a previous run that never got to clean up.
heal_previous_run() {
  [[ -f "$STATE_FILE" ]] || return 0
  local table policy qual
  { read -r table; read -r policy; read -r qual; } < "$STATE_FILE"
  if [[ -n "${table:-}" && -n "${qual:-}" ]]; then
    bold "A previous run left $policy dropped. Restoring it before continuing."
    put_policy_back "$table" "$policy" "$qual"
    pass "$policy restored"
  fi
  rm -f "$STATE_FILE"
}

# Saves the policy so restore() can put it back verbatim, then removes it.
take_policy() {
  MUTATED_TABLE="$1"
  MUTATED_POLICY="${1}_select"
  MUTATED_QUAL="$(psql_owner "SELECT qual FROM pg_policies
                              WHERE schemaname='public' AND tablename='${1}'
                                AND policyname='${MUTATED_POLICY}';")"
  if [[ -z "$MUTATED_QUAL" ]]; then
    MUTATED_TABLE=""
    fail "no policy ${1}_select to mutate — is the database migrated?"
    exit 1
  fi
  printf '%s\n%s\n%s\n' "$MUTATED_TABLE" "$MUTATED_POLICY" "$MUTATED_QUAL" > "$STATE_FILE"
  psql_owner "DROP POLICY \"$MUTATED_POLICY\" ON \"$MUTATED_TABLE\";" >/dev/null
}

# Returns 0 when the suite passes.
suite_passes() { npm run test:e2e >"$LOG" 2>&1; }
suite_tally()  { grep -E '^ *Tests ' "$LOG" | tail -1 | sed 's/^ *//' || true; }

failures=0

heal_previous_run

bold "Baseline — the suite must pass before breaking anything"
if suite_passes; then
  pass "$(suite_tally)"
else
  fail "the suite is already failing; fix that before trusting this script"
  cat "$LOG"
  exit 1
fi

bold ""
bold "Mutation: drop each tenant table's SELECT policy"
for table in "${TENANT_TABLES[@]}"; do
  take_policy "$table"
  if suite_passes; then
    fail "$table — SUITE STILL PASSED with no SELECT policy"
    failures=$((failures + 1))
  else
    pass "$table — suite failed as it must  ($(suite_tally))"
  fi
  restore
done

bold ""
bold "Mutation: replace ${LEAK_TABLE}_select with USING (true) — a policy that leaks"
take_policy "$LEAK_TABLE"
psql_owner "CREATE POLICY \"${LEAK_TABLE}_select\" ON \"${LEAK_TABLE}\" FOR SELECT USING (true);" >/dev/null
if suite_passes; then
  fail "$LEAK_TABLE — SUITE STILL PASSED against a wide-open policy"
  failures=$((failures + 1))
else
  pass "$LEAK_TABLE — suite failed as it must  ($(suite_tally))"
fi
psql_owner "DROP POLICY \"${LEAK_TABLE}_select\" ON \"${LEAK_TABLE}\";" >/dev/null
restore

bold ""
bold "Restored — the suite must pass again"
if suite_passes; then
  pass "$(suite_tally)"
else
  fail "the suite did not recover; the database may not be back to its migrated state"
  cat "$LOG"
  exit 1
fi

policy_count="$(psql_owner "SELECT count(*) FROM pg_policies WHERE schemaname='public';")"
if [[ "$policy_count" == "25" ]]; then
  pass "25 policies present, matching the migration"
else
  fail "expected 25 policies, found $policy_count — run: npx prisma migrate reset"
  failures=$((failures + 1))
fi

bold ""
if (( failures == 0 )); then
  bold "✅ Every mutation was caught. The proof is load-bearing."
else
  bold "❌ $failures mutation(s) went undetected. The suite is not proving what it claims."
  exit 1
fi
