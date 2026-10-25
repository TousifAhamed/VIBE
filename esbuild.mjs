import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const configs = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // Native DuckDB bindings and node-oracledb (which loads optional native Thick-mode
    // binaries dynamically) ship as node_modules in the VSIX; everything else is bundled.
    // pg-native is an optional pg add-on that VIBE does not use.
    external: ['vscode', '@duckdb/node-api', 'oracledb', 'pg-native'],
    sourcemap: !production,
    minify: production,
  },
  {
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: !production,
    minify: true,
  },
];

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
  console.log('watching…');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log('build complete');
}
