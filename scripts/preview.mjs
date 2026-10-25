// Runs the data panel in a normal browser, backed by the real DuckDB engine.
// Useful for UI work without launching VS Code:
//   npm run preview -- test/fixtures/sales.csv
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outfile = path.join(root, 'out', 'preview-controller.js');
await esbuild.build({
  stdin: {
    contents: "export { PanelController } from './src/controller'; export { DataEngine } from './src/engine/engine';",
    resolveDir: root,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['@duckdb/node-api'],
  logLevel: 'error',
});
const require = createRequire(import.meta.url);
const { PanelController, DataEngine } = require(outfile);

const files = process.argv.slice(2).map((f) => path.resolve(f));
const engine = await DataEngine.create();
if (files.length > 0) {
  await new PanelController(engine, () => {}, async () => []).loadFiles(files);
}

const shim = `
window.acquireVsCodeApi = () => ({
  getState: () => JSON.parse(sessionStorage.getItem('vibe') || 'null'),
  setState: (s) => sessionStorage.setItem('vibe', JSON.stringify(s)),
  postMessage: async (msg) => {
    const res = await fetch('/msg', { method: 'POST', body: JSON.stringify(msg) });
    for (const m of await res.json()) window.dispatchEvent(new MessageEvent('message', { data: m }));
  },
});`;

const page = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="/panel.css"><title>VIBE preview</title>
<style>:root{--vscode-editor-background:#1e1e1e;--vscode-foreground:#cccccc}</style></head>
<body><div id="app"></div><script>${shim}</script><script src="/webview.js"></script></body></html>`;

const port = Number(process.env.PORT ?? 5199);
createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/msg') {
    let body = '';
    for await (const chunk of req) body += chunk;
    // One controller per request keeps concurrent replies apart.
    const out = [];
    await new PanelController(engine, (m) => out.push(m), async () => files).handle(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  } else if (req.url === '/webview.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(path.join(root, 'dist', 'webview.js')));
  } else if (req.url === '/panel.css') {
    res.writeHead(200, { 'content-type': 'text/css' }).end(readFileSync(path.join(root, 'media', 'panel.css')));
  } else {
    res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  }
}).listen(port, () => console.log(`VIBE preview on http://localhost:${port}`));
