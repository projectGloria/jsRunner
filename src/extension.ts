import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { execute } from './execution';
import { transformSelection } from './transform';
import { ResultsView } from './resultsView';

export function activate(context: vscode.ExtensionContext) {
  const panel = new ResultsView();
  let active: ReturnType<typeof execute> | undefined;
  let lastEditor = vscode.window.activeTextEditor;
  let generation = 0;
  const show = () => vscode.commands.executeCommand('jsRunner.results.focus');
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('jsRunner.results', panel),
    vscode.window.onDidChangeActiveTextEditor(editor => {
      // Focusing the webview can clear activeTextEditor. Remember the source editor.
      if (editor && editor.document.uri.scheme !== 'output') lastEditor = editor;
    }),
    { dispose: () => { generation++; active?.cancel(); } },
    vscode.commands.registerCommand('jsRunner.showLastResult', show),
    vscode.commands.registerCommand('jsRunner.copyResult', () => vscode.env.clipboard.writeText(panel.output)),
    vscode.commands.registerCommand('jsRunner.stop', () => active?.cancel()),
    vscode.commands.registerCommand('jsRunner.runSelection', async () => {
      if (!vscode.workspace.isTrusted) {
        panel.update('Unavailable', 'Trust this workspace before running JavaScript.');
        await show(); return;
      }
      const currentEditor = vscode.window.activeTextEditor;
      const editor = currentEditor?.document.uri.scheme === 'output' ? lastEditor : currentEditor || lastEditor;
      // Read the live selection, not a cached snippet; never run a closed document.
      const code = editor && !editor.document.isClosed ? editor.document.getText(editor.selection) : '';
      if (!editor || editor.selection.isEmpty || !code.trim()) {
        panel.update('No selection', 'Select JavaScript in the editor, then press Play or Ctrl+Alt+J (Cmd+Alt+J on macOS).', '');
        await show(); return;
      }
      const id = ++generation;
      active?.cancel(); active = undefined;
      const document = editor.document;
      const isFile = document.uri.scheme === 'file';
      const cwd = isFile
        ? path.dirname(document.uri.fsPath)
        : vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
      const filename = isFile ? document.uri.fsPath : path.join(cwd, '__js_runner_untitled__.cjs');
      const config = vscode.workspace.getConfiguration('jsRunner', document.uri);
      const startLine = editor.selection.start.line + 1;
      // A selection ending at column zero excludes that final line.
      const endLine = editor.selection.end.line + (editor.selection.end.character === 0 ? 0 : 1);
      const lines = endLine > startLine ? `lines ${startLine}–${endLine}` : `line ${startLine}`;
      const source = path.basename(document.fileName);
      panel.update('Running…', '', source, lines);
      void vscode.commands.executeCommand('setContext', 'jsRunner.running', true);
      try {
        // Snapshot the buffer once so the selection offsets and the loaded context agree.
        const text = document.getText();
        const transformed = transformSelection(text, document.offsetAt(editor.selection.start), document.offsetAt(editor.selection.end), source);
        const prefix = transformed.notice ? `${transformed.notice}\n\n` : '';
        if (prefix) panel.append(prefix);
        const run = execute({
          ...transformed,
          document: text,
          filename, cwd,
          nodePath: config.get('nodePath', 'node'),
          runnerPath: context.asAbsolutePath('dist/runner.js'),
          timeoutMs: config.get('timeoutMs', 5000),
          depth: config.get('inspectionDepth', 5),
          // Stream into the panel; a superseded run must not write into its successor's output.
          onOutput: chunk => { if (id === generation) panel.append(chunk); },
        });
        active = run;
        // Capture the selection before moving focus to the panel.
        void show();
        const result = await run.result;
        if (id !== generation) return;
        panel.update(result.status, prefix + result.output);
      } catch (error) {
        if (id !== generation) return;
        panel.update('error', (error as Error).message);
        void show();
      } finally {
        if (id === generation) {
          active = undefined;
          void vscode.commands.executeCommand('setContext', 'jsRunner.running', false);
        }
      }
    }));
}
