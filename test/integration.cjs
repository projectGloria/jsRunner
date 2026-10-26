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

let extensionDevelopmentPath = path.resolve(__dirname, '..');
let extensionTestsPath = path.join(__dirname, 'suite.cjs');
let userDataDir = path.resolve(__dirname, '../.vscode-test/user-data');

if (process.platform === 'win32') {
  const cp = require('node:child_process');
  const getShortPath = (p) => {
    try {
      return cp.execSync(`cmd.exe /c "for %I in ("${p}") do @echo %~fsI"`, { encoding: 'utf8' }).trim() || p;
    } catch {
      return p;
    }
  };
  extensionDevelopmentPath = getShortPath(extensionDevelopmentPath);
  extensionTestsPath = getShortPath(extensionTestsPath);
  userDataDir = getShortPath(userDataDir);
}

runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--user-data-dir', userDataDir]
}).catch(error => { console.error(error); process.exitCode = 1; });
