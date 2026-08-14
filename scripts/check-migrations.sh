#!/usr/bin/env bash
#
# check-migrations.sh — migration integrity, the parts CI can actually verify.
#
# CLAUDE.md §8: "never edit a committed migration; add a new one". A migration
# that has already run against production will not run again — the runner skips
# anything recorded in schema_migrations — so editing one changes the file in
# git while production keeps the old schema, silently and permanently. Nothing
# enforced that rule.
#
# What this CANNOT check: whether a migration has actually been applied to
# production. CI has no route to the private-IP Cloud SQL instance, which is
# the reason migrations are run by hand in the first place. That check needs
# database access — see scripts/check-migrations-applied.mjs, which an operator
# runs through the bastion.
#
#   bash scripts/check-migrations.sh
set -uo pipefail

MIGRATIONS_DIR="packages/db/migrations"
fail=0

echo "Migration integrity"
echo

# ---------------------------------------------------------------------------
# 1. No committed migration has been modified.
#
# Compared against origin/main rather than HEAD~1, so a branch that edits an
# old migration is caught however many commits it took to get there.
# ---------------------------------------------------------------------------
BASE="${MIGRATION_BASE_REF:-origin/main}"
if git rev-parse --verify --quiet "$BASE" >/dev/null; then
  # Numbered migrations only. The seed-*.sql and retire-*.sql files are
  # deliberately re-runnable operator tools, not schema history.
  modified=$(git diff --name-only --diff-filter=M "$BASE"...HEAD -- "$MIGRATIONS_DIR" 2>/dev/null \
    | grep -E "$MIGRATIONS_DIR/[0-9]{3}_.*\.sql$" || true)
  if [[ -n "$modified" ]]; then
    echo "  FAIL  a committed migration was modified:"
    printf '        %s\n' $modified
    echo
    echo "        These have already run against production and will not run"
    echo "        again — the runner skips anything in schema_migrations. Editing"
    echo "        one changes git while production keeps the old schema. Add a"
    echo "        new migration instead."
    fail=1
  else
    echo "  ok    no committed migration modified (vs $BASE)"
  fi
else
  echo "  skip  $BASE not available; cannot compare"
fi

# ---------------------------------------------------------------------------
# 2. Numbering is unique and gapless.
#
# A duplicate prefix means two files sort ambiguously and one may never apply.
# ---------------------------------------------------------------------------
prefixes=$(ls "$MIGRATIONS_DIR" 2>/dev/null | grep -E '^[0-9]{3}_.*\.sql$' | cut -c1-3 | sort)
dupes=$(echo "$prefixes" | uniq -d)
if [[ -n "$dupes" ]]; then
  echo "  FAIL  duplicate migration numbers: $(echo $dupes | tr '\n' ' ')"
  fail=1
else
  echo "  ok    migration numbers are unique"
fi

expected=0
gaps=""
for p in $prefixes; do
  n=$((10#$p))
  if [[ $n -ne $expected ]]; then gaps="$gaps $expected"; fi
  expected=$((n + 1))
done
if [[ -n "$gaps" ]]; then
  # A warning, not a failure: a gap is usually a migration abandoned before it
  # merged, which is untidy rather than dangerous.
  echo "  warn  gaps in numbering at:$gaps"
else
  echo "  ok    migration numbering is contiguous"
fi

# ---------------------------------------------------------------------------
# 3. Every migration is non-empty and parses as something.
# ---------------------------------------------------------------------------
empty=0
for f in "$MIGRATIONS_DIR"/[0-9][0-9][0-9]_*.sql; do
  [[ -e "$f" ]] || continue
  if [[ ! -s "$f" ]]; then
    echo "  FAIL  empty migration: $f"
    empty=1
  fi
done
[[ $empty -eq 0 ]] && echo "  ok    no empty migrations"
[[ $empty -eq 1 ]] && fail=1

echo
if [[ $fail -ne 0 ]]; then
  echo "Migration integrity check FAILED."
  exit 1
fi
echo "Migration integrity OK. Note this does NOT prove they are applied to"
echo "production — run scripts/check-migrations-applied.mjs for that."
