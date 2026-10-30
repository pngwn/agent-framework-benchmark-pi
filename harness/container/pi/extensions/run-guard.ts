// Keeps a run bounded. The host keeps upstream's wall-clock timeout; this adds what Claude
// Code has built in and Pi doesn't:
//   - a turn cap, so a model stuck in a loop can't burn tokens for hours;
//   - a default bash timeout. Pi's bash tool waits forever unless the model passes a timeout,
//     so one hung command (a busy loop, a server started in the foreground) stalls the whole
//     run. Claude Code's Bash defaults to 2 min (max 10); this uses 5 min, since Pi's tool
//     description tells the model there is no default and `npm test` builds can take minutes;
//   - a retry for empty completions. Some providers (together, for Kimi K3) sometimes answer
//     with stop reason "stop" and no text or tool call (nothing at all, or only the reasoning,
//     cut off where a tool call should start), which Pi takes as the agent being done. It's
//     turned into a provider error, so Pi's own auto-retry re-sends the same request.
// A turn-cap stop is recorded in the session (custom entry "run-guard") and in $RUN_GUARD_FILE;
// empty completions are recorded as "run-guard" entries too.
//
// Env: PI_MAX_TURNS (default 500; 0 disables), PI_BASH_TIMEOUT (seconds, default 300; 0
// disables), PI_BASH_MAX_TIMEOUT (seconds, default 600), RUN_GUARD_FILE (optional marker path).
import fs from "node:fs";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const maxTurns = Number(process.env.PI_MAX_TURNS ?? 500);
  const bashTimeout = Number(process.env.PI_BASH_TIMEOUT ?? 300);
  const bashMaxTimeout = Number(process.env.PI_BASH_MAX_TIMEOUT ?? 600);
  let turns = 0;
  let stopped = false;

  pi.on("turn_start", async (_event, ctx) => {
    turns++;
    if (stopped || !maxTurns || turns <= maxTurns) return;
    stopped = true;
    const reason = `turn limit reached (${maxTurns})`;
    pi.appendEntry("run-guard", { reason, turns });
    if (process.env.RUN_GUARD_FILE) fs.writeFileSync(process.env.RUN_GUARD_FILE, `${reason}\n`);
    ctx.abort();
  });

  pi.on("message_end", async (event) => {
    const m = event.message;
    if (m.role !== "assistant" || m.stopReason !== "stop") return;
    if (m.content.some((c) => (c.type === "text" && c.text.trim()) || c.type === "toolCall")) return;
    pi.appendEntry("run-guard", { reason: "empty completion", turns, thinkingOnly: m.content.length > 0 });
    // The wording matches Pi's retryable-error pattern ("provider returned an error").
    return { message: { ...m, stopReason: "error", errorMessage: "Empty completion: provider returned an error (no text or tool call)" } };
  });

  pi.on("tool_call", async (event) => {
    if (!bashTimeout || !isToolCallEventType("bash", event)) return;
    const requested = event.input.timeout;
    event.input.timeout = requested === undefined ? bashTimeout : Math.min(requested, bashMaxTimeout);
  });
}
