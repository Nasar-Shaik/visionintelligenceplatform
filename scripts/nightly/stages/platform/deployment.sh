#!/usr/bin/env bash
# Deployment integrity — every running byte is the byte that was committed.
#
# ⚠️ Sequenced BEFORE the stages that rebuild images, because it compares the deployment against the
# tree. Run it after the mutation suite and a rebuild that happened for the right reasons would still
# read as drift.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

node docs/review/p6/deployment-integrity.mjs
RC=$?

if [ "$RC" -eq 0 ]; then
  ok "every running byte matches the commit"
  headline "deployment matches $(git_commit)"
else
  bad "the deployment does not match the tree (exit $RC)"
  # An uncommitted tree fails this by design; say which it was so the morning does not re-diagnose it.
  if [ "$(tree_fingerprint | grep -c . || true)" -gt 0 ]; then
    warn "the working tree is dirty — that alone fails check 0a"
  fi
  headline "deployment drift or dirty tree"
fi
finish
