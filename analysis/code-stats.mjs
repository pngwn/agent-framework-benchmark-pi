#!/usr/bin/env node
// "Significant code" analysis of one app directory: node analysis/code-stats.mjs <appDir>
//
// Upstream counts non-blank lines. That treats a closing `});`, an import line, a config
// file and a line of domain logic the same. This splits every source file into script,
// template and style regions (Svelte/Vue/Astro SFCs, html``/css`` tagged templates for
// Lit, JSX), parses scripts with the TypeScript compiler, and reports:
//
//   lines        per region and per kind of line (import, type, punctuation, comment, ...)
//   significant  lines a developer has to read and reason about to change behaviour: script
//                and template lines that aren't imports, type declarations, comments or
//                bare punctuation/closing tags, in files that aren't config/entry boilerplate
//   size         non-whitespace characters and lexical tokens (less sensitive to formatting
//                than lines), functions, statements, cyclomatic complexity
//   concepts     the distinct framework vocabulary the code relies on: named imports from
//                packages, ambient APIs used without an import (Svelte runes, Vue macros,
//                Nuxt auto-imports, Astro.*), template directives (bind:, v-if, @for, hx-*),
//                and framework file conventions (+page.server.ts, layout.tsx, $param.tsx)
//
// File kinds: source, config (tool config, *.d.ts, scaffold entry points), style, test,
// provided (copies of design/tokens.css), generated. Only `source` counts as significant.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = path.join(HERE, '../upstream/template/design/tokens.css');

const SOURCE_EXT = /\.([cm]?[jt]sx?|vue|svelte|astro|html|css|scss)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.output', '.next', '.nuxt', '.svelte-kit', '.astro', '.angular', '.vinxi', '.tanstack', 'test-results', 'playwright-report', 'coverage']);
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|tests?|e2e)\//;
const CONFIG_FILE = /(^|\/)([\w.-]+\.config\.[cm]?[jt]s|[\w.-]+\.d\.ts|entry[.-](client|server|ssr|dev|preview|express|node|bun|deno)\.[jt]sx?|vite-env\.d\.ts|app\.html|polyfills?\.[jt]s)$/;
const GENERATED = /automatically generated|auto-generated|@generated|do not edit/i;

// ---------- globals, so ambient framework APIs can be told apart from the platform ----------

const GLOBALS = (() => {
  const set = new Set(Object.getOwnPropertyNames(globalThis));
  const dom = fs.readFileSync(require.resolve('typescript/lib/lib.dom.d.ts'), 'utf8');
  for (const m of dom.matchAll(/^declare (?:var|function|const) (\w+)/gm)) set.add(m[1]);
  for (const g of ['process', 'require', 'module', 'exports', '__dirname', '__filename', 'Buffer', 'console', 'undefined', 'arguments', 'globalThis', 'window', 'document', 'NodeJS', 'import']) set.add(g);
  return set;
})();

// ---------- region splitting ----------

// Returns [{ kind: 'script'|'template'|'style', text, lang? }] for a file.
function regions(file, text) {
  const ext = path.extname(file);
  if (/\.(css|scss)$/.test(ext)) return [{ kind: 'style', text }];
  if (/\.[cm]?[jt]sx?$/.test(ext)) return [{ kind: 'script', text, lang: /x$/.test(ext) ? 'tsx' : 'ts' }];
  const out = [];
  let rest = text;
  const cut = (re, kind, lang) => {
    rest = rest.replace(re, (whole, inner) => {
      out.push({ kind, text: inner, lang });
      return whole.replace(/[^\n]/g, ' '); // blank it out of the template remainder
    });
  };
  if (ext === '.astro') cut(/^---\n([\s\S]*?)\n---/, 'script', 'ts');
  cut(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, 'script', 'ts');
  cut(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, 'style');
  out.push({ kind: 'template', text: rest });
  return out;
}

// ---------- script analysis ----------

