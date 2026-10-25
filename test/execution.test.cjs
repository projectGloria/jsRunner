const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { transform, transformSelection } = require('../dist/transform');
const { execute } = require('../dist/execution');
const cwd = path.resolve(__dirname, '..');
const options = { cwd, filename: path.join(cwd, 'example.js'), runnerPath: path.join(cwd, 'dist/runner.js'), nodePath: process.execPath, timeoutMs: 3000, depth: 5 };
const run = (code, overrides = {}) => execute({ ...options, ...overrides, ...transform(code) }).result;
const runSelection = (document, start, end, overrides = {}) => execute({ ...options, ...overrides, ...transformSelection(document, start, end), document }).result;

test('expressions, promises, await, and declarations', async () => {
  for (const [code, expected] of [
    ['2 + 3', '5'],
    ['Promise.resolve(42)', '42'],
    ['await Promise.resolve(17)', '17'],
    ['const user = {name: "Nihil", greet() { throw Error("Do not invoke"); }};', "name: 'Nihil'"],
    ['const {a, nested: {b}, ...rest} = {a: 1, nested: {b: 2}, c: 3};', 'b: 2'],
    ['let [first, , ...tail] = [1, 2, 3, 4];', 'tail: [ 3, 4 ]'],
    ['function square(x) { return x*x; } square(6);', '36'],
    ['const a = {}; a.self = a; a;', '[Circular *1]'],
    ['// comment\nconst value = 4 // trailing comment', 'value: 4'],
    ['let count = 0; (++count)', '1'],
  ]) {
    const result = await run(code);
    assert.equal(result.status, 'success', result.output);
    assert.ok(result.output.includes(expected), result.output);
  }
});
test('captures console output and asynchronous timers', async () => {
  const result = await run('console.log("hello"); console.error("oops"); setTimeout(() => console.log("later"), 20); 7');
  assert.equal(result.status, 'success');
  for (const value of ['hello', 'oops', 'later', '7']) assert.ok(result.output.includes(value), result.output);
});
test('log-only snippets omit undefined results without hiding real values', async () => {
  const logs = await run('console.log("asdasd"); console.log("asdasd2");');
  assert.equal(logs.status, 'success');
  assert.equal(logs.output, 'asdasd\nasdasd2\n');
  assert.equal((await run('void 0')).output, 'Execution completed.');
  for (const code of ['null', 'false', '0', '""']) {
    assert.match((await run(code)).output, /Result:/);
  }
  assert.match((await run('console.log(undefined)')).output, /^undefined\n$/);
});
test('resolves require and dynamic import from selected file location', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'js-runner-test-'));
  try {
    fs.writeFileSync(path.join(folder, 'dep.cjs'), 'module.exports = {value: 73}');
    fs.writeFileSync(path.join(folder, 'esm.mjs'), 'export default 91;');
    const location = { cwd: folder, filename: path.join(folder, 'unsaved.js') };
    assert.match((await run('require("./dep.cjs").value', location)).output, /73/);
    const result = await run('(await import("./esm.mjs")).default', location);
    assert.equal(result.status, 'success', result.output);
    assert.match(result.output, /91/);
  } finally { fs.rmSync(folder, { recursive: true }); }
});
test('fresh state, runtime errors, and syntax diagnostics', async () => {
  await run('globalThis.privateValue = 3');
  assert.match((await run('typeof globalThis.privateValue')).output, /undefined/);
  assert.equal((await run('missingVariable')).status, 'error');
  assert.throws(() => transform('const = '), /Invalid JavaScript/);
  assert.throws(() => transform('export default 1'), /Export statements/);
  assert.match((await run('import fs from "node:fs"; typeof fs.readFile')).output, /function/);
  assert.throws(() => transform('const x: number = 1'), /TypeScript/);
});
test('timeout and cancellation terminate runaway code', async () => {
  assert.equal((await run('while (true) {}', { timeoutMs: 200 })).status, 'timeout');
  assert.equal((await run('await new Promise(() => {})', { timeoutMs: 200 })).status, 'timeout');
  const pending = execute({ ...options, ...transform('setInterval(() => {}, 1000)') });
  setTimeout(() => pending.cancel(), 100);
  assert.equal((await pending.result).status, 'cancelled');
});
test('output is bounded, and missing Node is actionable', async () => {
  const large = await run('console.log("x".repeat(200000)); 1');
  assert.match(large.output, /Output truncated/);
  assert.ok(Buffer.byteLength(large.output) < 103000);
  const missing = await run('1', { nodePath: path.join(cwd, 'missing-node-executable') });
  assert.equal(missing.status, 'error');
  assert.match(missing.output, /Node Path/);
});

