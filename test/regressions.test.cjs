// One test per finding of the November 2026 audit, each written as the original repro.
// Ids (C1, H2, …) match the audit report.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { transform, transformSelection } = require('../dist/transform');
const { execute } = require('../dist/execution');
const root = path.resolve(__dirname, '..');
const base = { runnerPath: path.join(root, 'dist/runner.js'), nodePath: process.execPath, timeoutMs: 3000, depth: 5 };

async function withWorkspace(files, body) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'js-runner-regression-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), content);
  const location = { ...base, cwd: folder, filename: path.join(folder, 'main.js') };
  const ws = {
    folder,
    run: (code, overrides = {}) => execute({ ...location, ...overrides, ...transform(code) }).result,
    /** Runs `selection` where it occurs in `document` (the first occurrence unless `last`). */
    select: (document, selection, { last = false, ...overrides } = {}) => {
      const start = last ? document.lastIndexOf(selection) : document.indexOf(selection);
      assert.notEqual(start, -1, 'selection must occur in document');
      return execute({ ...location, ...overrides, ...transformSelection(document, start, start + selection.length, 'main.js') }).result;
    },
  };
  try { await body(ws); } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

const lit = value => JSON.stringify(value);

// --- Critical: code you didn't select must never run -------------------------------------

test('C1: top-level calls on imported bindings are never executed', () => withWorkspace({}, async ({ folder, select }) => {
  const victim = path.join(folder, 'important.db');
  fs.writeFileSync(victim, 'data');
  const doc = `import fs from "node:fs";\nfs.existsSync(${lit(victim)})\nfs.rmSync(${lit(victim)});`;
  const result = await select(doc, `fs.existsSync(${lit(victim)})`);
  assert.match(result.output, /Result:\ntrue/);
  assert.ok(fs.existsSync(victim), 'a line below the selection deleted the file');
  const pwned = path.join(folder, 'pwn.txt');
  const exec = `import cp from "node:child_process";\ncp.execSync("node -e \\"require('fs').writeFileSync(${lit(pwned).replace(/"/g, '\\\\\\"')}, 'x')\\"");\ntypeof cp`;
  assert.match((await select(exec, 'typeof cp')).output, /'object'/);
  assert.ok(!fs.existsSync(pwned), 'an unselected execSync ran');
}));

test('C2: methods and callbacks on loaded values never run during loading', () => withWorkspace({}, async ({ folder, select }) => {
  const victim = path.join(folder, 'precious.txt');
  fs.writeFileSync(victim, 'data');
  const store = `const store = {\n  items: [1],\n  clear() { require("node:fs").rmSync(${lit(victim)}); },\n};\n`;
  // Below the selection: never relevant. Above it: reported, still not run.
  await select(`${store}store\nstore.clear();`, 'store');
  await select(`${store}store.clear();\nstore`, 'store', { last: true });
  assert.ok(fs.existsSync(victim), 'store.clear() ran');
  const sorted = await select('const nums = [3, 1, 2];\nnums.sort((a, b) => { console.log("COMPARATOR RAN"); return a - b; });\nnums[0]', 'nums[0]');
  // The note quotes the statement; the comparator itself must never print.
  assert.doesNotMatch(sorted.output, /^COMPARATOR RAN$/m);
  assert.match(sorted.output, /main\.js:2 {2}nums\.sort/);
}));

test('C3: statements below the selection are not replayed', () => withWorkspace({}, async ({ select }) => {
  assert.match((await select('const list = [1, 2];\nlist.length\nlist.push(3);', 'list.length')).output, /Result:\n2\n/);
}));

test('C4: iteration, Map/Set construction, and compound assignment cannot reach user code', () => withWorkspace({}, async ({ select }) => {
  const iterable = 'const it = { *[Symbol.iterator]() { console.log("USER ITERATOR RAN"); yield 1; } };\n';
  for (const [declaration, use] of [['const arr = [...it];', 'arr'], ['const s = new Set(it);', 's'], ['const m = new Map(it);', 'm']]) {
    const result = await select(`${iterable}${declaration}\n${use}`, use, { last: true });
    assert.equal(result.status, 'error', result.output);
    assert.doesNotMatch(result.output, /USER ITERATOR RAN/);
    assert.match(result.output, /iterable that may run user code/);
  }
  const coerced = await select('const user = { toString() { console.log("TOSTRING RAN"); return "u"; } };\nlet label = "hi ";\nlabel += user;\nlabel', 'label', { last: true });
  assert.doesNotMatch(coerced.output, /TOSTRING RAN/);
  assert.match(coerced.output, /main\.js:3 {2}label \+= user;/);
}));

// --- High: values must match what the file computes ----------------------------------------

test('H1: a selected mutation runs once', () => withWorkspace({}, async ({ select }) => {
  assert.match((await select('const a = [];\na.push(1); a', 'a.push(1); a')).output, /Result:\n\[ 1 \]\n/);
}));

