#!/usr/bin/env bash
# Container entrypoint: runs one Pi agent on a task and saves its repo and traces to
# $OUT, inside the container. Pi port of upstream/bench/container/run-agent.sh. Started by
# harness/run.mjs, which copies $OUT out once the container exits (the agent gets no host
# mount it could write to) and then runs the tests in a separate, clean container.
#
# Env (set by run.mjs):
#   FRAMEWORK    framework key (upstream/bench/frameworks.mjs)
#   PROMPT       the prompt given to the agent
#   MODEL        model id in pi's huggingface catalog
#   HF_PROVIDER  optional HF Inference Provider to pin (e.g. together); empty = router's choice
#   THINKING     pi --thinking level
#   RUN_ID       session id, also used to name the trace
#   HF_TOKEN, EXA_API_KEY
# Optional mount /seed (extension tasks): app/, tests/specs/ and FEATURE.md are copied into
# the repo and committed before the agent starts, so `git diff` afterwards is the agent's work.
set -euo pipefail

: "${FRAMEWORK:?}" "${PROMPT:?}" "${MODEL:?}" "${THINKING:?}" "${RUN_ID:?}" "${HF_TOKEN:?}" "${EXA_API_KEY:?}"
OUT=/home/agent/out
WORK=/home/agent/work
PI_DIR="$PI_CODING_AGENT_DIR"
mkdir -p "$OUT/session"

if [ -d /seed ]; then
  cp -R /seed/. "$WORK/"
  git -C "$WORK" add -A
  git -C "$WORK" -c user.name=bench -c user.email=bench@localhost commit -q -m "Base app and feature spec"
fi
git -C "$WORK" rev-parse HEAD > "$OUT/base-commit.txt"

# agent-browser has no Chrome build for linux/arm64; there, point it at Playwright's Chromium.
if [ -f /home/agent/agent-browser-install-failed ]; then
  AGENT_BROWSER_EXECUTABLE_PATH="$(ls -d /home/agent/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | head -n 1)"
  export AGENT_BROWSER_EXECUTABLE_PATH
fi

/home/agent/setup-tooling.sh "$FRAMEWORK" "$PI_DIR/mcp.json" "$OUT/tooling-versions.json" > "$OUT/tooling.log" 2>&1

# models.json: the provider pin (if any) and image limits; see pin-provider.mjs.
MODEL_ARGS=(--model "$(node /home/agent/pin-provider.mjs "$PI_DIR/models.json" "$MODEL" "${HF_PROVIDER:-}")")

{
  echo "framework=$FRAMEWORK"
  echo "prompt=$PROMPT"
  echo "model=$MODEL"
  echo "hf_provider=${HF_PROVIDER:-auto}"
  echo "thinking=$THINKING"
  echo "pi=$(pi --version)"
  echo "agent_browser=$(agent-browser --version 2>/dev/null || true)"
  echo "agent_browser_chrome=${AGENT_BROWSER_EXECUTABLE_PATH:-bundled}"
  echo "node=$(node --version)"
  echo "npm=$(npm --version)"
  echo "playwright=$(npx playwright --version | sed 's/^Version //')"
  echo "max_turns=${PI_MAX_TURNS:-500}"
  echo "started=$(date -u +%FT%TZ)"
} > "$OUT/run-info.txt"
cp "$PI_DIR/mcp.json" "$OUT/mcp.json"
cp "$PI_DIR/models.json" "$OUT/models.json"

cd "$WORK"
set +e
# --approve: trust the project so .agents/skills load in json mode.
# message_update events (one per streamed token) are dropped from the event log: the session
# file and message_end events carry the same content in full.
# Run in the background so a SIGTERM (the host's wall-clock timeout) stops pi and still
# saves the repo below.
{
  RUN_GUARD_FILE="$OUT/TURN_LIMIT" pi --mode json "${MODEL_ARGS[@]}" --thinking "$THINKING" --approve \
    --session-dir "$OUT/session" --session-id "$RUN_ID" \
    "$PROMPT" 2> "$OUT/pi-stderr.log"
  echo "$?" > "$OUT/.pi-exit"
} | grep --line-buffered -v '^{"type":"message_update"' > "$OUT/events.jsonl" &
AGENT=$!
trap 'echo "stopped=SIGTERM" >> "$OUT/run-info.txt"; pkill -TERM -x pi' TERM INT
wait "$AGENT"
wait "$AGENT" 2>/dev/null
trap - TERM INT
echo "pi_exit=$(cat "$OUT/.pi-exit" 2>/dev/null || echo killed)" >> "$OUT/run-info.txt"
rm -f "$OUT/.pi-exit"
set -e
echo "finished=$(date -u +%FT%TZ)" >> "$OUT/run-info.txt"
pi mcp list --json > "$OUT/mcp-status.json" 2>/dev/null || true

git -C "$WORK" status --short > "$OUT/git-status.txt" || true
tar --exclude=node_modules --exclude=./data --exclude=./.data-cache --exclude=./test-results \
  -czf "$OUT/repo.tar.gz" -C "$WORK" .
echo "Done. Results in $OUT"
