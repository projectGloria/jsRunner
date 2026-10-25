// Regression tests for the audit fixes: module semantics, loader identity and coverage,
// document-context resolution, diagnostics, and process lifecycle.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { transform, transformSelection } = require('../dist/transform');
const { execute } = require('../dist/execution');
const root = path.resolve(__dirname, '..');
const base = { runnerPath: path.join(root, 'dist/runner.js'), nodePath: process.execPath, timeoutMs: 3000, depth: 5 };

/** Writes `files` into a fresh folder; `main.js` is the editor document. */
function workspace(files) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'js-runner-audit-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), content);
  }
  const location = { ...base, cwd: folder, filename: path.join(folder, 'main.js') };
  return {
    folder,
    run: (code, overrides = {}) => execute({ ...location, ...overrides, ...transform(code) }).result,
    /** Runs the last occurrence of `selection` inside `document`, as the editor would. */
    select: (document, selection, overrides = {}) => {
      const start = document.lastIndexOf(selection);
      assert.notEqual(start, -1, 'selection must occur in document');
      return execute({ ...location, ...overrides, ...transformSelection(document, start, start + selection.length), document }).result;
    },
    dispose: () => fs.rmSync(folder, { recursive: true, force: true }),
  };
}

async function withWorkspace(files, body) {
  const ws = workspace(files);
  try { await body(ws); } finally { ws.dispose(); }
}

test('selections run in strict mode with module-like `this`', () => withWorkspace({}, async ({ run }) => {
  const leak = await run('undeclared = 5; globalThis.undeclared');
  assert.equal(leak.status, 'error');
  assert.match(leak.output, /ReferenceError: undeclared is not defined/);
  assert.match((await run('this === undefined')).output, /Result:\ntrue/);
}));

test('loaded declarations keep their strict module semantics', () => withWorkspace({
  'a.js': 'export function leak() { leaked = 1; }\nexport function self() { return this; }\n',
}, async ({ select }) => {
  const doc = 'import { leak, self } from "./a.js";\n';
  const leak = await select(doc + 'leak()', 'leak()');
  assert.equal(leak.status, 'error');
  assert.match(leak.output, /ReferenceError: leaked is not defined/);
  assert.match((await select(doc + 'self() === undefined', 'self() === undefined')).output, /Result:\ntrue/);
}));

test('each file evaluates once per run, preserving identity', () => withWorkspace({
  'a.js': 'export const list = [1, 2];\nexport const box = { list };\n',
  'shared.js': 'export const cfg = { n: 1 };\n',
  'x.js': 'import { cfg } from "./shared.js";\nexport const fromX = cfg;\n',
  'y.js': 'import { cfg } from "./shared.js";\nexport const fromY = cfg;\n',
}, async ({ select }) => {
  const twoStatements = 'import { list } from "./a.js";\nimport { box } from "./a.js";\nbox.list === list';
  assert.match((await select(twoStatements, 'box.list === list')).output, /Result:\ntrue/);
  const diamond = 'import { fromX } from "./x.js";\nimport { fromY } from "./y.js";\nfromX === fromY';
  assert.match((await select(diamond, 'fromX === fromY')).output, /Result:\ntrue/);
}));

test('initializers that cannot run user code are loaded', () => withWorkspace({
  'a.js': [
    'export const DAY = 24 * 60 * 60 * 1000;',
    'export const NEG = -Infinity;',
    'export const COLORS = Object.freeze({ red: "#f00", [1 + 1]: "two" });',
    'export const TAG = Symbol.for("tag");',
    'export const LOOKUP = new Map([["a", 1]]);',
    'const defaults = { retries: 3 };',
    'export const config = { ...defaults, verbose: false || true, mode: typeof DAY === "number" ? "ok" : "bad" };',
    'export const merged = [...[1, 2], 3];',
    'export const tau = Math.PI * 2;',
    'export const fs = require("node:fs");',
  ].join('\n'),
}, async ({ select }) => {
  const doc = 'import { DAY, NEG, COLORS, TAG, LOOKUP, config, merged, tau, fs } from "./a.js";\n';
  const expression = '[DAY, NEG, COLORS[2], typeof TAG, LOOKUP.get("a"), config.retries, config.mode, merged.length, tau.toFixed(2), typeof fs.readFileSync]';
  const result = await select(doc + expression, expression);
  assert.equal(result.status, 'success', result.output);
  assert.match(result.output, /86400000,\s+-Infinity,\s+'two',\s+'symbol',\s+1,\s+3,\s+'ok',\s+3,\s+'6.28',\s+'function'/);
}));

