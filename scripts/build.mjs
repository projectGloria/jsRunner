import { build } from 'esbuild';
await build({ entryPoints: ['src/extension.ts', 'src/runner.ts', 'src/execution.ts', 'src/transform.ts'], outdir: 'dist', bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'], sourcemap: true });
