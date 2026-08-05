#!/usr/bin/env bash
# Mutation — break the platform on purpose and confirm each verification goes red for its own reason.
#
# ### ⚠️ The only stage that writes to your working tree
#
# `mutations.mjs` edits real source files and rebuilds real images. It restores from a byte snapshot
# in a `finally`, and this stage registers a second restore with the engine in case the process is
# killed outright — a sleeping laptop, a closed terminal, ^C. Both exist because the failure mode is
# not "a test fails", it is "you wake up to a mutated repository and a rebuilt image, and the diff
# looks like something you might have written".
#
# Pre-flight refuses to reach this stage with a dirty tree unless you explicitly allowed it.
. "$(dirname -- "$0")/_preamble.sh"

MUTATE="docs/review/p8/mutations.mjs"
[ -f "$MUTATE" ] || {
  bad "missing $MUTATE"
  headline "mutation script not found"
  finish
}

BEFORE=$(tree_fingerprint)

# Belt and braces: `restore` reverses each mutation's exact substitution and rebuilds, so it is safe
# to run even when nothing was left applied.
guard "cd '$REPO' && node $MUTATE restore"

if [ -n "$MUTATIONS" ]; then
  note "running selected mutations: $MUTATIONS"
  RC=0
  for m in $MUTATIONS; do
    echo ""
    echo "──── mutation: $m"
    node "$MUTATE" "$m" || RC=1
  done
else
  note "running the full suite"
  echo ""
  node "$MUTATE"
  RC=$?
fi

unguard

if [ "$RC" -eq 0 ]; then
  ok "every verification failed for the reason it claims, and recovered"
else
  bad "the mutation suite reported failures (exit $RC)"
fi

# ⚠️ Checked here as well as by the engine, because this is the stage that can cause it and the
# blame belongs next to the cause rather than in a footnote at the end of the night.
AFTER=$(tree_fingerprint)
if [ "$BEFORE" = "$AFTER" ]; then
  ok "the working tree is exactly as this stage found it"
else
  bad "THE WORKING TREE CHANGED — a mutation was not restored"
  printf '%s\n' "$AFTER" | sed 's/^/      /'
fi

PASSED=$(grep -c '✓ and GREEN again once restored' "$STAGE_LOG" 2>/dev/null || echo 0)
headline "$PASSED mutation(s) red-then-green$([ "$RC" -eq 0 ] || echo ' · with failures')"
finish
