import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { SelectionContext } from './selection';

export interface RunOptions {
  /** Full editor text: the selection comes from it, and so do the declarations it references. */
  document: string;
  /** Where the selection sits in `document`. */
  context: SelectionContext;
  filename: string;
  cwd: string;
  nodePath: string;
  runnerPath: string;
  timeoutMs: number;
  depth: number;
  /** Receives output as it arrives, in the same order it is appended to the result. */
  onOutput?: (text: string) => void;
}
export interface RunResult { output: string; status: 'success' | 'error' | 'cancelled' | 'timeout' }

const OUTPUT_LIMIT = 100 * 1024;
// SIGTERM is catchable on POSIX (`process.on('SIGTERM', …)`); SIGKILL isn't.
const KILL_GRACE_MS = 1000;
// Node's own startup doesn't count against the snippet's deadline, but can't hang forever either.
const STARTUP_MS = 10_000;
// A grandchild that inherited stdout keeps the pipe open after the runner exits; don't wait on it.
const CLOSE_GRACE_MS = 1000;
const POSIX = process.platform !== 'win32';
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Longest prefix of `data` within `limit` bytes that doesn't split a UTF-8 sequence. */
function utf8Prefix(data: Buffer, limit: number): string {
  if (data.length <= limit) return data.toString('utf8');
  let end = limit;
  // 0b10xxxxxx bytes continue a sequence; back up to the start of the cut character.
  while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}

/** The extension host's environment, minus what only makes sense inside VS Code. */
function snippetEnvironment(): NodeJS.ProcessEnv {
  // ELECTRON_RUN_AS_NODE would turn any Electron app the snippet launches (including `code`)
  // into plain Node.js; VSCODE_* are the extension host's private handles.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE' && !key.toUpperCase().startsWith('VSCODE_')));
}

export function execute(options: RunOptions): { result: Promise<RunResult>; cancel: () => void } {
  // setTimeout turns NaN, values below 1, and anything above 2^31-1 into 1 ms: an instant
  // timeout. Callers validate settings; this keeps any caller from hitting that.
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(MAX_TIMER_MS - STARTUP_MS, Math.max(1, Math.trunc(options.timeoutMs))) : 5000;
  let cancel = () => {};
  const result = new Promise<RunResult>((resolve) => {
    const token = randomUUID();
    // Node can infer ES modules in projects without a package type. Suppress only
    // that informational diagnostic; preserve all other warnings and stderr.
    const child = spawn(options.nodePath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', options.runnerPath], {
      cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: snippetEnvironment(),
      // POSIX: lead a process group, so stopping reaches processes the snippet started. On
      // Windows, libuv's job object already ends them with the runner (and detaching would opt out).
      detached: POSIX,
    });
    let output = '', bytes = 0, truncated = false, completed = false, gotResult = false, stopping = false, stoppedAfterResult = false;
    let status: RunResult['status'] = 'success';
    let killTimer: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
    // Status notes are separate from program output: they must stay visible even when
    // the program filled the output cap, and they're small fixed strings.
    const notes: string[] = [];
    const emit = (text: string) => { if (text) { output += text; options.onOutput?.(text); } };
    const append = (text: string) => {
      const data = Buffer.from(text);
      const available = Math.max(0, OUTPUT_LIMIT - bytes);
      if (available) {
        const kept = utf8Prefix(data, available);
        bytes += Buffer.byteLength(kept);
        emit(kept);
      }
      if (data.length > available && !truncated) { truncated = true; emit('\n[Output truncated at 100 KB]\n'); }
    };
    const kill = (signal: NodeJS.Signals) => {
      if (POSIX && child.pid) {
        try { process.kill(-child.pid, signal); return; } catch { /* group already gone */ }
      }
      child.kill(signal);
    };
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer);
      // Parity with Windows: nothing the snippet started outlives the run.
      if (POSIX && child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none left */ }
      const text = output + notes.map(note => `\n${note}`).join('');
      resolve({ output: text ? text : 'Execution completed.', status });
    };
    const stop = (reason: 'cancelled' | 'timeout') => {
      if (completed || stopping) return;
      stopping = true;
      if (gotResult) {
        // The snippet already finished (successfully or not); only leftover timers or handles
        // were stopped, so keep the snippet's own status.
        stoppedAfterResult = true;
        notes.push(reason === 'timeout'
          ? `Result received. The process was stopped at the ${timeoutMs} ms deadline because timers or other handles were still active.`
          : 'Result received. Stopped afterwards, while timers or other handles were still active.');
      } else {
        status = reason;
        notes.push(reason === 'timeout' ? 'Execution timed out. Increase JS Runner timeout in Settings if needed.' : 'Execution cancelled.');
      }
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
    };
    let timer = setTimeout(() => stop('timeout'), timeoutMs + STARTUP_MS);
    cancel = () => stop('cancelled');
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream?.on('data', (data: Buffer) => append(decoder.write(data)));
      stream?.on('end', () => append(decoder.end()));
    }
    child.on('message', (message: { type?: string; token?: string; hasValue?: boolean; text?: string }) => {
      if (message?.token !== token) return;
      if (message.type === 'started') {
        // The deadline covers the snippet, from the moment Node.js is up.
        clearTimeout(timer);
        if (!completed && !stopping) timer = setTimeout(() => stop('timeout'), timeoutMs);
        return;
      }
      if (message.type !== 'result' && message.type !== 'failure') return;
      gotResult = true;
      if (message.type === 'failure') status = 'error';
      // The result is capped by the runner and must survive a log-flooded output cap.
      if (message.type === 'failure' || message.hasValue) emit(`\n${message.type === 'failure' ? 'Error' : 'Result'}:\n${message.text}\n`);
    });
    child.on('error', (error) => {
      status = 'error';
      notes.push(`Unable to start Node.js: ${error.message}\nCheck JS Runner: Node Path in Settings.`);
      finish();
    });
    const closed = (code: number | null) => {
      if (completed) return;
      if (!gotResult && /bad option: --disable-warning/.test(output)) {
        notes.push('JS Runner needs Node.js 20.19 or newer. Update Node.js or change JS Runner: Node Path in Settings.');
      }
      if (status === 'success' && !stoppedAfterResult && !stopping) {
        if (!gotResult && code === 0) {
          // Only an explicit process.exit(0) ends the runner cleanly before the result.
          notes.push('The process exited (code 0) before the selection finished, so there is no result.');
        } else if (!gotResult || code !== 0) {
          status = 'error';
          notes.push(`Node.js exited before completing successfully (exit code ${code}).`);
        }
      }
      finish();
    };
    child.on('close', closed);
    child.on('exit', (code) => {
      closeTimer = setTimeout(() => {
        child.stdout?.destroy(); child.stderr?.destroy();
        closed(code);
      }, CLOSE_GRACE_MS);
    });
    // Only serializable fields cross the IPC boundary.
    const request = { token, document: options.document, context: options.context, filename: options.filename, depth: options.depth };
    child.on('spawn', () => child.send(request, (error) => {
      if (error && !completed) { status = 'error'; notes.push(error.message); kill('SIGKILL'); }
    }));
  });
  return { result, cancel: () => cancel() };
}
