#!/usr/bin/env bash
# Print the URL of the Vercel deployment built for one commit.
#
# Why this exists: the e2e job used to test https://antares-extension.vercel.app
# (production) for every run. That made its result describe production at that
# moment, not the commit under test:
#   - a PR was judged on the OLD code;
#   - the run triggered by a merge started before Vercel finished deploying it;
#   - whatever production data looked like at that moment could fail any PR.
# Vercel reports every deployment through the GitHub Deployments API
# (environment "Preview" for a branch, "Production" for master) with the unique
# URL of that build once it succeeds. This script waits for it.
#
# Environment:
#   REPO          owner/name
#   SHA           commit whose deployment we want
#   WANT_ENV      "Preview" or "Production"
#   FALLBACK_URL  used (with a warning) if no deployment shows up in time
#   MAX_WAIT_S    optional, default 900
#   GH_TOKEN      token for the gh CLI (deployments: read)
#
# stdout: the URL, and nothing else. Messages go to stderr.
set -euo pipefail

: "${REPO:?REPO is required}" "${SHA:?SHA is required}" "${WANT_ENV:?WANT_ENV is required}" "${FALLBACK_URL:?FALLBACK_URL is required}"
MAX_WAIT_S="${MAX_WAIT_S:-900}"
SLEEP_S="${SLEEP_S:-15}"
deadline=$(( $(date +%s) + MAX_WAIT_S ))

echo "Waiting for the ${WANT_ENV} deployment of ${SHA} (up to ${MAX_WAIT_S}s)" >&2

while :; do
  # Newest deployment of this commit in the wanted environment (empty if none yet).
  dep=$(gh api "repos/${REPO}/deployments?sha=${SHA}&environment=${WANT_ENV}&per_page=10" \
    --jq 'sort_by(.created_at) | last | .id // empty' 2>/dev/null || true)

  if [ -n "$dep" ]; then
    # Newest status first: "<state> <url>".
    status=$(gh api "repos/${REPO}/deployments/${dep}/statuses?per_page=1" \
      --jq '.[0] // empty | "\(.state) \(.environment_url // .target_url // "")"' 2>/dev/null || true)
    state="${status%% *}"
    url="${status#* }"
    case "$state" in
      # "inactive" = built fine and since superseded by a newer deployment; the URL still serves that build.
      success|inactive)
        if [ -n "$url" ] && [ "$url" != "$state" ]; then
          echo "Deployment ${dep} is ${state}: ${url}" >&2
          echo "$url"
          exit 0
        fi
        ;;
      failure|error)
        echo "::error::The Vercel deployment ${dep} of ${SHA} ended in state '${state}'. The build is broken; there is nothing to test." >&2
        exit 1
        ;;
    esac
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::warning::No ${WANT_ENV} deployment of ${SHA} was ready after ${MAX_WAIT_S}s. Falling back to ${FALLBACK_URL}: this run describes that site, NOT this commit." >&2
    echo "$FALLBACK_URL"
    exit 0
  fi
  sleep "$SLEEP_S"
done