test('initializers that could run user code still fail closed', () => withWorkspace({
  'a.js': [
    'const obj = { valueOf() { globalThis.ran = true; return 1; } };',
    'export const coerced = obj + 1;',
    'export const called = Object.keys({});',
    'export const accessor = { get x() { return 1; } };',
  ].join('\n'),
}, async ({ select }) => {
  const doc = 'import { coerced, called, accessor } from "./a.js";\n';
  assert.match((await select(doc + 'coerced', 'coerced')).output, /without running initialization: operator coercing a non-primitive operand/);
  assert.match((await select(doc + 'called', 'called')).output, /without running initialization: CallExpression/);
  assert.match((await select(doc + 'accessor', 'accessor')).output, /without running initialization: getters or setters/);
}));

test('export * barrels, extensionless specifiers, and index files resolve', () => withWorkspace({
  'lib/values.js': 'export const list = [1, 2, 3];\nexport default "not re-exported by *";\n',
  'lib/index.js': 'export * from "./values.js";\n',
  'one.js': 'export const shared = 1;\n',
  'two.js': 'export const shared = 2;\n',
  'ambiguous.js': 'export * from "./one.js";\nexport * from "./two.js";\n',
  'util.js': 'export const v = "extensionless";\n',
}, async ({ select }) => {
  assert.match((await select('import { list } from "./lib/index.js";\nlist', 'list')).output, /\[ 1, 2, 3 \]/);
  assert.match((await select('import { list } from "./lib";\nlist', 'list')).output, /\[ 1, 2, 3 \]/);
  assert.match((await select('import { v } from "./util";\nv', 'v')).output, /'extensionless'/);
  const ambiguous = await select('import { shared } from "./ambiguous.js";\nshared', 'shared');
  assert.equal(ambiguous.status, 'error');
  assert.match(ambiguous.output, /more than one 'export \*' source/);
  const missing = await select('import { nope } from "./nowhere";\nnope', 'nope');
  assert.match(missing.output, /Cannot resolve "\.\/nowhere"/);
}));

test('default exports: expressions, anonymous functions, and identifiers', () => withWorkspace({
  'expr.js': 'const base = 2;\nexport default [base, base * 1];\n',
  'fn.js': 'export default function () { return "anon"; }\n',
}, async ({ select }) => {
  // `base * 1` is a coercion of a non-primitive identifier, so it must fail closed.
  assert.match((await select('import e from "./expr.js";\ne', 'e')).output, /operator coercing/);
  assert.match((await select('import f from "./fn.js";\nf()', 'f()')).output, /'anon'/);
}));

