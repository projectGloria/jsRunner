import { inspect, types } from 'node:util';
import { LoaderError } from './declarations';
import { prepare } from './context';
import { mapPosition, sourceMaps } from './builder';
import type { SelectionContext } from './selection';

interface RunRequest {
  /** Echoed in every message, so code in the snippet can't impersonate the runner. */
  token: string;
  document: string;
  context: SelectionContext;
  filename: string;
  depth: number;
}

const OUTPUT_LIMIT = 100 * 1024;

// The default-loader constant is our plumbing for `import()`, not something the user
// wrote. Hide only its experimental notice; every other warning stays visible.
const emitWarning = process.emitWarning;
process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
  if (String(warning).includes('USE_MAIN_CONTEXT_DEFAULT_LOADER')) return;
  return (emitWarning as Function).call(process, warning, ...rest);
} as typeof process.emitWarning;

// stdout and stderr are separate pipes, so the parent can't recover their relative order.
// Funnel stderr into stdout at the source; the panel shows one stream anyway.
process.stderr.write = process.stdout.write.bind(process.stdout) as typeof process.stderr.write;

// Bound now, before the snippet can replace process.send.
const send = process.send!.bind(process);

process.once('message', async (request: RunRequest) => {
  send({ type: 'started', token: request.token });
  // `once` removes the IPC listener, which unrefs the channel. Without this handle,
  // `await new Promise(() => {})` would exit early instead of reaching the deadline.
  const keepAlive = setInterval(() => {}, 1000);
  const format = (value: unknown) => inspect(value, { depth: request.depth, colors: false, getters: false, customInspect: false, maxArrayLength: 100, maxStringLength: 10000, breakLength: 90 }).slice(0, OUTPUT_LIMIT);
  // Errors after the result (a stray rejection, a throwing timer) would otherwise get Node's
  // raw report: runner frames and generated source. Same outcome (exit 1), clean text.
  let crashed = false;
  const crash = (error: unknown) => {
    if (crashed) return;
    crashed = true;
    process.stdout.write(`\nUncaught ${describeError(error, format).slice(0, OUTPUT_LIMIT)}\n`, () => process.exit(1));
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 20 || (major === 20 && minor < 19)) {
      throw new LoaderError(`JS Runner needs Node.js 20.19 or newer, but JS Runner: Node Path points to ${process.version}.`);
    }
    const { snippet, notes } = await prepare(request.document, request.filename, request.context);
    // Ahead of the snippet's own output, on the same stream, so ordering is guaranteed.
    for (const note of notes) process.stdout.write(`${note}\n\n`);
    // `.call(undefined)`: top-level `this` is undefined, as in a module.
    const returned = await snippet.call(undefined);
    let value = returned?.[0];
    // Await native promises (`fetch(url)` shows the response); a hand-written thenable is
    // shown as the object it is instead of hanging until the deadline.
    if (types.isPromise(value)) value = await value;
    send({ type: 'result', token: request.token, hasValue: value !== undefined, text: value === undefined ? '' : format(value) });
  } catch (error) {
    send({ type: 'failure', token: request.token, text: describeError(error, format).slice(0, OUTPUT_LIMIT) });
  }
  // Let timers and other pending async work finish; the parent enforces a deadline.
  clearInterval(keepAlive);
  process.disconnect?.();
});

function describeError(error: unknown, format: (value: unknown) => string): string {
  if (error instanceof LoaderError) return error.message;
  // inspect() renders the stack plus `[cause]`, AggregateError `[errors]`, and extra
  // properties like `code`, all of which `error.stack` alone drops.
  const kept: string[] = [];
  for (const line of format(error).split('\n')) {
    const frame = /^\s+at /.test(line);
    // Runner frames and Node built-in frames (`node:events`, `node:internal/…`).
    const internal = frame && (line.includes(__filename) || /[( ]node:/.test(line));
    const mapped = frame && !internal ? mapFrame(line) : line;
    // mapFrame returns null for generated code.
    if (mapped !== null && !internal) kept.push(mapped);
    // inspect() opens the `[cause]`/property block at the end of the last frame; keep it balanced.
    else if (line.endsWith(' {') && kept.length) kept[kept.length - 1] += ' {';
  }
  return kept.join('\n');
}

/** A stack frame with compiled positions mapped to editor positions, or null for generated code. */
function mapFrame(line: string): string | null {
  for (const filename of sourceMaps.keys()) {
    const at = line.lastIndexOf(`${filename}:`);
    if (at === -1) continue;
    const head = at + filename.length + 1;
    const match = /^(\d+):(\d+)/.exec(line.slice(head));
    if (!match) continue;
    const position = mapPosition(filename, Number(match[1]), Number(match[2]));
    if (!position) return null;
    return `${line.slice(0, head)}${position.line}:${position.column}${line.slice(head + match[0].length)}`;
  }
  return line;
}
