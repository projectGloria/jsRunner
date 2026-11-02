const vscode = require('vscode');
exports.run = async () => {
  const document = await vscode.workspace.openTextDocument({ language: 'javascript', content: 'const user = {\n  name: "Nihil",\n  age: 32,\n  greet() { return `Hello ${this.name}`; }\n};' });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(document.getText().length));
  await vscode.commands.executeCommand('jsRunner.runSelection');
  await new Promise(resolve => setTimeout(resolve, 240000));
};
