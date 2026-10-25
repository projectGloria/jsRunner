# JS Runner

Select JavaScript and run it in a dedicated **JS Runner** bottom tab beside Terminal, Output, and Ports. Use **Ctrl+Alt+J** (**Cmd+Alt+J** on macOS), right-click **Run with JS Runner**, or click **▶ Play** in the JS Runner toolbar.

## Install

In VS Code, open Extensions, choose **… → Install from VSIX**, and select `instant-selection-js-runner-0.5.1.vsix`. This updates earlier versions. Reload VS Code if prompted. Node.js 20.19 or newer must be installed and available on PATH. If needed, set **JS Runner: Node Path** to your Node executable.

## Use

Select a complete JavaScript snippet and press the shortcut, right-click **Run with JS Runner**, or click the panel's **▶ Play** button. The same command is available in the Command Palette. The primary selection runs, including unsaved edits. Imports and top-level declarations from the rest of the file that the selection references are loaded automatically, along with only the declarations they depend on. Unrelated top-level statements and unused declarations do not run. Play uses the selection from the most recently active editor even while the panel has focus.

```js
const user = {
  name: 'Nihil',
  age: 32,
  greet() { return `Hello ${this.name}`; }
};
```

Selecting that declaration displays the `user` object. To execute the method, include the declaration and `user.greet()` in the selection. Methods are never invoked automatically.

```js
const values = await Promise.resolve([1, 2, 3]);
console.log('Loaded', values.length);
values.map(value => value * 2)
```

The JS Runner tab opens automatically and streams console output as it arrives, followed by the final expression's value. A final variable declaration displays its named bindings, and a final function or class declaration displays the function or class. An undefined return value (such as from `console.log`) is omitted; if nothing is printed or returned, the panel shows “Execution completed.” Explicit console messages are always preserved. Results can include objects, circular references, promises, and functions. The header shows green Success text, a distinctly colored filename, and the full selected line range.

Results remain in the panel until another run. Select and copy individual text or use the toolbar's **Copy Result** button. Use **JS Runner: Show Panel** to reopen the tab, and the **Stop** toolbar button to cancel a running snippet. Starting another run cancels the previous one. An empty selection displays guidance inside the panel; no result popup is used.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `jsRunner.nodePath` | `node` | Node executable name or absolute path |
| `jsRunner.timeoutMs` | `5000` | Execution deadline, 100–300000 milliseconds |
| `jsRunner.inspectionDepth` | `5` | Nested object depth, 0–20 |

Change the shortcut in **Preferences: Open Keyboard Shortcuts**, searching for **Run with JS Runner**. Output is capped at 100 KB per run; long strings and arrays are abbreviated during inspection.

## Execution model and limits

- Every run starts a fresh Node.js process. Variables do not carry between runs.
- Selections run as strict-mode code, matching the ES module syntax they are parsed as: assigning an undeclared variable throws, and top-level `this` is `undefined`. Loaded declarations keep their module's strict semantics too.
- JS Runner suppresses Node's `MODULE_TYPELESS_PACKAGE_JSON` warning about automatic ES module detection, plus the experimental notice for its own dynamic `import()` support. Other warnings, console messages, and errors remain visible. Your project's package settings are not changed.
- Automatic context loads only bindings the selection references. With `import hobbies, { numberz } from "./util.js"`, selecting `console.log(numberz.filter(n => n % 2 === 0))` loads the `numberz` declaration, leaving `hobbies` and unrelated statements such as `console.log(hobbies[2])` untouched. Unused imports and side-effect-only imports are skipped.
- Top-level declarations in the current file work the same way, read from the unsaved editor buffer: selecting `scale(2)` loads `function scale` and the `const base = 10` it uses. A selection inside a function sees that function's own parameters, not same-named top-level bindings.
- Each file is evaluated at most once per run, so every importer shares the same objects (`box.list === list` holds across import statements and diamond imports).
- The declaration loader supports local `.js`/`.mjs` files (including extensionless specifiers and `index.js` folders), Node.js built-ins (`node:fs`, also via `require("node:fs")`), function declarations, lexical dependencies, named and `export *` re-exports, and default exports. Initializers are loaded only when they provably cannot run user code: literals, arrays and objects (including spreads), arithmetic on primitives and built-in values (`24 * 60 * 60`, `Math.PI * 2`), `Object.freeze`, `Symbol`/`Symbol.for`, and `new Map`/`new Set`. Top-level mutation statements are skipped, so values reflect their declarations rather than later mutations.
- Other function calls, getters, classes, destructuring declarations, namespace imports of local files, package imports, and circular imports are unsupported for automatic loading. JS Runner reports an explanatory error instead of falling back to full module execution. This is a selection evaluator, not a complete replacement for Node's module system.
- If you explicitly include an import statement in the selection (or call `require()` / dynamic `import()`), it uses normal Node module execution, including the module's top-level statements. This is the opt-in route for complex modules. Normal Node module type rules apply to that route.
- Imported files are read from disk, so save changes to `util.js` before running. The current file's unsaved edits are used immediately.
- If the rest of the file isn't valid JavaScript (an unfinished edit, a TypeScript file, JavaScript inside Markdown or HTML), the selection still runs on its own. A note explains that imports and declarations outside it weren't loaded.
- `require()` and dynamic `import()` resolve relative to the selected file. Saved files use their containing directory; untitled documents use the workspace folder or home directory.
- Top-level `await` is supported. The final promise is awaited. Pending timers may keep producing output until the process exits or reaches the timeout. If a result was already produced, the run keeps its status and a note explains that the process was stopped at the deadline.
- Stack traces point at real editor lines and at the original lines of loaded files. Columns are exact except on the final expression's line, which shifts by the inserted `return (`.
- Errors show their `cause`, `AggregateError` members, and extra properties. JS Runner's internal stack frames are hidden.
- Export statements in the selected code, TypeScript, JSX, and browser globals such as `window` and `document` are unsupported. Imported modules may use exports normally. Leave `export default user` outside the selection.
- The editor context menu item and shortcut are available in JavaScript, TypeScript, Markdown, HTML, Vue, and Svelte files. The Command Palette works in any file.
- A trusted workspace is required. This is ordinary Node.js execution, with access to files, network, and installed packages; it is not a security sandbox. Stopping terminates the runner (escalating to a forced kill if it ignores the stop signal), not independently spawned processes.
- Desktop VS Code is supported; browser-only and virtual workspaces are unsupported.

## Develop

Run `npm install`, then `npm run check` and `npm test`. Press F5 to open the Extension Development Host. `npm run test:integration` uses `VSCODE_EXECUTABLE` or the standard Windows installation when present, and otherwise downloads VS Code stable. Run `npm run package` to create the installable VSIX.
