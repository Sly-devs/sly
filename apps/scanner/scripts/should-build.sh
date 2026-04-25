#!/usr/bin/env bash
# Vercel "Ignored Build Step" for the sly-scanner project.
#
# Vercel runs this from the project's Root Directory (apps/scanner),
# but our intent is to build only when files OUTSIDE this directory
# (workspace deps) OR inside it have changed. So `cd ../..` first to
# get repo-relative paths.
#
# Exit code semantics (from Vercel docs):
#   0     → Skip the build (no rebuild needed)
#   != 0  → Proceed with the build
set -e
cd ../..
git diff HEAD^ HEAD --quiet -- \
  apps/scanner \
  packages/types \
  packages/utils \
  packages/db \
  pnpm-lock.yaml \
  || exit 1
echo "[should-build] No scanner-relevant changes since previous commit — skipping."
exit 0