function isInTypePosition(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
    if (ts.isStatement(p)) return false;
  }
  return false;
}

function analyzeScript(text, lang, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, lang === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const importLines = new Set();
  const typeLines = new Set();
  const embedded = []; // markup inside scripts (JSX, html``/css`` literals): [kind, startLine, endLine, text]
  const imports = new Set();
  const declared = new Set();
  const referenced = new Set();
  let functions = 0, statements = 0, complexity = 0, jsxElements = 0, classes = 0;

  const markLines = (set, node) => {
    for (let l = lineOf(node.getStart(sf)); l <= lineOf(node.end); l++) set.add(l);
  };
  let inMarkup = false;
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      markLines(importLines, node);
      const spec = node.moduleSpecifier?.text;
      // Package imports only: not relative paths, aliases ($lib, ~, @/) or package.json "imports" (#…).
      if (spec && !/^(\.|\/|\$lib|~|@\/|#)/.test(spec)) {
        const clause = node.importClause;
        if (clause?.name) imports.add(`${spec}#default`);
        const nb = clause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) imports.add(`${spec}#${(el.propertyName ?? el.name).text}`);
        if (nb && ts.isNamespaceImport(nb)) imports.add(`${spec}#*`);
        if (!clause && !node.exportClause) imports.add(`${spec}#(side-effect)`);
      }
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) markLines(typeLines, node);
    if (ts.isFunctionLike(node) && !ts.isFunctionTypeNode(node) && !ts.isMethodSignature(node) && !ts.isCallSignatureDeclaration(node) && !ts.isConstructSignatureDeclaration(node) && !ts.isIndexSignatureDeclaration(node) && 'body' in node && node.body) functions++;
    if (ts.isClassLike(node)) classes++;
    if (ts.isStatement(node) && !ts.isBlock(node) && !ts.isImportDeclaration(node) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) statements++;
    if (ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isCaseClause(node) || ts.isCatchClause(node) || ts.isConditionalExpression(node)) complexity++;
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) complexity++;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) jsxElements++;
    const isJsx = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
    const isTagged = ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && ['html', 'svg', 'css'].includes(node.tag.text);
    if (!inMarkup && (isJsx || isTagged)) {
      const target = isTagged ? node.template : node;
      embedded.push([isTagged && node.tag.text === 'css' ? 'style' : 'template', lineOf(target.getStart(sf)), lineOf(target.end), target.getText(sf)]);
      inMarkup = true;
      ts.forEachChild(node, visit);
      inMarkup = false;
      return;
    }
    // Declarations, for telling ambient identifiers from local ones.
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isParameter(node) || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node) || ts.isEnumDeclaration(node) || ts.isTypeParameterDeclaration(node) || ts.isBindingElement(node)) && node.name) {
      const collect = (n) => {
        if (ts.isIdentifier(n)) declared.add(n.text);
        else if (n.elements) n.elements.forEach((e) => e.name && collect(e.name));
      };
      collect(node.name);
    }
    if (ts.isIdentifier(node) && !isInTypePosition(node)) {
      const p = node.parent;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || (ts.isJsxAttribute(p) && p.name === node) || ts.isLabeledStatement(p);
      if (!isPropName) referenced.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Lexical tokens: the parse tree's leaves (JSX text counts one per word).
  let tokens = 0;
  const countTokens = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) tokens += (node.text.match(/\S+/g) ?? []).length;
    else if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken && node.kind !== ts.SyntaxKind.EndOfFileToken) tokens++;
    else for (const child of node.getChildren(sf)) countTokens(child);
  };
  countTokens(sf);

  const ambient = [...referenced].filter((n) => !declared.has(n) && !GLOBALS.has(n) && !/^(true|false|null|this|super)$/.test(n));
  return { importLines, typeLines, embedded, imports, ambient, functions, statements, complexity, jsxElements, classes, tokens };
}

// ---------- template analysis ----------

