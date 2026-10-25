import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { inspect } from 'node:util';
import { loadContext, LoaderError } from './declarations';

interface RunRequest { code: string; lineOffset: number; document?: string; filename: string; depth: number }

const OUTPUT_LIMIT = 100 * 1024;

// The default-loader constant is our plumbing for `import()`, not something the user
// wrote. Hide only its experimental notice; every other warning stays visible.
const emitWarning = process.emitWarning;
process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
  if (String(warning).includes('USE_MAIN_CONTEXT_DEFAULT_LOADER')) return;
  return (emitWarning as Function).call(process, warning, ...rest);
} as typeof process.emitWarning;

process.once('message', async (request: RunRequest) => {
  // `once` removes the IPC listener, which unrefs the channel. Without this handle,
  // `await new Promise(() => {})` would exit early instead of reaching the deadline.
  const keepAlive = setInterval(() => {}, 1000);
  const format = (value: unknown) => inspect(value, { depth: request.depth, colors: false, getters: false, customInspect: false, maxArrayLength: 100, maxStringLength: 10000, breakLength: 90 }).slice(0, OUTPUT_LIMIT);
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 20 || (major === 20 && minor < 19)) {
      throw new LoaderError(`JS Runner needs Node.js 20.19 or newer, but JS Runner: Node Path points to ${process.version}.`);
    }
    const require = createRequire(request.filename);
    const module = { exports: {}, filename: request.filename, id: '.', path: path.dirname(request.filename), require };
    // Strict, like the ES module syntax the selection was parsed as. `.call(undefined, …)`
    // gives top-level `this === undefined`, and passes the loader as `arguments[0]`.
    const wrapper = 'return (async function () {"use strict";' + request.code + '\n}).call(undefined, __jsRunnerLoad);';
    const run = vm.compileFunction(wrapper, ['require', 'module', 'exports', '__filename', '__dirname', '__jsRunnerLoad'], {
      filename: request.filename,
      lineOffset: request.lineOffset,
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    const load = (names: string[]) => loadContext(request.document ?? '', request.filename, names);
    const value = await run(require, module, module.exports, request.filename, path.dirname(request.filename), load);
    process.send?.({ type: 'result', hasValue: value !== undefined, text: value === undefined ? '' : format(value) });
  } catch (error) {
    process.send?.({ type: 'failure', text: describeError(error, format, request).slice(0, OUTPUT_LIMIT) });
  }
  // Let timers and other pending async work finish; the parent enforces a deadline.
  clearInterval(keepAlive);
  process.disconnect?.();
});

function describeError(error: unknown, format: (value: unknown) => string, request: RunRequest): string {
  if (error instanceof LoaderError) return error.message;
  // inspect() renders the stack plus `[cause]`, AggregateError `[errors]`, and extra
  // properties like `code`, all of which `error.stack` alone drops.
  const text = format(error);
  // The header line and the closing `}).call(…)` line are generated; no user code lives there.
  const codeLines = request.code.split('\n').length;
  const wrapperFrames = [request.lineOffset + 1, request.lineOffset + 1 + codeLines].map(line => `${request.filename}:${line}:`);
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    // Runner frames, Node built-in frames (`node:events`, `node:internal/…`), and wrapper frames.
    const internal = /^\s+at /.test(line) && (line.includes(__filename) || /[( ]node:/.test(line) || wrapperFrames.some(frame => line.includes(frame)));
    if (!internal) kept.push(line);
    // inspect() opens the `[cause]`/property block at the end of the last frame; keep it balanced.
    else if (line.endsWith(' {') && kept.length) kept[kept.length - 1] += ' {';
  }
  return kept.join('\n');
}
