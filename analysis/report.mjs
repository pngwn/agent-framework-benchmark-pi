// Writes <runDir>/report.md and <runDir>/summary.json from the per-iteration results.
// Each framework's numbers are medians across its iterations (like upstream), and judge
// scores are medians across samples first. When baselines/opus-analysis/summary.json exists,
// the code and judge tables show the Opus 5.5 median next to each value.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPUS_SUMMARY = path.join(ROOT, 'baselines/opus-analysis/summary.json');

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const readInfo = (f) =>
  fs.existsSync(f)
    ? Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    : {};
const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x, d = 0, scale = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : (x * scale).toFixed(d));

function judgeScores(dir) {
  const root = path.join(dir, 'judge');
  if (!fs.existsSync(root)) return {};
  const out = {};
  for (const dim of fs.readdirSync(root)) {
    const verdicts = fs.readdirSync(path.join(root, dim)).map((s) => readJson(path.join(root, dim, s, 'verdict.json'))).filter(Boolean);
    if (!verdicts.length) continue;
    const criteria = {};
    for (const v of verdicts) for (const [k, c] of Object.entries(v.criteria ?? {})) (criteria[k] ??= []).push(Number(c.score));
    out[dim] = {
      // Judges read the overall experimental score both ways (how much vs. how well), so its
      // headline is the anchored `reach` criterion instead.
      overall: dim === 'experimental' && criteria.reach ? median(criteria.reach) : median(verdicts.map((v) => Number(v.overall))),
      criteria: Object.fromEntries(Object.entries(criteria).map(([k, xs]) => [k, median(xs)])),
      samples: verdicts.length,
      count: median(verdicts.map((v) => v.count).filter((x) => typeof x === 'number')),
    };
  }
  return out;
}