const DIRECTIVES = [
  [/\{#(if|each|await|key|snippet)\b/g, (m) => `svelte {#${m[1]}}`],
  [/\{@(html|render|const|debug|attach)\b/g, (m) => `svelte {@${m[1]}}`],
  [/\s(bind|on|use|class|style|transition|in|out|animate|let):[\w-]+/g, (m) => `${m[1]}:`],
  [/\sv-([\w-]+)/g, (m) => `v-${m[1]}`],
  [/\s([:@#])[\w.[\]-]+=/g, (m) => ({ ':': 'v-bind (:)', '@': '@event', '#': 'v-slot (#)' })[m[1]]],
  [/@(if|for|switch|defer|let|else|empty|case)\b/g, (m) => `angular @${m[1]}`],
  [/\*ng(\w+)/g, (m) => `*ng${m[1]}`],
  [/\s\[\(?[\w.-]+\)?\]=/g, () => 'angular [binding]'],
  [/\s\(([\w.-]+)\)=/g, () => 'angular (event)'],
  [/\s(client|server|set|is|define|transition):[\w-]+/g, (m) => `astro ${m[1]}:`],
  [/\shx-([\w-]+)/g, (m) => `hx-${m[1]}`],
  [/\s([.?@])[\w-]+=\$\{/g, (m) => `lit ${m[1]}binding`],
];

function analyzeTemplate(text) {
  const directives = new Set();
  for (const [re, name] of DIRECTIVES) for (const m of text.matchAll(re)) directives.add(name(m));
  return {
    elements: (text.match(/<[a-zA-Z][\w:.-]*/g) ?? []).length,
    expressions: (text.match(/\{\{|\{[^}\s#/:@]|\$\{/g) ?? []).length,
    tokens: (text.match(/[\w$-]+|[^\s\w]/g) ?? []).length,
    directives,
  };
}

// ---------- line classification ----------

const PUNCT_ONLY = /^[\s{}()[\];,.:>]*$|^\s*<\/[\w:.-]+>\s*$|^\s*\/?>\s*$/;
const COMMENT = /^\s*(\/\/|\/\*|\*|\*\/|<!--|-->)/;

// script: line sets from analyzeScript; markup: line index -> 'template'|'style' for markup
// embedded in a script. Template lines are counted in `template`, style lines in `style`;
// `code` and `punctuation` include both script and template lines.
function classifyLines(text, script, markup = new Map()) {
  const counts = { total: 0, blank: 0, comment: 0, punctuation: 0, import: 0, type: 0, code: 0, template: 0, style: 0 };
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return counts.blank++;
    counts.total++;
    const m = markup.get(i);
    if (m === 'style') counts.style++;
    else if (m === 'template') {
      counts.template++;
      if (PUNCT_ONLY.test(line) || COMMENT.test(line)) counts.punctuation++;
      else counts.code++;
    } else if (script?.importLines.has(i)) counts.import++;
    else if (script?.typeLines.has(i)) counts.type++;
    else if (COMMENT.test(line)) counts.comment++;
    else if (PUNCT_ONLY.test(line)) counts.punctuation++;
    else counts.code++;
  });
  return counts;
}

// ---------- conventions ----------

const CONVENTION_NAMES = new Set(['page', 'layout', 'error', 'loading', 'not-found', 'route', 'template', 'default', 'middleware', 'root', 'app', 'document', 'head', 'global-error', 'forbidden', 'unauthorized', 'server', 'hooks.server', 'hooks.client', 'hooks', 'index']);
function convention(rel) {
  const inRoutes = /(^|\/)(routes|pages|app|layouts|middleware|server\/(api|routes))\//.test(rel);
  const base = path.basename(rel).replace(/\.[^.]+$/, '').replace(/\.(server|client|universal)$/, '.$1');
  const norm = base.replace(/\[\.\.\.[^\]]+\]/g, '[...rest]').replace(/\[\[?[^\]]+\]?\]/g, '[param]').replace(/^\$[\w-]+/, '$param').replace(/\(([^)]+)\)/g, '(group)');
  if (/^[+_]/.test(norm) || norm.startsWith('$') || norm.startsWith('__')) return `${norm}${path.extname(rel)}`;
  if (inRoutes && (CONVENTION_NAMES.has(norm) || /\[/.test(norm))) return `${inRoutes ? 'route ' : ''}${norm}${path.extname(rel)}`;
  return null;
}

// ---------- main ----------

// Same file set as upstream (tracked and untracked-but-not-ignored files) when the app is
// in a git repo; a plain walk otherwise.
function listFiles(dir) {
  const git = spawnSync('git', ['-c', 'safe.directory=*', 'ls-files', '--cached', '--others', '--exclude-standard', '.'], { cwd: dir, encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim()) {
    return git.stdout
      .split('\n')
      .filter((f) => f && SOURCE_EXT.test(f) && !f.split('/').some((p) => SKIP_DIRS.has(p)) && fs.existsSync(path.join(dir, f)))
      .map((f) => path.join(dir, f))
      .sort();
  }
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name));
      } else if (SOURCE_EXT.test(e.name)) out.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return out.sort();
}

export function codeStats(appDir) {
  const provided = fs.existsSync(TOKENS_CSS) ? fs.readFileSync(TOKENS_CSS, 'utf8').trim() : null;
  const files = [];
  const concepts = { imports: new Set(), ambient: new Set(), directives: new Set(), conventions: new Set() };
  const experimental = [];
  const tests = { files: 0, cases: 0, assertions: 0 };

  for (const abs of listFiles(appDir)) {
    const rel = path.relative(appDir, abs).split(path.sep).join('/');
    const text = fs.readFileSync(abs, 'utf8');
    let kind = 'source';
    if (TEST_FILE.test(rel)) kind = 'test';
    else if (provided && text.trim() === provided) kind = 'provided';
    else if (GENERATED.test(text.slice(0, 500))) kind = 'generated';
    else if (CONFIG_FILE.test(rel)) kind = 'config';
    else if (/\.(css|scss)$/.test(rel)) kind = 'style';

    const f = { path: rel, kind, rawLines: text.split('\n').filter((l) => l.trim()).length, lines: { script: 0, template: 0, style: 0 }, classes: { comment: 0, punctuation: 0, import: 0, type: 0, code: 0 }, significant: 0, chars: text.replace(/\s/g, '').length, tokens: 0, functions: 0, statements: 0, complexity: 0, elements: 0 };
    if (kind === 'test') {
      tests.files++;
      tests.cases += (text.match(/(^|[^\w.])(it|test)(\.(only|skip|each\([^)]*\)))?\s*\(/g) ?? []).length;
      tests.assertions += (text.match(/\bexpect(\.\w+)?\(|\bassert(\.\w+)?\(/g) ?? []).length;
    }
    // Opt-ins to unstable APIs, for the experimentalness judge to start from.
    if (kind !== 'test' && kind !== 'provided') {
      text.split('\n').forEach((line, i) => {
        if (/\bexperimental\b|\bunstable_\w+|\b__unstable|\w+_UNSTABLE\b|\bexperimental_\w+|\bpreview\s*:/i.test(line)) experimental.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    const conv = convention(rel);
    if (conv && kind === 'source') concepts.conventions.add(conv);

    for (const r of regions(rel, text)) {
      if (r.kind === 'style') {
        f.lines.style += r.text.split('\n').filter((l) => l.trim()).length;
        continue;
      }
      if (r.kind === 'script') {
        const s = analyzeScript(r.text, r.lang, rel);
        // JSX and html``/css`` literals inside scripts are template/style, not script.
        const markup = new Map();
        for (const [ek, from, to, etext] of s.embedded) {
          for (let l = from; l <= to; l++) markup.set(l, ek);
          if (ek === 'template' && kind === 'source') analyzeTemplate(etext).directives.forEach((d) => concepts.directives.add(d));
        }
        const c = classifyLines(r.text, s, markup);
        f.lines.script += c.total - c.template - c.style;
        f.lines.template += c.template;
        f.lines.style += c.style;
        for (const k of Object.keys(f.classes)) f.classes[k] += c[k];
        f.significant += c.code;
        f.tokens += s.tokens;
        f.functions += s.functions;
        f.statements += s.statements;
        f.complexity += s.complexity;
        f.elements += s.jsxElements;
        if (kind === 'source') {
          s.imports.forEach((i) => concepts.imports.add(i));
          s.ambient.forEach((a) => concepts.ambient.add(a));
        }
      } else {
        const t = analyzeTemplate(r.text);
        const c = classifyLines(r.text);
        f.lines.template += c.total;
        f.classes.comment += c.comment;
        f.classes.punctuation += c.punctuation;
        f.classes.code += c.code;
        f.significant += c.code;
        f.tokens += t.tokens;
        f.elements += t.elements;
        if (kind === 'source') t.directives.forEach((d) => concepts.directives.add(d));
      }
    }
    if (kind !== 'source') f.significant = 0;
    files.push(f);
  }

  const sum = (pred, get) => files.filter(pred).reduce((n, f) => n + get(f), 0);
  const src = (f) => f.kind === 'source';
  let deps = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    deps = { dependencies: Object.keys(pkg.dependencies ?? {}), devDependencies: Object.keys(pkg.devDependencies ?? {}) };
  } catch {}

  const conceptLists = Object.fromEntries(Object.entries(concepts).map(([k, v]) => [k, [...v].sort()]));
  return {
    totals: {
      files: files.length,
      sourceFiles: files.filter(src).length,
      // Upstream's number, for comparison: non-blank lines of every non-test, non-provided, non-generated file.
      upstreamLoc: sum((f) => !['test', 'provided', 'generated'].includes(f.kind), (f) => f.rawLines),
      significantLoc: sum(src, (f) => f.significant),
      scriptLoc: sum(src, (f) => f.lines.script),
      templateLoc: sum(src, (f) => f.lines.template),
      styleLoc: sum(() => true, (f) => (f.kind === 'provided' ? 0 : f.lines.style)),
      configLoc: sum((f) => f.kind === 'config', (f) => f.lines.script + f.lines.template),
      testLoc: sum((f) => f.kind === 'test', (f) => f.lines.script),
      importLines: sum(src, (f) => f.classes.import),
      typeLines: sum(src, (f) => f.classes.type),
      punctuationLines: sum(src, (f) => f.classes.punctuation),
      commentLines: sum(src, (f) => f.classes.comment),
      chars: sum(src, (f) => f.chars),
      tokens: sum(src, (f) => f.tokens),
      functions: sum(src, (f) => f.functions),
      statements: sum(src, (f) => f.statements),
      complexity: sum(src, (f) => f.complexity),
      elements: sum(src, (f) => f.elements),
      concepts: Object.values(conceptLists).reduce((n, l) => n + l.length, 0),
      dependencies: (deps.dependencies?.length ?? 0) + (deps.devDependencies?.length ?? 0),
    },
    concepts: conceptLists,
    deps,
    experimental,
    tests: {
      ...tests,
      runner: ['vitest', 'jest', '@playwright/test', 'playwright', 'mocha', 'ava', 'uvu', '@web/test-runner', 'karma', 'jasmine-core', '@angular/build'].filter((r) => [...(deps.dependencies ?? []), ...(deps.devDependencies ?? [])].includes(r)),
      script: (() => { try { return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).scripts?.test ?? null; } catch { return null; } })(),
    },
    files,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stats = codeStats(path.resolve(process.argv[2]));
  const { files, ...summary } = stats;
  console.log(JSON.stringify(process.argv.includes('--files') ? stats : summary, null, 2));
}
