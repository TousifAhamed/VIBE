import type { Aggregation, FilterSpec, HostMessage, TableInfo, WebviewMessage } from '../src/protocol';
import { ChartKind, InteractiveChart } from './chart';
import { isNumericType, VirtualGrid } from './grid';

interface VsCodeApi {
  postMessage(msg: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const send = (msg: WebviewMessage) => vscode.postMessage(msg);

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="toolbar">
    <button id="load" class="primary">Load file…</button>
    <select id="table" aria-label="Table" hidden></select>
    <span id="status" class="status"></span>
    <span id="filter" class="chip" hidden><span id="filter-text"></span><button id="filter-clear" title="Clear marking">×</button></span>
  </header>
  <section id="empty" class="empty">
    <h2>No data loaded yet</h2>
    <p>Load a CSV, TXT or Excel file. It goes into an in-memory DuckDB engine, so even large files stay responsive.</p>
    <button id="load-empty" class="primary">Load file…</button>
  </section>
  <main id="workspace" class="workspace" hidden>
    <section class="pane grid-pane"><div id="grid" class="grid"></div></section>
    <section class="pane chart-pane">
      <div class="chart-controls">
        <label>X <select id="x"></select></label>
        <label>Y <select id="y"></select></label>
        <label>Agg <select id="agg">
          <option value="sum">Sum</option><option value="avg">Avg</option>
          <option value="min">Min</option><option value="max">Max</option><option value="count">Count</option>
        </select></label>
        <label>Chart <select id="kind">
          <option value="bar">Bar</option><option value="line">Line</option><option value="pie">Pie</option>
        </select></label>
      </div>
      <div id="chart" class="chart"></div>
    </section>
  </main>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tableSelect = $<HTMLSelectElement>('table');
const xSelect = $<HTMLSelectElement>('x');
const ySelect = $<HTMLSelectElement>('y');
const aggSelect = $<HTMLSelectElement>('agg');
const kindSelect = $<HTMLSelectElement>('kind');
const status = $<HTMLSpanElement>('status');

let tables: TableInfo[] = [];
let active: TableInfo | undefined;
let filter: FilterSpec | undefined;
let nextReq = 1;
const rowRequests = new Map<number, number>();
let chartReq = 0;

const grid = new VirtualGrid(
  $('grid'),
  {
    fetch(offset, limit, sort, f, generation) {
      if (!active) {
        return;
      }
      const reqId = nextReq++;
      rowRequests.set(reqId, generation);
      send({ type: 'getRows', reqId, table: active.name, offset, limit, sort, filter: f });
    },
  },
);

const chart = new InteractiveChart($('chart'), (labels) => {
  filter = labels.length > 0 ? { column: xSelect.value, values: labels } : undefined;
  grid.setFilter(filter);
  renderFilterChip();
});

function renderFilterChip(): void {
  const chip = $('filter');
  chip.hidden = !filter;
  if (filter) {
    const shown = filter.values.slice(0, 3).join(', ') + (filter.values.length > 3 ? ` +${filter.values.length - 3}` : '');
    $('filter-text').textContent = `${filter.column} = ${shown}`;
  }
}

function renderStatus(): void {
  if (!active) {
    status.textContent = '';
    return;
  }
  const n = grid.rowCount.toLocaleString();
  const of = filter ? ` of ${active.rowCount.toLocaleString()}` : '';
  status.textContent = `${n}${of} rows · ${active.columns.length} columns`;
}

function option(value: string, label = value): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function selectTable(name: string): void {
  active = tables.find((t) => t.name === name) ?? tables[0];
  if (!active) {
    return;
  }
  vscode.setState({ table: active.name });
  tableSelect.value = active.name;
  filter = undefined;
  renderFilterChip();
  grid.setTable(active.columns, active.rowCount);

  const numeric = active.columns.filter((c) => isNumericType(c.type));
  const categorical = active.columns.filter((c) => !isNumericType(c.type));
  xSelect.replaceChildren(...active.columns.map((c) => option(c.name)));
  ySelect.replaceChildren(option('', '(row count)'), ...numeric.map((c) => option(c.name)));
  xSelect.value = (categorical[0] ?? active.columns[0]).name;
  // Identifier columns are numeric but rarely what anyone wants to sum.
  const measure = numeric.find((c) => !/(^|_)id$|^id/i.test(c.name)) ?? numeric[0];
  ySelect.value = measure?.name ?? '';
  aggSelect.value = measure ? 'sum' : 'count';
  requestChart();
  renderStatus();
}

function requestChart(): void {
  if (!active) {
    return;
  }
  const y = ySelect.value || null;
  const agg = (y ? aggSelect.value : 'count') as Aggregation;
  aggSelect.disabled = !y;
  chartReq = nextReq++;
  const xType = active.columns.find((c) => c.name === xSelect.value)?.type ?? '';
  const ordered = kindSelect.value === 'line' || /DATE|TIME/i.test(xType) || isNumericType(xType);
  send({ type: 'aggregate', reqId: chartReq, table: active.name, x: xSelect.value, y, agg, orderBy: ordered ? 'label' : 'value' });
}

function measureLabel(): string {
  const y = ySelect.value;
  return y ? `${aggSelect.value}(${y})` : 'row count';
}

xSelect.addEventListener('change', () => {
  chart.clearMarking();
  if (filter) {
    filter = undefined;
    grid.setFilter(undefined);
    renderFilterChip();
  }
  requestChart();
});
for (const s of [ySelect, aggSelect, kindSelect]) {
  s.addEventListener('change', requestChart);
}
tableSelect.addEventListener('change', () => selectTable(tableSelect.value));
$('load').addEventListener('click', () => send({ type: 'pickFile' }));
$('load-empty').addEventListener('click', () => send({ type: 'pickFile' }));
$('filter-clear').addEventListener('click', () => {
  chart.clearMarking();
  filter = undefined;
  grid.setFilter(undefined);
  renderFilterChip();
  renderStatus();
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'tables': {
      tables = msg.tables;
      const hasData = tables.length > 0;
      $('empty').hidden = hasData;
      $('workspace').hidden = !hasData;
      tableSelect.hidden = !hasData;
      tableSelect.replaceChildren(...tables.map((t) => option(t.name, `${t.name} (${t.rowCount.toLocaleString()})`)));
      const saved = (vscode.getState() as { table?: string } | undefined)?.table;
      const target = msg.active ?? (active && tables.some((t) => t.name === active!.name) ? active.name : saved);
      if (hasData && (target !== active?.name || !active)) {
        selectTable(target ?? tables[0].name);
      }
      status.classList.remove('busy');
      renderStatus();
      break;
    }
    case 'loading':
      status.textContent = `Loading ${msg.file}…`;
      status.classList.add('busy');
      break;
    case 'rows': {
      const generation = rowRequests.get(msg.reqId);
      rowRequests.delete(msg.reqId);
      if (generation !== undefined && msg.table === active?.name) {
        grid.receive(generation, msg.offset, msg.total, msg.rows);
        renderStatus();
      }
      break;
    }
    case 'aggregate':
      if (msg.reqId === chartReq) {
        chart.setData(kindSelect.value as ChartKind, measureLabel(), msg.labels, msg.values);
      }
      break;
    case 'error':
      status.classList.remove('busy');
      status.textContent = msg.message;
      break;
  }
});

send({ type: 'ready' });
