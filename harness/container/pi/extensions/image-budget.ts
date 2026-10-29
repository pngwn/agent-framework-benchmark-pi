// Keeps the images sent to the provider within a byte budget. HF Inference Providers reject
// request bodies over a few MB (together: HTTP 413 at ~5 MB), far below the model's 1M-token
// context: agents re-read the 18 reference screenshots, every one stays in history, and an
// early grid run hit 413 at ~200k tokens with 28 images = 4.8 MB of a 5.5 MB request. Pi then
// compacts, summarising away the whole history. This instead replaces the oldest images in
// each request with a placeholder; the session file keeps them and the model can re-read any.
//
// Eviction is batched (above HIGH, drop oldest down to LOW) so the request prefix, and with it
// the provider's prompt cache, changes rarely rather than on every new image.
//
// Env: PI_IMAGE_BUDGET_HIGH / PI_IMAGE_BUDGET_LOW (bytes of base64, default 2.5 MB / 1.5 MB).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HIGH = Number(process.env.PI_IMAGE_BUDGET_HIGH ?? 2_500_000);
const LOW = Number(process.env.PI_IMAGE_BUDGET_LOW ?? 1_500_000);

type Block = { type: string; data?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Message = { role: string; content?: string | Block[]; toolCallId?: string };

export default function (pi: ExtensionAPI) {
  // Images evicted so far stay evicted, so later requests share the same prefix.
  const evicted = new Set<string>();

  pi.on("context", async (event) => {
    const messages = event.messages as Message[];
    // Where each tool result's image came from, for the placeholder text.
    const source = new Map<string, string>();
    for (const m of messages) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b.type === "toolCall" && b.id) source.set(b.id, String(b.arguments?.path ?? b.name ?? "a file"));
    }
    const images: { m: Message; i: number; key: string; bytes: number }[] = [];
    messages.forEach((m, mi) => {
      if (!Array.isArray(m.content)) return;
      m.content.forEach((b, i) => {
        if (b.type === "image" && b.data) images.push({ m, i, key: `${mi}:${i}:${b.data.length}`, bytes: b.data.length });
      });
    });
    let total = images.filter((x) => !evicted.has(x.key)).reduce((n, x) => n + x.bytes, 0);
    if (total > HIGH) {
      for (const x of images) {
        if (total <= LOW) break;
        if (evicted.has(x.key)) continue;
        evicted.add(x.key);
        total -= x.bytes;
      }
    }
    let changed = false;
    for (const x of images) {
      if (!evicted.has(x.key)) continue;
      const from = x.m.role === "toolResult" && x.m.toolCallId ? source.get(x.m.toolCallId) : undefined;
      (x.m.content as Block[])[x.i] = { type: "text", text: `[image omitted to keep the request small${from ? `: ${from}` : ""}; read it again to view it]` };
      changed = true;
    }
    return changed ? { messages: event.messages } : undefined;
  });
}
