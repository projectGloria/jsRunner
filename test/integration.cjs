const fs = require('node:fs');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

// Prefer an explicit or locally installed VS Code; otherwise let test-electron download
// stable into .vscode-test, so the suite runs on any machine and in CI.
const candidates = [
  process.env.VSCODE_EXECUTABLE,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'),
].filter(Boolean);
const vscodeExecutablePath = candidates.find(candidate => fs.existsSync(candidate));

runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: path.resolve(__dirname, '..'),
  extensionTestsPath: path.join(__dirname, 'suite.cjs'),
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', path.resolve(__dirname, '../.vscode-test/user-data')]
}).catch(error => { console.error(error); process.exitCode = 1; });
