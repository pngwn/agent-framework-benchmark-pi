#!/usr/bin/env bash
# Judge entrypoint (same image as the agents): sets up the framework's tooling exactly as the
# agent had it, puts the code under review in app/, and runs Pi read-only with a rubric.
#
# Mounts: /target (app to review, ro), /judge (prompt.md, and optionally FEATURE.md,
# CHANGES.diff, trace.md), /out.
# Env: FRAMEWORK, JUDGE_MODEL, HF_PROVIDER, THINKING, RUN_ID, HF_TOKEN, EXA_API_KEY.
set -euo pipefail

: "${FRAMEWORK:?}" "${JUDGE_MODEL:?}" "${THINKING:?}" "${RUN_ID:?}" "${HF_TOKEN:?}" "${EXA_API_KEY:?}"
OUT=/out
WORK=/home/agent/work
PI_DIR="$PI_CODING_AGENT_DIR"
mkdir -p "$OUT/session"

mkdir -p "$WORK/app"
cp -R /target/. "$WORK/app/"
for f in FEATURE.md CHANGES.diff trace.md; do
  if [ -f "/judge/$f" ]; then cp "/judge/$f" "$WORK/"; fi
done

/home/agent/setup-tooling.sh "$FRAMEWORK" "$PI_DIR/mcp.json" "$OUT/tooling-versions.json" > "$OUT/tooling.log" 2>&1

MODEL_ARGS=(--model "$(node /home/agent/pin-provider.mjs "$PI_DIR/models.json" "$JUDGE_MODEL" "${HF_PROVIDER:-}")")

cd "$WORK"
set +e
# Read-only: no bash, edit or write. MCP docs tools stay available (--tools doesn't filter mcp__*).
pi --mode json "${MODEL_ARGS[@]}" --thinking "$THINKING" --approve \
  --tools read,grep,find,ls,web_search,web_fetch \
  --session-dir "$OUT/session" --session-id "$RUN_ID" \
  "$(cat /judge/prompt.md)" 2> "$OUT/pi-stderr.log" \
  | grep --line-buffered -v '^{"type":"message_update"' > "$OUT/events.jsonl"
echo "pi_exit=${PIPESTATUS[0]}" > "$OUT/run-info.txt"
set -e

# The verdict is the JSON object in the last assistant message.
node -e '
const fs = require("fs");
const events = fs.readFileSync("/out/events.jsonl", "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const last = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").at(-1);
const text = (last?.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
fs.writeFileSync("/out/verdict.txt", text);
const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
try { fs.writeFileSync("/out/verdict.json", JSON.stringify(JSON.parse(candidate), null, 2)); }
catch (err) { fs.writeFileSync("/out/verdict-error.txt", String(err)); process.exitCode = 3; }
'
