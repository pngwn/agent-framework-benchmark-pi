#!/usr/bin/env node
// Deterministic trace analysis of one Pi session (session-format v3 JSONL).
//   node analysis/trace.mjs <session.jsonl> [--md out.md]
// Prints JSON metrics; --md also writes a condensed, human/LLM-readable trace (one block per
// turn) that the trace judge reads.
//
// Metrics fall into four groups, matching what we want to learn from a trace:
//   usage        tokens, cost, turns, wall/model/tool time, compactions
//   failures     failed tool calls by kind (edit misses, non-zero bash, bad args, ...)
//   loop         test runs and fix cycles: each failing `npm test` followed by edits
//   circularity  repeated identical calls, re-reads of unchanged files, edit reverts,
//                repeated failing commands, near-duplicate thinking, tests stuck failing
//   verification what the agent did to check its work, and whether it re-checked after
//                its last edit
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function readSession(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

const TEST_CMD = /\bnpm\s+(run\s+)?test\b|\bnpx\s+playwright\s+test\b|\bnode\s+tests\/run\.mjs\b/;
const BUILD_CMD = /\bnpm\s+run\s+build\b|\b(vite|next|nuxt|astro|ng|qwik)\s+build\b|\bvinxi\s+build\b/;
const TYPECHECK_CMD = /\btsc\b|\bsvelte-check\b|\bvue-tsc\b|\bastro\s+check\b|\bng\s+build\b/;
const BROWSER_CMD = /\bagent-browser\b/;
const SCREENSHOT_CMD = /\bagent-browser\b.*\bscreenshot\b/;
const HTTP_CMD = /\bcurl\b|\bwget\b/;
// Bash commands that change files in the project: in-place editors, scripts that write files,
// redirects to anything but /dev or /tmp, and file moves. Models often edit through these
// (e.g. `python3 - <<'PY' ... write_text`) instead of the edit tool.
const BASH_WRITE = /\b(sed\s+(-\w*\s+)*-i|perl\s+-\w*i|tee\s+(?!\/dev\/|\/tmp\/)|patch\s|git\s+(apply|checkout|restore)\s|mv\s|cp\s|rm\s)|write_text\(|writeFileSync\(|writeFile\(|open\([^)]*['"][wa]\+?['"]|(^|[^0-9&>])>{1,2}\s*(?!\/dev\/|\/tmp\/|&)["']?[\w.~/-]/;
const FRAMEWORK_CLI = /@sveltejs\/mcp(\s+[a-z-]+)?|@angular\/cli\s+mcp|\bng\s+mcp\b|next-devtools-mcp|@hono\/cli(\s+[a-z-]+)?|\bhono\s+(request|docs|search)\b/;
// A bash command that changes a source file: a redirect whose target is one, or an in-place
// editor / file-writing script / move that names one. (`node api/server.mjs > log` is not.)
const INPLACE_WRITE = /\b(sed\s+(-\w*\s+)*-i|perl\s+-\w*i|tee\s|patch\s|git\s+(apply|checkout|restore)\s|mv\s|cp\s)|write_text\(|writeFileSync\(|writeFile\(|open\([^)]*['"][wa]\+?['"]/;
// Only files in app/ count: scratch scripts in the repo root or /tmp aren't the app's code.
function isBashCodeWrite(cmd) {
  // Working directory from the last top-level `cd` (a `(cd app && …)` subshell doesn't count).
  let topLevel = cmd;
  for (let prev; prev !== topLevel; ) [prev, topLevel] = [topLevel, topLevel.replace(/\([^()]*\)/g, '')];
  const inApp = /(^|\/)app\/?$/.test([...topLevel.matchAll(/(?:^|[;&]\s*)cd\s+(\S+)/g)].at(-1)?.[1] ?? '');
  const isAppPath = (p) => /(^|\/)app\//.test(p) || (inApp && !p.startsWith('/'));
  for (const m of cmd.matchAll(/(?:^|[^0-9&>])>{1,2}\s*["']?([^\s"'&|;)<>]+)/g)) {
    if (!/^\/(dev|tmp)\//.test(m[1]) && SOURCE_FILE_EXACT.test(m[1]) && isAppPath(m[1])) return true;
  }
  if (!INPLACE_WRITE.test(cmd)) return false;
  return [...cmd.replace(/\/tmp\/\S+/g, '').matchAll(new RegExp(SOURCE_FILE.source, 'g'))].some((m) => isAppPath(m[0]));
}
const SOURCE_FILE_EXACT = /\.(m?[jt]sx?|cjs|vue|svelte|astro|css|scss|html)$/;
const SOURCE_FILE = /[\w/.$\[\]()+-]+\.(m?[jt]sx?|cjs|vue|svelte|astro|css|scss|html)\b/;
const SERVER_CMD = /\bnpm\s+(run\s+)?(start|dev|preview)\b|\bnode\s+\S*server/;

const textOf = (content) =>
  (Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

// Playwright list-reporter summary ("  37 passed", "  5 failed") and failing test titles.
export function parseTestOutput(out) {
  const n = (re) => Number(out.match(re)?.[1] ?? 0);
  const failures = [...out.matchAll(/^\s+\d+\) \[[^\]]+\] › (.+?)\s*$/gm)].map((m) => m[1].replace(/:\d+:\d+/, ''));
  return { testsPassed: n(/^\s*(\d+) passed/m), testsFailed: n(/^\s*(\d+) failed/m), testsFlaky: n(/^\s*(\d+) flaky/m), failures: [...new Set(failures)] };
}

// Word 5-gram shingles, for spotting thinking that goes over the same ground again.
function shingles(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9_$./-]+/g, ' ').split(' ').filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 5 <= words.length; i++) set.add(words.slice(i, i + 5).join(' '));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const editPath = (args) => args?.path ?? args?.file_path ?? args?.filePath;
const editPairs = (args) => (Array.isArray(args?.edits) ? args.edits : args?.oldText !== undefined ? [args] : []);

export function analyzeSession(entries) {
  const header = entries.find((e) => e.type === 'session');
  const messages = entries.filter((e) => e.type === 'message').map((e) => ({ ...e.message, entryTs: Date.parse(e.timestamp) }));
  const assistants = messages.filter((m) => m.role === 'assistant');
  const results = new Map(messages.filter((m) => m.role === 'toolResult').map((m) => [m.toolCallId, m]));

  // ----- usage -----
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costUSD: 0 };
  for (const m of assistants) {
    const u = m.usage ?? {};
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.cacheWrite += u.cacheWrite ?? 0;
    usage.reasoning += u.reasoning ?? 0;
    usage.total += u.totalTokens ?? 0;
    usage.costUSD += u.cost?.total ?? 0;
  }
  const times = entries.map((e) => Date.parse(e.timestamp)).filter(Number.isFinite);
  const wallMs = times.length ? Math.max(...times) - Math.min(...times) : null;

  // ----- walk tool calls in order -----
  const calls = [];
  for (const m of assistants) {
    for (const block of m.content ?? []) {
      if (block.type !== 'toolCall') continue;
      const r = results.get(block.id);
      calls.push({ id: block.id, name: block.name, args: block.arguments ?? {}, result: r, isError: !!r?.isError, out: textOf(r?.content), turnTs: m.timestamp });
    }
  }
  const bashFileWrites = calls.filter((c) => c.name === 'bash' && isBashCodeWrite(c.args.command ?? '')).length;
  const toolCalls = {};
  const toolErrors = {};
  const failureKinds = { editMiss: 0, bashNonZero: 0, bashTimeout: 0, invalidArgs: 0, unknownTool: 0, readMissing: 0, mcpError: 0, webError: 0, other: 0 };
  for (const c of calls) {
    toolCalls[c.name] = (toolCalls[c.name] ?? 0) + 1;
    if (!c.isError) continue;
    toolErrors[c.name] = (toolErrors[c.name] ?? 0) + 1;
    const o = c.out;
    if (/validat|Invalid (tool )?(input|arguments)|Expected .* received/i.test(o)) failureKinds.invalidArgs++;
    else if (/Tool .* not found|Unknown tool/i.test(o)) failureKinds.unknownTool++;
    else if (c.name === 'edit') failureKinds.editMiss++;
    else if (c.name === 'bash' && /timed out|Command terminated/i.test(o)) failureKinds.bashTimeout++;
    else if (c.name === 'bash') failureKinds.bashNonZero++;
    else if (c.name === 'read' && /ENOENT|not found|does not exist/i.test(o)) failureKinds.readMissing++;
    else if (c.name.startsWith('mcp__')) failureKinds.mcpError++;
    else if (c.name.startsWith('web_')) failureKinds.webError++;
    else failureKinds.other++;
  }

  // ----- tooling the framework provided -----
  const mcpCalls = calls.filter((c) => c.name.startsWith('mcp__')).map((c) => c.name);
  // Framework tooling run as a CLI from bash (skills often say to), e.g. the Svelte MCP's autofixer.
  const toolingCli = calls.filter((c) => c.name === 'bash' && FRAMEWORK_CLI.test(c.args.command ?? '')).map((c) => c.args.command.match(FRAMEWORK_CLI)[0]);
  // Skill files opened with read, or (more often) cat/sed/head through bash. Counted per skill.
  const SKILL_FILE = /\.?(agents|pi)\/skills\/([\w.-]+)\/[\w./-]*\.md\b/g;
  const skillHits = calls.flatMap((c) => {
    const target = c.name === 'read' ? (editPath(c.args) ?? '') : c.name === 'bash' ? (c.args.command ?? '') : '';
    return [...target.matchAll(SKILL_FILE)].map((m) => m[2]);
  });
  const skillReads = [...new Set(skillHits)];
  const webSearches = calls.filter((c) => c.name === 'web_search').map((c) => c.args.query);
  const webFetches = calls.filter((c) => c.name === 'web_fetch').map((c) => c.args.url);

  // ----- test / fix loop -----
  // A change to the app's code: edit/write of a source file, or a bash write whose command
  // names one. Killing servers, deleting test-results/ or adding a .gitignore isn't.
  const isMutation = (c) => {
    if (c.name === 'edit' || c.name === 'write') return SOURCE_FILE.test(editPath(c.args) ?? '') && /(^|\/)app\//.test(editPath(c.args));
    return c.name === 'bash' && isBashCodeWrite(c.args.command ?? '');
  };
  const testRuns = [];
  let mutationsSinceTest = 0;
  for (const [i, c] of calls.entries()) {
    if (c.name === 'bash' && TEST_CMD.test(c.args.command ?? '')) {
      // `python3 … write file && npm test` edits and tests in one call: the edit comes first.
      if (isMutation(c)) mutationsSinceTest++;
      const parsed = parseTestOutput(c.out);
      testRuns.push({
        index: i,
        command: c.args.command,
        filtered: /--grep|-g\s|\.spec\.|--last-failed|-x\b/.test(c.args.command),
        // A piped `npm test | tail` exits 0 even when tests fail, so trust Playwright's counts.
        passed: !c.isError && parsed.testsFailed === 0 && (parsed.testsPassed > 0 || !/\d+ (passed|failed)/.test(c.out)),
        editsBefore: mutationsSinceTest,
        ...parsed,
      });
      mutationsSinceTest = 0;
    } else if (isMutation(c)) mutationsSinceTest++;
  }
  // A fix cycle: a failing test run that's followed by edits and then another test run.
  const fixCycles = testRuns.filter((t, i) => !t.passed && testRuns[i + 1]?.editsBefore > 0).length;
  const firstFullPass = testRuns.findIndex((t) => t.passed && !t.filtered);
  // Tests that failed in 3+ consecutive test runs: a sign of being stuck on one problem.
  const streaks = new Map();
  const stuckTests = new Set();
  for (const t of testRuns) {
    for (const name of [...streaks.keys()]) if (!t.failures.includes(name)) streaks.delete(name);
    for (const f of t.failures) {
      streaks.set(f, (streaks.get(f) ?? 0) + 1);
      if (streaks.get(f) >= 3) stuckTests.add(f);
    }
  }

  // ----- circularity -----
  const seen = new Map();
  let repeatedCalls = 0;
  for (const c of calls) {
    const key = `${c.name}:${JSON.stringify(c.args)}`;
    if (seen.has(key)) repeatedCalls++;
    seen.set(key, true);
  }
  // Reads of a file that hasn't changed since the agent last read it (in full).
  const lastRead = new Map();
  let rereadsUnchanged = 0;
  for (const c of calls) {
    const p = editPath(c.args);
    if (c.name === 'read' && p && !c.args.offset && !c.args.limit) {
      if (lastRead.get(p) === 'read') rereadsUnchanged++;
      lastRead.set(p, 'read');
    } else if ((c.name === 'edit' || c.name === 'write') && p) lastRead.set(p, 'changed');
  }
  // Edits that put back text an earlier edit removed from the same file.
  const removed = new Map();
  let editReverts = 0;
  for (const c of calls) {
    if (c.name !== 'edit' || c.isError) continue;
    const p = editPath(c.args);
    const gone = removed.get(p) ?? new Set();
    for (const e of editPairs(c.args)) {
      if (e.newText?.trim() && gone.has(e.newText.trim())) editReverts++;
      if (e.oldText?.trim()) gone.add(e.oldText.trim());
    }
    removed.set(p, gone);
  }
  // The same failing bash command run 3+ times.
  const failingCmds = {};
  for (const c of calls) if (c.name === 'bash' && c.isError) failingCmds[c.args.command] = (failingCmds[c.args.command] ?? 0) + 1;
  const repeatedFailingCommands = Object.entries(failingCmds).filter(([, n]) => n >= 3).map(([cmd, n]) => ({ cmd: cmd.slice(0, 200), n }));
  // Thinking blocks that mostly repeat an earlier, non-adjacent one.
  const thinking = assistants.flatMap((m) => (m.content ?? []).filter((b) => b.type === 'thinking').map((b) => b.thinking ?? ''));
  const sh = thinking.map(shingles);
  let repetitiveThinking = 0;
  for (let i = 0; i < sh.length; i++) {
    if (sh[i].size < 20) continue;
    for (let j = 0; j < i - 1; j++) {
      if (jaccard(sh[i], sh[j]) > 0.5) {
        repetitiveThinking++;
        break;
      }
    }
  }

  // ----- verification -----
  const bash = calls.filter((c) => c.name === 'bash').map((c) => c.args.command ?? '');
  const lastMutation = calls.findLastIndex(isMutation);
  const verification = {
    testRuns: testRuns.length,
    filteredTestRuns: testRuns.filter((t) => t.filtered).length,
    builds: bash.filter((c) => BUILD_CMD.test(c)).length,
    typechecks: bash.filter((c) => TYPECHECK_CMD.test(c)).length,
    browserCommands: bash.filter((c) => BROWSER_CMD.test(c)).length,
    screenshots: bash.filter((c) => SCREENSHOT_CMD.test(c)).length,
    httpProbes: bash.filter((c) => HTTP_CMD.test(c) && /localhost|127\.0\.0\.1/.test(c)).length,
    serverStarts: bash.filter((c) => SERVER_CMD.test(c)).length,
    viewedReferenceScreenshots: calls.filter((c) => c.name === 'read' && /design\/screenshots\//.test(editPath(c.args) ?? '')).length,
    // Did a full, passing test run come after the last change to the code?
    fullPassAfterLastEdit: testRuns.some((t) => t.index >= lastMutation && t.passed && !t.filtered),
  };

  const last = assistants.at(-1);
  return {
    sessionId: header?.id ?? null,
    model: last?.model ?? null,
    provider: last?.provider ?? null,
    stopReason: last?.stopReason ?? null,
    errorMessage: last?.errorMessage ?? null,
    turns: assistants.length,
    wallMs,
    usage,
    compactions: entries.filter((e) => e.type === 'compaction').length,
    turnLimitHit: entries.some((e) => e.type === 'custom' && e.customType === 'run-guard'),
    tools: { calls: toolCalls, errors: toolErrors, total: calls.length, failed: calls.filter((c) => c.isError).length, failureKinds, bashFileWrites },
    frameworkTooling: { mcpCalls: mcpCalls.length, mcpTools: [...new Set(mcpCalls)], toolingCliCalls: toolingCli.length, toolingCli: [...new Set(toolingCli)], skillReads, skillFileReads: skillHits.length, webSearches, webFetches },
    loop: { testRuns: testRuns.map(({ command, ...t }) => ({ command: command.slice(0, 160), ...t })), fixCycles, firstFullPassAt: firstFullPass === -1 ? null : firstFullPass, stuckTests: [...stuckTests] },
    circularity: { repeatedCalls, rereadsUnchanged, editReverts, repeatedFailingCommands, repetitiveThinking, thinkingBlocks: thinking.length, thinkingChars: thinking.reduce((n, t) => n + t.length, 0) },
    verification,
  };
}

// Condensed trace for humans and the trace judge: every turn's thinking (trimmed), its tool
// calls (trimmed arguments) and what came back (errors in full-ish, successes as a head).
export function condenseSession(entries, { thinkingChars = 800, outChars = 400 } = {}) {
  const trim = (s, n) => (s.length > n ? `${s.slice(0, n)} …[+${s.length - n} chars]` : s);
  const results = new Map(entries.filter((e) => e.type === 'message' && e.message.role === 'toolResult').map((e) => [e.message.toolCallId, e.message]));
  const lines = [];
  let turn = 0;
  for (const e of entries) {
    if (e.type === 'compaction') lines.push(`\n## [compaction] tokensBefore=${e.tokensBefore}`);
    if (e.type !== 'message') continue;
    const m = e.message;
    if (m.role === 'user') lines.push(`\n## USER\n${trim(textOf(m.content), 2000)}`);
    if (m.role !== 'assistant') continue;
    lines.push(`\n## Turn ${++turn}  (${e.timestamp})`);
    for (const b of m.content ?? []) {
      if (b.type === 'thinking') lines.push(`THINK: ${trim((b.thinking ?? '').replace(/\s+/g, ' '), thinkingChars)}`);
      if (b.type === 'text' && b.text.trim()) lines.push(`SAY: ${trim(b.text.replace(/\s+/g, ' '), 600)}`);
      if (b.type === 'toolCall') {
        const r = results.get(b.id);
        const args = b.name === 'bash' ? b.arguments?.command : JSON.stringify(b.arguments);
        lines.push(`CALL ${b.name}: ${trim(String(args ?? ''), 300)}`);
        if (r) lines.push(`${r.isError ? 'ERROR' : 'OK'}: ${trim(textOf(r.content).replace(/\s+\n/g, '\n'), r.isError ? outChars * 3 : outChars)}`);
      }
    }
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, flag, mdOut] = process.argv.slice(2);
  const entries = readSession(file);
  console.log(JSON.stringify(analyzeSession(entries), null, 2));
  if (flag === '--md' && mdOut) fs.writeFileSync(mdOut, condenseSession(entries));
}