test('automatic imports load only needed declarations and skip unrelated side effects', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'js-runner-imports-'));
  try {
    fs.writeFileSync(path.join(folder, 'numbers.js'), 'export const numberz = [1, 2, 3, 4, 5, 6];');
    fs.writeFileSync(path.join(folder, 'util.js'), 'export { numberz } from "./numbers.js"; console.log("module loaded"); export default ["a", "b", "c"];');
    fs.writeFileSync(path.join(folder, 'init.js'), 'globalThis.initialized = 42;');
    const document = 'import hobbies, { numberz } from "./util.js";\nimport { numberz as alias } from "./util.js";\nimport * as unused from "./util.js";\nimport "./init.js";\nhobbies.push("DO NOT RUN");\nthrow Error("unselected code ran");\nconst evenNumbers = numberz.filter(f => f % 2 === 0);\nconsole.log(evenNumbers, hobbies.length, alias.length, typeof globalThis.initialized);';
    const location = { ...options, cwd: folder, filename: path.join(folder, 'methods.js') };
    const result = await runSelection(document, document.indexOf('const evenNumbers'), document.length, location);
    assert.equal(result.status, 'success', result.output);
    assert.equal(result.output, '[ 2, 4, 6 ] 4 6 undefined\n');
    // Selecting an import itself does not duplicate the inherited binding.
    const whole = 'import hobbies, { numberz } from "./util.js";\nnumberz.length + hobbies.length';
    const included = await runSelection(whole, 0, whole.length, location);
    assert.equal(included.status, 'success', included.output);
    assert.match(included.output, /Result:\n9/);
    const missing = await run('import { missing } from "./util.js"; missing', location);
    assert.equal(missing.status, 'error');
    assert.match(missing.output, /does not export 'missing'/);
    const absent = await run('import absent from "./absent.js"; absent', location);
    assert.equal(absent.status, 'error');
    assert.match(absent.output, /absent.js/);
  } finally { fs.rmSync(folder, { recursive: true }); }
});

test('selected use resolves lexical dependencies, skips unused initializers, and fails closed', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'js-runner-declarations-'));
  try {
    const location = { ...options, cwd: folder, filename: path.join(folder, 'methods.js') };
    fs.writeFileSync(path.join(folder, 'util.js'), `
      import fs from 'node:fs';
      const hobbies = (() => { throw Error('unused initializer ran'); })();
      console.log('UNSELECTED');
      fs.writeFileSync(${JSON.stringify(path.join(folder, 'should-not-exist'))}, 'side effect');
      const numberz = [1, 2, 3, 4, 5, 6];
      const base = 10;
      function add(value) { return value + base; }
      function plus(value) { return add(value); }
      const unsafe = add(1);
      export { numberz, plus, unsafe }; export default hobbies;
    `);
    const selectedRun = async (expression) => {
      const doc = 'import hobbies, { numberz, plus, unsafe } from "./util.js";\n' + expression;
      return runSelection(doc, doc.indexOf('\n') + 1, doc.length, location);
    };
    assert.equal((await selectedRun('console.log(numberz.filter(n => n % 2 === 0))')).output, '[ 2, 4, 6 ]\n');
    assert.equal(fs.existsSync(path.join(folder, 'should-not-exist')), false);
    const fn = await selectedRun('plus(5)');
    assert.equal(fn.status, 'success', fn.output);
    assert.match(fn.output, /Result:\n15/);
    const unsupported = await selectedRun('unsafe');
    assert.equal(unsupported.status, 'error');
    assert.match(unsupported.output, /without running initialization: CallExpression/);
    const shadowed = await selectedRun('(() => { const numberz = [8]; return numberz; })()');
    assert.equal(shadowed.status, 'success', shadowed.output);
    assert.match(shadowed.output, /\[ 8 \]/);
    assert.equal(fs.existsSync(path.join(folder, 'should-not-exist')), false);
  } finally { fs.rmSync(folder, { recursive: true }); }
});

test('typeless module diagnostic is suppressed but other warnings and errors remain', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'js-runner-warning-'));
  try {
    fs.writeFileSync(path.join(folder, 'package.json'), '{}');
    fs.writeFileSync(path.join(folder, 'util.js'), 'export const numberz = [1,2,3,4,5,6];');
    const location = { cwd: folder, filename: path.join(folder, 'methods.js') };
    const result = await run('import { numberz } from "./util.js"; console.log(numberz.filter(n => n % 2 === 0)); process.emitWarning("keep this warning", { code: "USER_WARNING" }); console.error("keep stderr");', location);
    assert.equal(result.status, 'success', result.output);
    assert.match(result.output, /\[ 2, 4, 6 \]/);
    assert.doesNotMatch(result.output, /MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module/);
    assert.match(result.output, /USER_WARNING.*keep this warning/);
    assert.match(result.output, /keep stderr/);
    const failed = await run('import { numberz } from "./util.js"; throw Error("real failure")', location);
    assert.equal(failed.status, 'error');
    assert.match(failed.output, /real failure/);
  } finally { fs.rmSync(folder, { recursive: true }); }
});

test('intermediate mutations (like .push() and property updates) are preserved when referencing variables', async () => {
  const document = [
    'const hobbies = ["hiking", "working", "reading"];',
    'console.log(hobbies);',
    'hobbies.push("asdasd");',
    'const newHobbies = ["programming", "computing", "coding"];',
    'console.log(newHobbies);',
    'const newHobbiesList = [...hobbies, ...newHobbies, "and thats it."];',
    'console.log(newHobbiesList);',
  ].join('\n');
  const sel = 'console.log(newHobbiesList);';
  const start = document.indexOf(sel);
  const result = await runSelection(document, start, start + sel.length);
  assert.equal(result.status, 'success', result.output);
  assert.match(result.output, /asdasd/);
  assert.match(result.output, /hiking/);
  assert.match(result.output, /and thats it\./);
  assert.doesNotMatch(result.output, /\[ 'hiking', 'working', 'reading' \]\n/);
});
