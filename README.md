# VIBE

VIBE is a VS Code extension for exploring data inside the editor. The long-term goal is a Spotfire-class analytics tool: data connectors (Oracle included), a transformation layer and a visual layer, while staying fast and easy to use.

This first slice covers file loading, the data engine, a virtualized grid and one interactive chart.

## What works today

- **Load CSV, TSV, TXT and Excel (.xlsx)** files from the command palette (`VIBE: Load Data File…`), the explorer context menu, or the panel's *Load file…* button. You can pick several files at once.
- **TXT delimiter detection.** VIBE samples the file and chooses comma, tab, semicolon, pipe, colon or space by how consistently each splits the lines (quoted fields are respected). DuckDB then infers the column types.
- **Excel.** Every non-empty sheet becomes its own table. The first row is the header, duplicate headers get suffixes, and number, boolean, date and text types are inferred. Formula cells use their cached results.
- **In-memory DuckDB engine.** Files load into DuckDB tables. The panel never copies the whole dataset: the grid asks for 256-row blocks as you scroll and the chart asks for grouped aggregates. A 2M-row, 58 MB CSV loads in about 0.3 s, and jumping to the middle of it renders in about 40 ms.
- **Virtualized grid.** Only visible rows exist in the DOM. It has a sticky header and row numbers, and you click a header to sort ascending, descending or not at all (sorting runs in DuckDB).
- **Interactive chart (ECharts).** Pick X, Y, aggregation (sum, avg, min, max, count) and type (bar, line, pie). Click a category to mark it, and Ctrl/Cmd/Shift-click to add more. The grid filters to the marked rows, much like marking in Spotfire.

## Getting started

```bash
npm install
npm run build     # bundles dist/extension.js and dist/webview.js
npm test          # builds, compiles the tests and runs them with node --test
```

Press **F5** in VS Code to start an Extension Development Host, then run **VIBE: Open Data Panel** or **VIBE: Load Data File…**.

To work on the UI without VS Code, run the panel in a browser backed by the real engine:

```bash
npm run preview -- test/fixtures/sales.csv   # then open http://localhost:5199
```

## Packaging

`@duckdb/node-api` ships native binaries per platform, so build one VSIX per target:

```bash
npm run package -- --target win32-x64   # or linux-x64, darwin-arm64, …
```

Run it on (or install dependencies for) the matching platform so that the right `@duckdb/node-bindings-*` package is in `node_modules`.

## Layout

```
src/extension.ts        VS Code entry point: commands, webview panel, file picker
src/controller.ts       Answers webview messages (no vscode dependency, so tests and preview reuse it)
src/protocol.ts         Message types shared by the host and the webview
src/engine/engine.ts    DuckDB-backed DataEngine: load, page, sort, filter, aggregate
src/engine/delimiter.ts Delimiter detection for TXT files
src/engine/excel.ts     Excel reader (exceljs) with type inference
webview/                Panel UI: virtual grid, chart, wiring
media/panel.css         Panel styles, using VS Code theme variables
scripts/preview.mjs     Browser preview server
test/                   Unit and controller tests with fixtures
```

## Next steps

- Oracle connector (node-oracledb thin mode), with saved connections and a query editor
- Transformation layer: filter, calculated columns, joins and pivots expressed as DuckDB SQL steps
- More visuals and multi-visual pages with shared marking and filtering