test('H2: the selection and loaded functions share live bindings, across files too', () => withWorkspace({
  'c.js': 'export let count = 0;\nexport function inc() { count++; }\n',
}, async ({ select }) => {
  assert.match((await select('let count = 0;\nfunction inc() { count++; }\ninc(); count', 'inc(); count')).output, /Result:\n1\n/);
  assert.match((await select('let mode = 1;\nfunction getMode() { return mode; }\n(mode = 5, getMode())', '(mode = 5, getMode())')).output, /Result:\n5\n/);
  assert.match((await select('import { count, inc } from "./c.js";\ninc(); inc(); count', 'inc(); inc(); count')).output, /Result:\n2\n/);
}));

test('H3: const bindings stay constant', () => withWorkspace({ 'k.js': 'export const K = 1;\n' }, async ({ select }) => {
  for (const [doc, selection] of [['const MAX = 5;\n(MAX = 6, MAX)', '(MAX = 6, MAX)'], ['import { K } from "./k.js";\n(K = 2, K)', '(K = 2, K)']]) {
    const result = await select(doc, selection);
    assert.equal(result.status, 'error', result.output);
    assert.match(result.output, /TypeError: Assignment to constant variable\./);
  }
}));

test('H4: a partial replay is never silent', () => withWorkspace({}, async ({ select }) => {
  const result = await select('const xs = [];\nfor (let i = 0; i < 3; i++) xs.push(i);\nxs.push(99);\nxs', 'xs', { last: true });
  assert.match(result.output, /^Note: automatic context skipped/);
  assert.match(result.output, /main\.js:2 {2}for \(let i = 0; i < 3; i\+\+\) xs\.push\(i\); {2}\(may change xs\)/);
  // The replayable update still applies.
  assert.match(result.output, /Result:\n\[ 99 \]\n/);
  // Primitive counters replay exactly.
  assert.equal((await select('let n = 0;\nn++;\nn += 2;\nn', 'n', { last: true })).output, '\nResult:\n3\n');
}));

test('H5: a read-only top-level call no longer makes a value unloadable', () => withWorkspace({}, async ({ select }) => {
  const result = await select('const users = ["a", "b"];\nusers.forEach(u => u);\nusers.length', 'users.length');
  assert.equal(result.status, 'success', result.output);
  assert.match(result.output, /Result:\n2\n/);
}));

test('H6: the throwing frame survives next to the selection', () => withWorkspace({}, async ({ select }) => {
  const above = await select('function boom() { throw new Error("x"); }\nboom()', 'boom()', { last: true });
  assert.match(above.output, /at boom \(.*main\.js:1:25\)/);
  const below = await select('boom()\nfunction boom() { throw new Error("x"); }', 'boom()');
  assert.match(below.output, /at boom \(.*main\.js:2:25\)/);
}));

test('a free name the document binds elsewhere never reaches a module binding', () => withWorkspace({}, async ({ select }) => {
  // `x` in the selection is twice's parameter; module `x` is loaded only because `y` needs it.
  const result = await select('const x = 1;\nconst y = x;\nfunction twice(x) {\n  return [x, y];\n}', '[x, y]');
  assert.equal(result.status, 'error', result.output);
  assert.match(result.output, /ReferenceError: Cannot access 'x' before initialization/);
}));

test('calls to imported functions keep `this` undefined', () => withWorkspace({
  'a.js': 'export function self() { return this; }\n',
  'b.js': 'import { self } from "./a.js";\nexport function viaImport() { return self(); }\n',
}, async ({ select }) => {
  assert.match((await select('import { viaImport } from "./b.js";\nviaImport() === undefined', 'viaImport() === undefined')).output, /Result:\ntrue/);
  assert.match((await select('import { self } from "./a.js";\nself`tag` === undefined', 'self`tag` === undefined')).output, /Result:\ntrue/);
}));

// --- Medium -----------------------------------------------------------------------------------

test('M1: an out-of-range timeout cannot make every run time out', () => withWorkspace({}, async ({ run }) => {
  for (const timeoutMs of [3e9, Number.NaN, 0]) {
    const result = await run('await new Promise(r => setTimeout(r, 50)); 1', { timeoutMs });
    assert.equal(result.status, timeoutMs === 0 ? 'timeout' : 'success', `${timeoutMs}: ${result.output}`);
  }
}));

test('M3: stdout and stderr keep their order', () => withWorkspace({}, async ({ run }) => {
  const result = await run('for (let i = 0; i < 50; i++) { console.log("o" + i); console.error("e" + i); }');
  const expected = Array.from({ length: 50 }, (_, i) => `o${i}\ne${i}`).join('\n');
  assert.equal(result.output.trim(), expected);
}));