test('same-file declarations referenced by the selection are loaded from the buffer', () => withWorkspace({}, async ({ select, folder }) => {
  const marker = path.join(folder, 'side-effect');
  const doc = [
    'const base = 10;',
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`,
    'function scale(x) { return x * base; }',
    'scale(2)',
  ].join('\n');
  const result = await select(doc, 'scale(2)');
  assert.equal(result.status, 'success', result.output);
  assert.match(result.output, /Result:\n20/);
  assert.equal(fs.existsSync(marker), false, 'unselected statements must not run');
  // Unsafe same-file initializers explain themselves instead of a bare ReferenceError.
  const unsafe = await select('const data = JSON.parse("[]");\ndata.length', 'data.length');
  assert.match(unsafe.output, /Cannot load 'data' from main\.js without running initialization: CallExpression/);
}));

test('same-file resolution respects the selection position (no shadowed module bindings)', () => withWorkspace({}, async ({ select }) => {
  const doc = 'const x = 1;\nfunction twice(x) {\n  return x * 2;\n}\n';
  const result = await select(doc, 'x * 2');
  assert.equal(result.status, 'error');
  assert.match(result.output, /x is not defined/);
}));

test('built-in imports in the document are available to the selection', () => withWorkspace({}, async ({ select }) => {
  const doc = 'import fs, { readFileSync } from "node:fs";\nimport * as path from "node:path";\n[typeof fs.statSync, typeof readFileSync, path.sep.length]';
  assert.match((await select(doc, '[typeof fs.statSync, typeof readFileSync, path.sep.length]')).output, /\[ 'function', 'function', 1 \]/);
}));

test('a syntax error elsewhere in the file does not block a valid selection', () => withWorkspace({}, async ({ select }) => {
  const doc = 'const ok = 1 + 1;\nok * 3\nfunction broken( {';
  const transformed = transformSelection(doc, 0, doc.indexOf('\nfunction'), 'main.js');
  assert.equal(transformed.notice, undefined, 'self-contained selections need no notice');
  assert.match((await select(doc, 'const ok = 1 + 1;\nok * 3')).output, /Result:\n6/);
  const dependent = transformSelection(doc, doc.indexOf('ok * 3'), doc.indexOf('ok * 3') + 6, 'main.js');
  assert.match(dependent.notice, /main\.js isn't valid JavaScript as a whole/);
}));

test('stack traces point at editor lines, in the document and in loaded files', () => withWorkspace({
  'util.js': 'export function explode() {\n  // padding\n  throw new Error("from util");\n}\n',
}, async ({ select }) => {
  // Not the final expression: `return (` deliberately shifts columns on that one line.
  const doc = 'import { explode } from "./util.js";\n\n\n\n  null.boom;\n  1';
  const local = await select(doc, 'null.boom;\n  1');
  assert.match(local.output, /main\.js:5:8/);
  const imported = await select('import { explode } from "./util.js";\nexplode()', 'explode()');
  assert.match(imported.output, /util\.js:3:9/);
  // Neither the runner's internals nor the generated header line appear.
  for (const result of [local, imported]) {
    assert.doesNotMatch(result.output, /runner\.js|node:internal/);
  }
}));

test('error causes and aggregate errors are shown', () => withWorkspace({}, async ({ run }) => {
  const cause = await run('throw new Error("outer", { cause: new Error("ROOT CAUSE") })');
  assert.match(cause.output, /outer[\s\S]*\[cause\]: Error: ROOT CAUSE/);
  // Stripping internal frames must not orphan inspect()'s property-block braces.
  assert.equal(cause.output.split('{').length, cause.output.split('}').length, cause.output);
  // Only the user's own line remains: no wrapper line, Node built-in, or runner frames.
  const frames = cause.output.split('\n').filter(line => /^\s+at /.test(line));
  assert.ok(frames.length > 0, cause.output);
  for (const frame of frames) assert.match(frame, /main\.js:1:\d+$/, cause.output);
  const aggregate = await run('throw new AggregateError([new Error("first"), new Error("second")], "many")');
  assert.match(aggregate.output, /many[\s\S]*first[\s\S]*second/);
}));

test('a trailing function or class declaration displays its value', () => withWorkspace({}, async ({ run }) => {
  assert.match((await run('function add(a, b) { return a + b }')).output, /\[Function: add\]/);
  assert.match((await run('class Point {}')).output, /\[class Point\]/);
}));

test('leftover timers after a result keep the success status', () => withWorkspace({}, async ({ run }) => {
  const result = await run('setInterval(() => {}, 1000); 42', { timeoutMs: 300 });
  assert.equal(result.status, 'success', result.output);
  assert.match(result.output, /Result:\n42/);
  assert.match(result.output, /Result received\. The process was stopped at the 300 ms deadline/);
}));

test('status notes survive a full output cap, and cuts never split UTF-8', () => withWorkspace({}, async ({ folder }) => {
  // 3-byte characters after two ASCII bytes: (102400 - 2) % 3 === 2, so the cut lands mid-character.
  const pending = execute({ ...base, cwd: folder, filename: path.join(folder, 'main.js'), ...transform('process.stdout.write("xx" + "€".repeat(60000)); setInterval(() => {}, 1000)') });
  setTimeout(() => pending.cancel(), 500);
  const result = await pending.result;
  assert.equal(result.status, 'cancelled');
  assert.match(result.output, /Output truncated at 100 KB/);
  assert.match(result.output, /Execution cancelled\.$/);
  assert.doesNotMatch(result.output, /�/);
}));

test('a SIGTERM-ignoring snippet still stops at the deadline', () => withWorkspace({}, async ({ run }) => {
  // On POSIX this exercises the SIGKILL escalation; on Windows kill() is already forceful.
  const result = await run('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); await new Promise(() => {})', { timeoutMs: 300 });
  assert.equal(result.status, 'timeout');
}));

test('output streams before the run finishes, in order', () => withWorkspace({}, async ({ folder }) => {
  const chunks = [];
  let finished = false;
  const pending = execute({
    ...base, cwd: folder, filename: path.join(folder, 'main.js'),
    ...transform('console.log("first"); await new Promise(r => setTimeout(r, 300)); console.log("second"); 7'),
    onOutput: text => chunks.push({ text, finished }),
  });
  const result = await pending.result;
  finished = true;
  assert.ok(chunks.some(c => c.text.includes('first') && !c.finished));
  assert.equal(chunks.map(c => c.text).join(''), result.output);
  assert.ok(result.output.indexOf('first') < result.output.indexOf('second'));
}));
