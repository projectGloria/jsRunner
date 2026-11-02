# Changelog

## Unreleased

### Safety: code you didn't select never runs

- Automatic context no longer executes top-level statements on imported bindings (for example `fs.rmSync(...)` or `cp.execSync(...)` elsewhere in the file).
- Calls such as `store.clear()` or `list.sort(compare)` are no longer treated as safe to replay; only updates that provably run no user code are replayed.
- Statements below the selection, and the selected statements themselves, are no longer replayed.
- Spreading, iterating, or building a `Map`/`Set` from a value that may define its own iterator, and compound assignments that may call `valueOf`/`toString`, now fail closed.

### Correct results

- The selection shares live bindings with the file's functions and imported modules (`inc(); count`), instead of copies.
- Assigning a `const` or an import throws `TypeError`, as in the module.
- Calls to imported functions keep `this` undefined.
- A skipped statement that could change a loaded value is listed in a note with its file and line, instead of being silently ignored or partially replayed.
- Constants derived from constants load (`const WEEK = DAY * 7`), and a top-level read such as `users.forEach(...)` no longer blocks loading `users`.
- Stack traces keep the throwing frame next to the selection and show editor columns on the final expression's line.
- Console output and stderr keep their relative order.
- Errors after the result (a stray rejection, a throwing timer) are reported without runner internals or generated code.
- A hand-written thenable result is shown instead of hanging until the deadline; promises are still awaited.
- `{ a: 1 }` alone shows the object, like the Node.js REPL.
- Syntax errors give editor line and column, with a hint for `return` outside a function and a clear message for `import.meta`.

### Reliability

- Out-of-range `timeoutMs` or `inspectionDepth` values are clamped; a huge timeout no longer makes every run time out instantly.
- The deadline starts once Node.js is running, so a slow start doesn't eat into it.
- Stopping a run or reaching the deadline also ends processes the snippet started, and a child process holding the output open can no longer leave the panel on "Running…".
- Cancelling after the result keeps the result's status; `process.exit(0)` is no longer reported as a failure.
- Snippet code can't impersonate the runner's messages.
- The document is analyzed in the runner process, so large files no longer stall the extension host.
- Running from the editor returns keyboard focus to it, so the shortcut works again immediately.
- With multiple cursors, the panel notes that only the primary selection ran.
- The snippet no longer inherits VS Code-internal environment variables such as `ELECTRON_RUN_AS_NODE`.
- `jsRunner.nodePath` can't be set by a workspace's own settings without your consent.

### Packaging

- The package no longer includes README-only images (about 600 KB smaller).
- Type checking targets the VS Code 1.90 API exactly, and `npm test` includes it.
- Continuous integration runs the tests on Linux, macOS, and Windows.

## 0.5.1

### Current release highlights

- Run selected JavaScript from the editor, context menu, or results panel toolbar.
- Load supported referenced declarations and local JavaScript dependencies automatically.
- Execute top-level `await` in a fresh Node.js process for each run.
- Stream console output and display expression results, nested objects, and detailed errors.
- Stop active runs, configure execution timeouts and inspection depth, and copy panel output.

### Presentation

- Use Js runner — Pardus as the Marketplace display name.
- Introduce Pardus as the extension's main icon, with transparent exterior corners and expanded artwork.
- Use a matching pardus silhouette for the results panel.
- Expand the Marketplace overview with quick-start instructions, examples, runtime details, and troubleshooting.
- Add a captioned, looping demo recorded in the author's VS Code editor showing selection execution, automatic context loading, and object inspection.

### Requirements

- VS Code 1.90.0 or newer.
- Node.js 20.19 or newer.
- A trusted, non-virtual workspace.
