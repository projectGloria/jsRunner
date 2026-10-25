import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

interface State { status: string; source: string; lines: string; output: string }

// Batch streamed chunks: one postMessage per frame-ish interval, not one per stdout write.
const FLUSH_MS = 50;

export class ResultsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  /** Whether the current webview document has loaded its script and can take messages. */
  private ready = false;
  private pending = '';
  private flushTimer?: NodeJS.Timeout;
  private state: State = {
    status: 'Ready', source: '', lines: '',
    output: 'Select JavaScript in the editor, then click ▶ in this panel’s toolbar.\nYou can also right-click → Run with JS Runner, or press Ctrl+Alt+J (Cmd+Alt+J on macOS).',
  };

  /** Full text, the source of truth for Copy Result regardless of what the webview shows. */
  get output() { return this.state.output; }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    const subscriptions = [
      // The webview announces readiness on every (re)load, including after being hidden,
      // because without retainContextWhenHidden its document is rebuilt when shown again.
      view.webview.onDidReceiveMessage(message => {
        if (message?.type !== 'ready' || this.view !== view) return;
        this.ready = true;
        this.sendState();
      }),
      view.onDidChangeVisibility(() => { if (!view.visible && this.view === view) this.ready = false; }),
      view.onDidDispose(() => {
        if (this.view === view) { this.view = undefined; this.ready = false; }
        subscriptions.forEach(s => s.dispose());
      }),
    ];
    view.webview.html = this.html();
  }

  update(status: string, output: string, source?: string, lines?: string) {
    this.state.status = status;
    this.state.output = output;
    if (source !== undefined) { this.state.source = source; this.state.lines = lines || ''; }
    // The full state supersedes any queued chunks; sending both would duplicate text.
    this.pending = '';
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    this.sendState();
  }

  append(text: string) {
    this.state.output += text;
    if (!this.ready) return; // The ready handshake will send the full state instead.
    this.pending += text;
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      const text = this.pending;
      this.pending = '';
      if (text && this.ready) void this.view?.webview.postMessage({ type: 'append', text });
    }, FLUSH_MS);
  }

  private sendState() {
    if (this.ready) void this.view?.webview.postMessage({ type: 'state', ...this.state });
  }

  private html() {
    const nonce = randomBytes(16).toString('hex');
    // Content arrives only through textContent/text nodes, so nothing is ever parsed as HTML.
    return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { padding: 12px 16px; color: var(--vscode-foreground); background: var(--vscode-panel-background); font-family: var(--vscode-font-family); }
header { display: flex; align-items: baseline; gap: 16px; margin-bottom: 12px; font-size: 12px; }
.status { text-transform: capitalize; font-weight: 600; }
.success { color: var(--vscode-testing-iconPassed, #73c991); }
.cancelled { color: var(--vscode-descriptionForeground); }
.source { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
.filename { color: var(--vscode-textLink-foreground, #3794ff); }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; user-select: text; }
.error, .timeout { color: var(--vscode-errorForeground); }
</style></head><body>
<header><span id="status" class="status"></span><span class="source"><span id="filename" class="filename"></span><span id="lines"></span></span></header>
<pre id="output" role="log"></pre>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const statusEl = document.getElementById('status'), filenameEl = document.getElementById('filename');
const linesEl = document.getElementById('lines'), outputEl = document.getElementById('output');
const styled = ['success', 'error', 'timeout', 'cancelled'];
const root = document.scrollingElement;
window.addEventListener('message', ({ data }) => {
  // Follow the output only if the user hasn't scrolled up to read something.
  const following = root.scrollHeight - root.scrollTop - root.clientHeight < 24;
  if (data.type === 'state') {
    statusEl.textContent = data.status;
    statusEl.className = 'status ' + (styled.includes(data.status) ? data.status : '');
    filenameEl.textContent = data.source;
    linesEl.textContent = data.lines ? ' · ' + data.lines : '';
    outputEl.textContent = data.output;
  } else if (data.type === 'append') {
    outputEl.append(data.text);
  }
  if (following) root.scrollTop = root.scrollHeight;
});
vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }
}