function readIteration(dir) {
  const info = readInfo(path.join(dir, 'agent/run-info.txt'));
  const trace = readJson(path.join(dir, 'analysis/trace.json'));
  const code = readJson(path.join(dir, 'analysis/code.json'));
  const diff = readJson(path.join(dir, 'analysis/diff.json'));
  const finalTest = readJson(path.join(dir, 'analysis/final-test.json'));
  const retest = readJson(path.join(dir, 'analysis/retest.json'));
  const measure = readJson(path.join(dir, 'measure/results.json'));
  const lh = (k) => measure?.lighthouse?.['home/mobile']?.median?.[k] ?? null;
  // Opus baseline only: Nolan's apps re-measured on the machine that measured this harness's runs.
  const same = readJson(path.join(dir, 'measure-same-machine/results.json'));
  const lhSame = (k) => same?.lighthouse?.['home/mobile']?.median?.[k] ?? null;
  const c = code?.totals ?? {};
  const featureFailures = finalTest?.failures.filter((f) => /team\.spec|feature/.test(f)) ?? [];
  return {
    name: path.basename(dir),
    framework: path.basename(dir).replace(/-\d+$/, ''),
    passed: info.final_test_exit === '0',
    retestRuns: retest?.runs ?? null,
    retestPasses: retest?.passes ?? null,
    timedOut: fs.existsSync(path.join(dir, 'TIMED_OUT')),
    // agent
    tokens: trace?.usage.total ?? null,
    inputTokens: trace ? trace.usage.input + trace.usage.cacheRead + trace.usage.cacheWrite : null,
    outputTokens: trace?.usage.output ?? null,
    cost: trace?.usage.costUSD ?? null,
    wallMin: trace?.wallMs != null ? trace.wallMs / 60000 : null,
    turns: trace?.turns ?? null,
    compactions: trace?.compactions ?? null,
    turnLimitHit: trace?.turnLimitHit ?? false,
    // page loads (upstream)
    perf: lh('performance'),
    lcp: lh('lcp'),
    tbt: lh('tbt'),
    jsKiB: lh('scriptBytes') != null ? lh('scriptBytes') / 1024 : null,
    perfSame: lhSame('performance'),
    lcpSame: lhSame('lcp'),
    tbtSame: lhSame('tbt'),
    jsKiBSame: lhSame('scriptBytes') != null ? lhSame('scriptBytes') / 1024 : null,
    // code
    upstreamLoc: measure?.code?.sourceLines ?? c.upstreamLoc ?? null,
    significantLoc: c.significantLoc ?? null,
    scriptLoc: c.scriptLoc ?? null,
    templateLoc: c.templateLoc ?? null,
    styleLoc: c.styleLoc ?? null,
    tokensCode: c.tokens ?? null,
    chars: c.chars ?? null,
    functions: c.functions ?? null,
    complexity: c.complexity ?? null,
    concepts: c.concepts ?? null,
    dependencies: c.dependencies ?? null,
    testFiles: code?.tests.files ?? null,
    testCases: code?.tests.cases ?? null,
    experimentalMarkers: code?.experimental.length ?? null,
    // trace
    toolCalls: trace?.tools.total ?? null,
    failedCalls: trace?.tools.failed ?? null,
    failedPct: trace ? (100 * trace.tools.failed) / Math.max(1, trace.tools.total) : null,
    editMisses: trace?.tools.failureKinds.editMiss ?? null,
    bashFileWrites: trace?.tools.bashFileWrites ?? null,
    editToolCalls: trace ? (trace.tools.calls.edit ?? 0) + (trace.tools.calls.write ?? 0) : null,
    bashNonZero: trace?.tools.failureKinds.bashNonZero ?? null,
    invalidArgs: trace?.tools.failureKinds.invalidArgs ?? null,
    testRuns: trace?.loop.testRuns.length ?? null,
    fixCycles: trace?.loop.fixCycles ?? null,
    stuckTests: trace?.loop.stuckTests.length ?? null,
    repeatedCalls: trace?.circularity.repeatedCalls ?? null,
    rereads: trace?.circularity.rereadsUnchanged ?? null,
    editReverts: trace?.circularity.editReverts ?? null,
    repetitiveThinking: trace?.circularity.repetitiveThinking ?? null,
    verifiedAfterLastEdit: trace ? trace.verification.fullPassAfterLastEdit : null,
    browserChecks: trace ? trace.verification.browserCommands : null,
    screenshotViews: trace ? trace.verification.screenshots + trace.verification.viewedReferenceScreenshots : null,
    mcpCalls: trace?.frameworkTooling.mcpCalls ?? null,
    toolingCliCalls: trace?.frameworkTooling.toolingCliCalls ?? null,
    skillReads: trace?.frameworkTooling.skillReads.length ?? null,
    webSearches: trace?.frameworkTooling.webSearches.length ?? null,
    // extension tasks
    filesChanged: diff?.filesChanged ?? null,
    linesAdded: diff?.linesAdded ?? null,
    linesRemoved: diff?.linesRemoved ?? null,
    significantDelta: diff?.delta.significantLoc ?? null,
    conceptsAdded: diff?.concepts.added.length ?? null,
    featureFailures: finalTest ? featureFailures.length : null,
    regressions: finalTest ? finalTest.failures.length - featureFailures.length : null,
    judge: judgeScores(dir),
  };
}

