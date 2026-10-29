// web_search and web_fetch tools backed by Exa (https://docs.exa.ai). Stands in for the
// WebSearch and WebFetch tools the original Claude Code agents had. Both tools are kept
// deliberately plain (no summarisation model in between) so the trace shows exactly what
// the agent read.
//
// Env: EXA_API_KEY.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const EXA = "https://api.exa.ai";
const MAX_CHARS = 20_000;
// The spec says pokeapi.co is unreachable; the container blocks it by DNS, and this keeps
// the fetch tool from tunnelling around that.
const BLOCKED_HOSTS = /(^|\.)pokeapi\.co$/i;

async function exa(path: string, body: unknown, signal?: AbortSignal) {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("EXA_API_KEY is not set");
  const res = await fetch(`${EXA}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Exa ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 500)}`);
  return res.json() as Promise<{ results: { url: string; title?: string; publishedDate?: string; text?: string }[] }>;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web. Returns the top results with title, URL, date and an excerpt of each page. " +
      "Use it for documentation, release notes and current APIs.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      numResults: Type.Optional(Type.Number({ description: "Number of results (1-10, default 5)" })),
    }),
    async execute(_id, params, signal) {
      const n = Math.min(Math.max(Math.round(params.numResults ?? 5), 1), 10);
      const data = await exa(
        "/search",
        { query: params.query, numResults: n, type: "auto", contents: { text: { maxCharacters: 1500 } } },
        signal,
      );
      const results = data.results.filter((r) => !BLOCKED_HOSTS.test(new URL(r.url).hostname));
      if (!results.length) return { ...text("No results."), details: { query: params.query, urls: [] } };
      const body = results
        .map((r, i) => `[${i + 1}] ${r.title ?? "(untitled)"}\n${r.url}${r.publishedDate ? `\n${r.publishedDate.slice(0, 10)}` : ""}\n${(r.text ?? "").trim()}`)
        .join("\n\n---\n\n");
      return { ...text(body), details: { query: params.query, urls: results.map((r) => r.url) } };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description: "Fetch a web page and return its main content as text (truncated to about 20k characters).",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL" }),
    }),
    async execute(_id, params, signal) {
      const url = new URL(params.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs are supported");
      if (BLOCKED_HOSTS.test(url.hostname)) throw new Error(`${url.hostname} is unreachable from this environment`);
      const data = await exa("/contents", { urls: [url.href], text: { maxCharacters: MAX_CHARS } }, signal);
      const page = data.results[0];
      if (!page?.text) throw new Error(`Could not fetch ${url.href}`);
      return { ...text(`${page.title ?? ""}\n${page.url}\n\n${page.text}`), details: { url: page.url, chars: page.text.length } };
    },
  });
}