test('M4: late async errors are reported cleanly', () => withWorkspace({}, async ({ run }) => {
  const result = await run('Promise.reject(new Error("bg")); 5');
  assert.equal(result.status, 'error');
  assert.match(result.output, /Result:\n5\n[\s\S]*Uncaught Error: bg\n {4}at .*main\.js:1:16/);
  assert.doesNotMatch(result.output, /runner\.js|node:internal|return \[/);
}));

test('M5: the extension host never parses the document', () => {
  const big = fs.readFileSync(path.join(root, 'node_modules/typescript/lib/typescript.js'), 'utf8');
  const doc = `${big}\n1 + 1\n}}} not javascript {{{`;
  const start = doc.lastIndexOf('1 + 1');
  const began = performance.now();
  transformSelection(doc, start, start + 5, 'big.js');
  assert.ok(performance.now() - began < 100, `took ${performance.now() - began} ms`);
});

test('M6: a grandchild holding the output pipe cannot hang the run', () => withWorkspace({}, async ({ run }) => {
  // Detached, so it escapes even Windows' job object and keeps the inherited pipe open.
  const result = await run('const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "inherit", detached: true, cwd: require("node:os").tmpdir() }); console.log("PID=" + c.pid); 1', { timeoutMs: 500 });
  const pid = Number(/PID=(\d+)/.exec(result.output)?.[1]);
  try { process.kill(pid); } catch { /* already gone (POSIX group kill) */ }
  assert.equal(result.status, 'success', result.output);
}));

// --- Low --------------------------------------------------------------------------------------

test('L1: a thenable result is shown, not awaited forever; promises still are', () => withWorkspace({}, async ({ run }) => {
  const thenable = await run('({ then() {} })', { timeoutMs: 1000 });
  assert.equal(thenable.status, 'success', thenable.output);
  assert.match(thenable.output, /then: \[Function: then\]/);
  assert.match((await run('Promise.resolve(42)')).output, /Result:\n42\n/);
}));

test('L3: process.exit(0) is not reported as a failure', () => withWorkspace({}, async ({ run }) => {
  const result = await run('console.log("bye"); process.exit(0)');
  assert.equal(result.status, 'success', result.output);
  assert.match(result.output, /exited \(code 0\) before the selection finished/);
}));

test('L5: columns on the final expression line are the editor columns', () => withWorkspace({}, async ({ select }) => {
  assert.match((await select('const a = 1;\n  null.boom', '  null.boom')).output, /main\.js:2:8/);
}));

test('L6: syntax errors name editor positions and the real cause', () => withWorkspace({}, async () => {
  const doc = 'function f(x) {\n  return x * 2;\n}';
  assert.throws(() => transformSelection(doc, doc.indexOf('return'), doc.indexOf(';') + 1),
    /Invalid JavaScript at line 2, column 3: 'return' outside of function\. A selection runs as top-level code/);
  assert.throws(() => transform('import.meta.url'), /import\.meta is unavailable/);
}));

test('L7: no note for a self-contained selection in a broken file', () => withWorkspace({}, async ({ select }) => {
  const result = await select('const x = ;\nrequire("node:os").platform().length > 0', 'require("node:os").platform().length > 0');
  assert.equal(result.output, '\nResult:\ntrue\n');
}));

test('L8: an object literal alone is an object, like the REPL', () => withWorkspace({}, async ({ run }) => {
  assert.match((await run('{ a: 1 }')).output, /Result:\n\{ a: 1 \}/);
  assert.equal((await run('{ console.log("block") }')).output, 'block\n');
}));

test('L9: the snippet cannot impersonate the runner', () => withWorkspace({}, async ({ run }) => {
  const result = await run('process.send({ type: "result", hasValue: true, text: "FAKE" }); throw new Error("real")');
  assert.equal(result.status, 'error');
  assert.doesNotMatch(result.output, /FAKE/);
}));

test('L10: whitespace-only output is shown as is', () => withWorkspace({}, async ({ run }) => {
  assert.equal((await run('console.log("   ")')).output, '   \n');
}));

test('L13: the snippet gets no VS Code-internal environment', () => withWorkspace({}, async ({ run }) => {
  process.env.ELECTRON_RUN_AS_NODE = '1';
  process.env.VSCODE_PID = '123';
  try {
    assert.match((await run('[process.env.ELECTRON_RUN_AS_NODE, process.env.VSCODE_PID]')).output, /\[ undefined, undefined \]/);
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.VSCODE_PID;
  }
}));

test('selections ending in a line comment, or starting with a hashbang, still compile', () => withWorkspace({}, async ({ run, select }) => {
  assert.match((await run('const a = 1 // trailing')).output, /\{ a: 1 \}/);
  assert.match((await run('#!/usr/bin/env node\n2 + 2')).output, /Result:\n4/);
  assert.match((await select('const b = 2;\nb * 2 // why', 'b * 2 // why')).output, /Result:\n4/);
}));