function aggregate(its) {
  const keys = Object.keys(its[0]).filter((k) => typeof its.find((i) => i[k] !== null)?.[k] === 'number');
  const row = { n: its.length, passed: its.filter((i) => i.passed).length };
  for (const k of keys) row[k] = median(its.map((i) => i[k]));
  row.verifiedAfterLastEdit = its.filter((i) => i.verifiedAfterLastEdit).length;
  // Re-runs of the final tests (harness/retest.mjs): totals, not medians.
  row.retestRuns = its.reduce((n, i) => n + (i.retestRuns ?? 0), 0);
  row.retestPasses = its.reduce((n, i) => n + (i.retestPasses ?? 0), 0);
  // Like the blog post's tooling table: how many iterations used it at all.
  row.mcpRuns = its.filter((i) => i.mcpCalls > 0).length;
  row.skillRuns = its.filter((i) => i.skillReads > 0).length;
  row.toolCliRuns = its.filter((i) => i.toolingCliCalls > 0).length;
  row.judge = {};
  const dims = new Set(its.flatMap((i) => Object.keys(i.judge)));
  for (const d of dims) {
    const js = its.map((i) => i.judge[d]).filter(Boolean);
    const crit = new Set(js.flatMap((j) => Object.keys(j.criteria)));
    row.judge[d] = {
      overall: median(js.map((j) => j.overall)),
      criteria: Object.fromEntries([...crit].map((c) => [c, median(js.map((j) => j.criteria[c]))])),
      count: median(js.map((j) => j.count)),
    };
  }
  return row;
}

