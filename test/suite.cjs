const assert = require('node:assert/strict');
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Focus changes settle asynchronously after the command returns. */
async function waitFor(condition, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

exports.run = async () => {
  const extension = vscode.extensions.getExtension('Nihilnia.instant-selection-js-runner');
  assert.ok(extension);
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['runSelection', 'stop', 'showLastResult', 'copyResult']) assert.ok(commands.includes('jsRunner.' + name));
  assert.equal(extension.packageJSON.contributes.keybindings[0].key, 'ctrl+alt+j');
  assert.equal(extension.packageJSON.contributes.menus['editor/context'][0].command, 'jsRunner.runSelection');
  const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'const user = {name: "Nihil", age: 32};' });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(document.getText().length));
  await vscode.commands.executeCommand('jsRunner.runSelection');
  await vscode.commands.executeCommand('jsRunner.copyResult');
  assert.match(await vscode.env.clipboard.readText(), /name: 'Nihil'/);
  assert.equal(extension.packageJSON.contributes.viewsContainers.panel[0].title, 'JS Runner');
  assert.equal(extension.packageJSON.contributes.commands[0].title, 'Run with JS Runner');
  await vscode.commands.executeCommand('jsRunner.showLastResult');
  await vscode.commands.executeCommand('jsRunner.runSelection');
  await vscode.commands.executeCommand('jsRunner.copyResult');
  assert.match(await vscode.env.clipboard.readText(), /name: 'Nihil'/);
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('jsRunner.runSelection');
  await vscode.commands.executeCommand('jsRunner.copyResult');
  assert.match(await vscode.env.clipboard.readText(), /Select JavaScript/);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'js-runner-editor-'));
  try {
    fs.writeFileSync(path.join(folder, 'util.js'), 'console.log("UNSELECTED"); export const numberz = [1,2,3,4,5,6]; export default [];');
    const filename = path.join(folder, 'methods.js');
    fs.writeFileSync(filename, '// imports will be added as unsaved editor changes\n');
    const source = await vscode.workspace.openTextDocument(filename);
    const sourceEditor = await vscode.window.showTextDocument(source);
    await sourceEditor.edit(edit => edit.insert(new vscode.Position(1, 0), 'import hobbies, { numberz } from "./util.js";\nthrow Error("unselected");\nconst evens = numberz.filter(n => n % 2 === 0);\nconsole.log(evens);'));
    sourceEditor.selection = new vscode.Selection(3, 0, 4, source.lineAt(4).text.length);
    await vscode.commands.executeCommand('jsRunner.runSelection');
    await vscode.commands.executeCommand('jsRunner.copyResult');
    assert.equal(await vscode.env.clipboard.readText(), '[ 2, 4, 6 ]\n');
    // Same-file declarations come from the unsaved buffer, not the file on disk.
    const end = source.lineAt(source.lineCount - 1).range.end;
    await sourceEditor.edit(edit => edit.insert(end, '\nconst factor = 3;\nfactor * 2'));
    const last = source.lineCount - 1;
    sourceEditor.selection = new vscode.Selection(last, 0, last, source.lineAt(last).text.length);
    await vscode.commands.executeCommand('jsRunner.runSelection');
    await vscode.commands.executeCommand('jsRunner.copyResult');
    assert.match(await vscode.env.clipboard.readText(), /^Result:\n6\n$/m);
    // A run from the editor hands keyboard focus back, so the keybinding works again at once.
    await waitFor(() => vscode.window.activeTextEditor?.document === source, 'focus returns to the source editor');
    // Live bindings: a same-file function updates the binding the selection reads.
    await sourceEditor.edit(edit => edit.insert(source.lineAt(source.lineCount - 1).range.end, '\nlet count = 0;\nfunction inc() { count++; }\ninc(); count'));
    const counter = source.lineCount - 1;
    sourceEditor.selection = new vscode.Selection(counter, 0, counter, source.lineAt(counter).text.length);
    await vscode.commands.executeCommand('jsRunner.runSelection');
    await vscode.commands.executeCommand('jsRunner.copyResult');
    assert.equal(await vscode.env.clipboard.readText(), '\nResult:\n1\n');
    // Multi-cursor: only the primary selection runs, and the panel says so.
    sourceEditor.selections = [new vscode.Selection(counter, 0, counter, source.lineAt(counter).text.length), new vscode.Selection(0, 0, 0, 2)];
    await vscode.commands.executeCommand('jsRunner.runSelection');
    await vscode.commands.executeCommand('jsRunner.copyResult');
    assert.match(await vscode.env.clipboard.readText(), /^Note: only the primary selection ran \(2 selections\)\.\n\n\nResult:\n1\n$/);
  } finally { fs.rmSync(folder, { recursive: true }); }
  console.log('Extension host integration: dedicated panel, selected code, Play command with panel focused, copy, empty selection, same-file declarations, focus return, live bindings, and multi-cursor passed.');
};
