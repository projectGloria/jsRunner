import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface RunOptions {
  code: string;
  /** Maps generated line 2 to the editor line; see Transformed. */
  lineOffset?: number;
  /** Full editor text, for loading module-level declarations the selection references. */
  document?: string;
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

/** Longest prefix of `data` within `limit` bytes that doesn't split a UTF-8 sequence. */
function utf8Prefix(data: Buffer, limit: number): string {
  if (data.length <= limit) return data.toString('utf8');
  let end = limit;
  // 0b10xxxxxx bytes continue a sequence; back up to the start of the cut character.
  while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString('utf8');
}

export function execute(options: RunOptions): { result: Promise<RunResult>; cancel: () => void } {
  let cancel = () => {};
  const result = new Promise<RunResult>((resolve) => {
    // Node can infer ES modules in projects without a package type. Suppress only
    // that informational diagnostic; preserve all other warnings and stderr.
    const child = spawn(options.nodePath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', options.runnerPath], {
      cwd: options.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '', bytes = 0, truncated = false, completed = false, gotResult = false, stopping = false, stoppedAfterResult = false;
    let status: RunResult['status'] = 'success';
    let killTimer: NodeJS.Timeout | undefined;
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
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timer); clearTimeout(killTimer);
      const text = output + notes.map(note => `\n${note}`).join('');
      resolve({ output: text.trim() ? text : 'Execution completed.', status });
    };
    const stop = (reason: 'cancelled' | 'timeout') => {
      if (completed || stopping) return;
      stopping = true;
      if (reason === 'timeout' && gotResult) {
        // The snippet finished (successfully or not); only leftover timers or handles hit
        // the deadline, so keep the snippet's own status.
        stoppedAfterResult = true;
        notes.push(`Result received. The process was stopped at the ${options.timeoutMs} ms deadline because timers or other handles were still active.`);
      } else {
        status = reason;
        notes.push(reason === 'timeout' ? 'Execution timed out. Increase JS Runner timeout in Settings if needed.' : 'Execution cancelled.');
      }
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    cancel = () => stop('cancelled');
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream?.on('data', (data: Buffer) => append(decoder.write(data)));
      stream?.on('end', () => append(decoder.end()));
    }
    child.on('message', (message: { type?: string; hasValue?: boolean; text?: string }) => {
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
    child.on('close', (code) => {
      if (!gotResult && /bad option: --disable-warning/.test(output)) {
        notes.push('JS Runner needs Node.js 20.19 or newer. Update Node.js or change JS Runner: Node Path in Settings.');
      }
      if (status === 'success' && !stoppedAfterResult && (!gotResult || code !== 0)) {
        status = 'error';
        notes.push(`Node.js exited before completing successfully (exit code ${code}).`);
      }
      finish();
    });
    // Only serializable fields cross the IPC boundary.
    const request = { code: options.code, lineOffset: options.lineOffset ?? -1, document: options.document, filename: options.filename, depth: options.depth };
    child.on('spawn', () => child.send(request, (error) => {
      if (error && !completed) { status = 'error'; notes.push(error.message); child.kill(); }
    }));
  });
  return { result, cancel: () => cancel() };
}