export function writeReport(runDir, { title } = {}) {
  const config = readJson(path.join(runDir, 'config.json'));
  const dirs = fs.readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /-\d+$/.test(d.name)).map((d) => path.join(runDir, d.name)).sort();
  const its = dirs.map(readIteration);
  const byFw = {};
  for (const it of its) (byFw[it.framework] ??= []).push(it);
  const rows = Object.entries(byFw).map(([framework, list]) => ({ framework, ...aggregate(list) }));
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ config, rows, iterations: its }, null, 2));

  const opus = runDir.startsWith(path.join(ROOT, 'baselines')) ? null : readJson(OPUS_SUMMARY);
  const opusRow = (fw) => opus?.rows.find((r) => r.framework === fw);
  const vs = (fw, key, d = 0) => (opusRow(fw)?.[key] != null ? ` (${fmt(opusRow(fw)[key], d)})` : '');
  const run = config?.run ?? {};
  // Opus was judged on its build-task apps, so its judge scores only compare with a build run.
  const opusJudge = (fw, d) => ((run.task ?? 'build') === 'build' ? opusRow(fw)?.judge?.[d] : null);
  const vsSame = (fw, key, scale = 1) => ((run.task ?? 'build') === 'build' && opusRow(fw)?.[key] != null ? ` (${fmt(opusRow(fw)[key], 0, scale)})` : '');
  const vsJudge = (fw, d, pick) => (opusJudge(fw, d) && pick(opusJudge(fw, d)) != null ? ` (${fmt(pick(opusJudge(fw, d)), 1)})` : '');

  const table = (heading, note, cols, filter = () => true) => {
    const rs = rows.filter(filter);
    if (!rs.length) return '';
    return [
      `## ${heading}`,
      '',
      note,
      '',
      `| Framework | ${cols.map((c) => c[0]).join(' | ')} |`,
      `| --- | ${cols.map(() => '---:').join(' | ')} |`,
      ...rs.sort((a, b) => (a.cost ?? a.significantLoc ?? 0) - (b.cost ?? b.significantLoc ?? 0)).map((r) => `| ${r.framework} | ${cols.map((c) => c[1](r)).join(' | ')} |`),
      '',
    ].join('\n');
  };
  const hasTrace = its.some((i) => i.turns !== null);
  const hasDiff = its.some((i) => i.filesChanged !== null);
  const dims = [...new Set(rows.flatMap((r) => Object.keys(r.judge)))].sort();

  const md = [
    `# ${title ?? `Pokédex benchmark: ${run.task ?? 'build'} task`}`,
    '',
    run.model ? `Model \`${run.model}\` (HF provider: ${run.hfProvider || 'auto'}), thinking \`${run.thinking}\`, pi ${run.piVersion}. ${run.iterations} iteration(s) per framework; values are medians.` : 'Values are medians across iterations.',
    opus ? `Values in parentheses are the Opus 5.5 medians from Nolan Lawson's published build-task runs${(run.task ?? 'build') === 'build' ? ', judged the same way' : ' (code size of the apps the extension started from)'}.` : '',
    '',
    hasTrace
      ? table('Agent cost and page loads (upstream metrics)', '`Tests`: the final acceptance run, as upstream. `Retests`: extra runs of the same tests in clean containers (harness/retest.mjs), to tell flaky results from real ones. Cost is pi\'s estimate from the model catalog prices, not an invoice. Lighthouse is the home page on mobile, as upstream' + (opus?.rows.some((r) => r.perfSame != null) && (run.task ?? 'build') === 'build' ? '; in parentheses, Opus 5.5\'s apps re-measured on the same machine.' : '.'), [
          ['Tests', (r) => `${r.passed}/${r.n}`],
          ['Retests', (r) => (r.retestRuns ? `${r.retestPasses}/${r.retestRuns}` : '—')],
          ['Tokens (M)', (r) => fmt(r.tokens, 2, 1e-6)],
          ['Output (k)', (r) => fmt(r.outputTokens, 0, 1e-3)],
          ['Cost ($)', (r) => fmt(r.cost, 2)],
          ['Time (min)', (r) => fmt(r.wallMin, 1)],
          ['Turns', (r) => fmt(r.turns)],
          ['Perf', (r) => `${fmt(r.perf, 0, 100)}${vsSame(r.framework, 'perfSame', 100)}`],
          ['LCP (ms)', (r) => `${fmt(r.lcp)}${vsSame(r.framework, 'lcpSame')}`],
          ['TBT (ms)', (r) => `${fmt(r.tbt)}${vsSame(r.framework, 'tbtSame')}`],
          ['JS (KiB)', (r) => `${fmt(r.jsKiB)}${vsSame(r.framework, 'jsKiBSame')}`],
        ])
      : '',
    table('Code size: significant code vs. lines', '`LOC` is upstream\'s count. `Significant` drops CSS, config/entry boilerplate, imports, type declarations, comments and bare punctuation/closing tags. `Concepts` counts distinct framework vocabulary (package imports, ambient APIs like runes or auto-imports, template directives, file conventions).', [
      ['LOC', (r) => `${fmt(r.upstreamLoc)}${vs(r.framework, 'upstreamLoc')}`],
      ['Significant', (r) => `${fmt(r.significantLoc)}${vs(r.framework, 'significantLoc')}`],
      ['Script', (r) => fmt(r.scriptLoc)],
      ['Template', (r) => fmt(r.templateLoc)],
      ['CSS', (r) => fmt(r.styleLoc)],
      ['Tokens (k)', (r) => fmt(r.tokensCode, 1, 1e-3)],
      ['Functions', (r) => fmt(r.functions)],
      ['Complexity', (r) => fmt(r.complexity)],
      ['Concepts', (r) => `${fmt(r.concepts)}${vs(r.framework, 'concepts')}`],
      ['Deps', (r) => fmt(r.dependencies)],
      ['Test cases', (r) => fmt(r.testCases)],
    ]),
    hasTrace
      ? table('Trace: failures, loops and verification', '`Edit/write`: edit and write tool calls; `Bash writes`: files changed through bash instead (sed -i, heredoc scripts, redirects). `Fix cycles`: failing test runs followed by edits and another run. `Stuck`: tests failing in 3+ consecutive runs. `Repeats`: identical tool calls. `Re-reads`: full reads of a file unchanged since the last read. `Reverts`: edits restoring text an earlier edit removed. `Loopy thinking`: thinking blocks mostly repeating an earlier one. `Verified`: iterations whose last code change was followed by a full passing test run.', [
          ['Tool calls', (r) => fmt(r.toolCalls)],
          ['Failed %', (r) => fmt(r.failedPct, 1)],
          ['Edit/write', (r) => fmt(r.editToolCalls)],
          ['Bash writes', (r) => fmt(r.bashFileWrites)],
          ['Edit misses', (r) => fmt(r.editMisses)],
          ['Bash ≠0', (r) => fmt(r.bashNonZero)],
          ['Test runs', (r) => fmt(r.testRuns)],
          ['Fix cycles', (r) => fmt(r.fixCycles)],
          ['Stuck', (r) => fmt(r.stuckTests)],
          ['Repeats', (r) => fmt(r.repeatedCalls)],
          ['Re-reads', (r) => fmt(r.rereads)],
          ['Reverts', (r) => fmt(r.editReverts)],
          ['Loopy thinking', (r) => fmt(r.repetitiveThinking)],
          ['Compactions', (r) => fmt(r.compactions)],
          ['Verified', (r) => `${r.verifiedAfterLastEdit}/${r.n}`],
          ['Browser', (r) => fmt(r.browserChecks)],
          ['MCP used', (r) => `${r.mcpRuns}/${r.n}`],
          ['Tool CLI used', (r) => `${r.toolCliRuns}/${r.n}`],
          ['Skills used', (r) => `${r.skillRuns}/${r.n}`],
          ['Searches', (r) => fmt(r.webSearches)],
        ])
      : '',
    hasDiff
      ? table('Extension task: the change', '`Files`: files changed in app/ (lockfiles excluded). `Δ significant`: change in significant LOC. `New concepts`: framework vocabulary the change introduced. `Feature fails` / `Regressions`: failing feature tests / failing original tests in the final run.', [
          ['Tests', (r) => `${r.passed}/${r.n}`],
          ['Files', (r) => fmt(r.filesChanged)],
          ['+ lines', (r) => fmt(r.linesAdded)],
          ['− lines', (r) => fmt(r.linesRemoved)],
          ['Δ significant', (r) => fmt(r.significantDelta)],
          ['New concepts', (r) => fmt(r.conceptsAdded)],
          ['Feature fails', (r) => fmt(r.featureFailures)],
          ['Regressions', (r) => fmt(r.regressions)],
        ])
      : '',
    dims.length
      ? table('Judge scores (1–5)', `Median of samples, then of iterations.${dims.includes('experimental') ? ' Experimentalness is descriptive, not better-is-higher: it is the `reach` criterion (5 = central features rest on experimental APIs, 1 = only long-stable APIs), and `n exp.` is the count of distinct experimental APIs.' : ''}`, dims.flatMap((d) => [
          [d, (r) => `${fmt(r.judge[d]?.overall, 1)}${vsJudge(r.framework, d, (j) => j.overall)}`],
          ...(d === 'experimental' ? [['n exp.', (r) => `${fmt(r.judge[d]?.count)}${vsJudge(r.framework, d, (j) => j.count).replace(/\.0\)$/, ')')}`]] : []),
        ]))
      : '',
    ...dims.map((d) => {
      const crit = [...new Set(rows.flatMap((r) => Object.keys(r.judge[d]?.criteria ?? {})))];
      return table(`Judge detail: ${d}`, '', crit.map((c) => [c, (r) => `${fmt(r.judge[d]?.criteria[c], 1)}${vsJudge(r.framework, d, (j) => j.criteria[c])}`]), (r) => r.judge[d]);
    }),
    '## Iterations',
    '',
    '| Iteration | Tests | Tokens (M) | Cost ($) | Turns | Significant LOC | Notes |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...its.map((i) => `| ${i.name} | ${i.passed ? 'pass' : 'fail'} | ${fmt(i.tokens, 2, 1e-6)} | ${fmt(i.cost, 2)} | ${fmt(i.turns)} | ${fmt(i.significantLoc)} | ${[i.timedOut && 'timed out', i.turnLimitHit && 'turn limit', i.compactions && `${i.compactions} compaction(s)`].filter(Boolean).join(', ')} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(runDir, 'report.md'), md);
}
