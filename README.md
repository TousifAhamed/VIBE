# VIBE

VIBE is a VS Code extension for exploring data inside the editor. The long-term goal is a Spotfire-class analytics tool: data connectors (Oracle included), a transformation layer and a visual layer, while staying fast and easy to use.

So far it covers file loading, Oracle and PostgreSQL connections, the data engine, a virtualized grid and one interactive chart.

## What works today

- **Load CSV, TSV, TXT and Excel (.xlsx)** files from the command palette (`VIBE: Load Data File…`), the explorer context menu, or the panel's *Load file…* button. You can pick several files at once.
- **TXT delimiter detection.** VIBE samples the file and chooses comma, tab, semicolon, pipe, colon or space by how consistently each splits the lines (quoted fields are respected). DuckDB then infers the column types.
- **Excel.** Every non-empty sheet becomes its own table. The first row is the header, duplicate headers get suffixes, and number, boolean, date and text types are inferred. Formula cells use their cached results.
- **Oracle and PostgreSQL.** The **VIBE** activity bar icon opens a *Databases* view. Add a connection, browse schemas, tables and views, and load a table with the download button. *New SQL Query* opens a SQL editor; **Ctrl+Enter** (Cmd+Enter on macOS) runs the selection or the whole editor and loads the result as a new table. Details below.
- **In-memory DuckDB engine.** Files load into DuckDB tables. The panel never copies the whole dataset: the grid asks for 256-row blocks as you scroll and the chart asks for grouped aggregates. A 2M-row, 58 MB CSV loads in about 0.3 s, and jumping to the middle of it renders in about 40 ms.
- **Virtualized grid.** Only visible rows exist in the DOM. It has a sticky header and row numbers, and you click a header to sort ascending, descending or not at all (sorting runs in DuckDB).
- **Interactive chart (ECharts).** Pick X, Y, aggregation (sum, avg, min, max, count) and type (bar, line, pie). Click a category to mark it, and Ctrl/Cmd/Shift-click to add more. The grid filters to the marked rows, much like marking in Spotfire.

## Databases

| | Oracle | PostgreSQL |
|---|---|---|
| Driver | node-oracledb 7 in Thin mode (pure JavaScript, no Oracle Client install) | node-postgres (pg) with server-side cursors |
| Versions | Oracle Database 12.1 and later (tested on 23ai Free) | PostgreSQL 9.6 and later (tested on 16) |
| Connect with | host, port and service name, or an Easy Connect string, tnsnames.ora alias or full descriptor, plus an optional folder for tnsnames.ora or a TCPS wallet | host, port, database, and SSL off, required, or verified |
| Sign in with | user name and password | user name and password |

- Passwords are kept in VS Code's secret storage (the OS keychain), never in settings files. Each new connection is tested before it is saved.
- Rows stream into DuckDB in batches of 25,000. The next batch downloads while the current one is appended, and values are cast to proper types inside DuckDB (Oracle `NUMBER(p,s)` and PostgreSQL `numeric(p,s)` become exact `DECIMAL`, dates become `TIMESTAMP`, and so on). Loads show progress and can be cancelled.
- `vibe.database.maxRows` (default 5,000,000, `0` for no limit) caps one load. VIBE tells you when a result was cut short.
- A SQL editor remembers its connection. A first line of `-- VIBE connection: <name>` does the same for saved `.sql` files.
- Measured on a 4-core cloud VM with the database on the same machine, loading 1,000,000 rows × 7 columns takes about 5 s from PostgreSQL and about 12 s from Oracle. Most of the Oracle time is the Thin driver decoding rows.
- Not yet supported: Oracle wallets protected by a password, Kerberos and other external authentication (these need Thick mode), and BLOB columns, which load as empty.

## Getting started

```bash
npm install
npm run build     # bundles dist/extension.js and dist/webview.js
npm test          # builds, compiles the tests and runs them with node --test
```

`test/live-db.test.ts` runs against real databases when `VIBE_PG_HOST` or `VIBE_ORACLE_CONNECT` is set (see the top of that file), and CI runs it against PostgreSQL 16 and Oracle Database Free containers. With Docker you can do the same locally:

```bash
docker run -d -p 1521:1521 -e ORACLE_PASSWORD=admin -e APP_USER=vibe -e APP_USER_PASSWORD=vibe gvenzl/oracle-free:23-slim-faststart
VIBE_ORACLE_CONNECT=localhost:1521/FREEPDB1 VIBE_ORACLE_USER=vibe VIBE_ORACLE_PASSWORD=vibe npm test
```

Open the folder in VS Code and press **F5** ("Run VIBE Extension"). It builds first, then opens an Extension Development Host window where you run **VIBE: Open Data Panel** or **VIBE: Load Data File…**. After a code change, run `npm run build` (or keep `npm run watch` running) and reload that window with Ctrl+R.

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
src/databases.ts        Databases view, connection dialogs and SQL commands (VS Code side)
src/db/                 Connector layer: provider interface, Oracle and PostgreSQL providers, sessions and imports
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

- More connectors through the same provider interface: MySQL/MariaDB, SQL Server, SQLite
- Live (in-database) mode that pushes filters and aggregates down to the database instead of importing
- Transformation layer: filter, calculated columns, joins and pivots expressed as DuckDB SQL steps
- More visuals and multi-visual pages with shared marking and filtering
