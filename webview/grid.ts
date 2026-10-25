import type { Cell, ColumnInfo, FilterSpec, SortSpec } from '../src/protocol';

const ROW_H = 24;
const BLOCK = 256;
const MAX_CACHED_BLOCKS = 64;
// Browsers stop growing scroll areas around 16–33M px; past this we scale.
const MAX_SCROLL_PX = 8_000_000;

export interface RowSource {
  /** Requests rows; the grid is told about them through `receive`. */
  fetch(offset: number, limit: number, sort: SortSpec | undefined, filter: FilterSpec | undefined, generation: number): void;
}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|REAL|DECIMAL)/i;

export function isNumericType(type: string): boolean {
  return NUMERIC.test(type);
}

function formatCell(v: Cell): string {
  if (v === null) {
    return '';
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return String(v);
}

/**
 * Virtualized grid: only the visible rows exist in the DOM, and rows are
 * fetched from the host in blocks as the user scrolls.
 */
export class VirtualGrid {
  private columns: ColumnInfo[] = [];
  private widths: number[] = [];
  private rownumWidth = 56;
  private total = 0;
  private sort: SortSpec | undefined;
  private filter: FilterSpec | undefined;
  private generation = 0;
  private readonly blocks = new Map<number, Cell[][]>();
  private readonly pending = new Set<number>();
  private rowEls: HTMLDivElement[] = [];
  private frame = 0;

  private readonly viewport: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly body: HTMLDivElement;

  constructor(
    host: HTMLElement,
    private readonly source: RowSource,
  ) {
    this.viewport = el('div', 'grid-viewport');
    this.viewport.tabIndex = 0;
    this.header = el('div', 'grid-header');
    this.spacer = el('div', 'grid-spacer');
    this.body = el('div', 'grid-body');
    this.viewport.append(this.header, this.spacer);
    this.spacer.append(this.body);
    host.append(this.viewport);
    this.viewport.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.viewport);
  }

  get rowCount(): number {
    return this.total;
  }

  setTable(columns: ColumnInfo[], total: number): void {
    this.columns = columns;
    // Room for the name and type in the header, capped so wide text columns don't dominate.
    this.widths = columns.map((c) => Math.min(300, Math.max(isNumericType(c.type) ? 110 : 130, c.name.length * 8 + c.type.length * 6 + 44)));
    this.rownumWidth = Math.max(48, String(total).length * 8 + 20);
    this.sort = undefined;
    this.filter = undefined;
    this.total = total;
    this.renderHeader();
    this.reset();
  }

  setFilter(filter: FilterSpec | undefined): void {
    this.filter = filter;
    this.reset();
  }

  /** Called with a block of rows from the host. Stale generations are ignored. */
  receive(generation: number, offset: number, total: number, rows: Cell[][]): void {
    if (generation !== this.generation) {
      return;
    }
    const block = Math.floor(offset / BLOCK);
    this.pending.delete(block);
    this.blocks.set(block, rows);
    if (this.blocks.size > MAX_CACHED_BLOCKS) {
      const oldest = this.blocks.keys().next().value as number;
      this.blocks.delete(oldest);
    }
    if (total !== this.total) {
      this.total = total;
      this.layout();
    }
    this.schedule();
  }

  private reset(): void {
    this.generation++;
    this.blocks.clear();
    this.pending.clear();
    this.viewport.scrollTop = 0;
    this.layout();
    this.schedule();
  }

  private totalWidth(): number {
    return this.rownumWidth + this.widths.reduce((a, b) => a + b, 0);
  }

  private layout(): void {
    const width = this.totalWidth();
    this.spacer.style.height = `${Math.min(this.total * ROW_H, MAX_SCROLL_PX)}px`;
    this.spacer.style.width = `${width}px`;
    this.header.style.width = `${width}px`;
    this.body.style.width = `${width}px`;
  }

  private renderHeader(): void {
    this.header.replaceChildren();
    const corner = el('div', 'grid-cell grid-rownum');
    corner.style.width = `${this.rownumWidth}px`;
    corner.textContent = '#';
    this.header.append(corner);
    this.columns.forEach((col, i) => {
      const cell = el('div', 'grid-cell grid-head');
      cell.style.width = `${this.widths[i]}px`;
      cell.title = `${col.name} (${col.type})`;
      const name = el('span', 'grid-head-name');
      name.textContent = col.name;
      const type = el('span', 'grid-head-type');
      type.textContent = col.type.toLowerCase();
      const arrow = el('span', 'grid-sort');
      if (this.sort?.column === col.name) {
        arrow.textContent = this.sort.desc ? '▼' : '▲';
        cell.classList.add('sorted');
      }
      cell.append(name, type, arrow);
      if (isNumericType(col.type)) {
        cell.classList.add('num');
      }
      cell.addEventListener('click', () => this.toggleSort(col.name));
      this.header.append(cell);
    });
    this.rowEls = [];
    this.body.replaceChildren();
  }

  private toggleSort(column: string): void {
    if (this.sort?.column !== column) {
      this.sort = { column, desc: false };
    } else if (!this.sort.desc) {
      this.sort = { column, desc: true };
    } else {
      this.sort = undefined;
    }
    this.renderHeader();
    this.reset();
  }

  private schedule(): void {
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
    }
  }

  private render(): void {
    const viewH = this.viewport.clientHeight - ROW_H;
    const fullH = this.total * ROW_H;
    const spacerH = Math.min(fullH, MAX_SCROLL_PX);
    const maxScroll = Math.max(1, spacerH - viewH);
    const scrollTop = Math.min(this.viewport.scrollTop, maxScroll);
    // Map the (possibly scaled) scroll position to a pixel offset in the full list.
    const virtualTop = fullH > MAX_SCROLL_PX ? (scrollTop / maxScroll) * Math.max(0, fullH - viewH) : scrollTop;
    const first = Math.floor(virtualTop / ROW_H);
    const visible = Math.min(Math.ceil(viewH / ROW_H) + 2, Math.max(0, this.total - first));

    this.body.style.transform = `translateY(${scrollTop - (virtualTop % ROW_H)}px)`;
    this.ensureRowEls(visible);

    for (let i = 0; i < visible; i++) {
      const rowIndex = first + i;
      const rowEl = this.rowEls[i];
      rowEl.style.display = '';
      rowEl.classList.toggle('odd', rowIndex % 2 === 1);
      const cells = rowEl.children;
      (cells[0] as HTMLElement).textContent = String(rowIndex + 1);
      const data = this.rowAt(rowIndex);
      for (let c = 0; c < this.columns.length; c++) {
        const cellEl = cells[c + 1] as HTMLElement;
        const text = data ? formatCell(data[c]) : '';
        if (cellEl.textContent !== text) {
          cellEl.textContent = text;
        }
        cellEl.classList.toggle('null', data !== undefined && data[c] === null);
      }
      rowEl.classList.toggle('loading', !data);
    }
    for (let i = visible; i < this.rowEls.length; i++) {
      this.rowEls[i].style.display = 'none';
    }
  }

  private ensureRowEls(n: number): void {
    while (this.rowEls.length < n) {
      const row = el('div', 'grid-row');
      const num = el('div', 'grid-cell grid-rownum');
      num.style.width = `${this.rownumWidth}px`;
      row.append(num);
      this.columns.forEach((col, i) => {
        const cell = el('div', isNumericType(col.type) ? 'grid-cell num' : 'grid-cell');
        cell.style.width = `${this.widths[i]}px`;
        row.append(cell);
      });
      this.body.append(row);
      this.rowEls.push(row);
    }
  }

  private rowAt(index: number): Cell[] | undefined {
    const block = Math.floor(index / BLOCK);
    const rows = this.blocks.get(block);
    if (!rows) {
      if (!this.pending.has(block)) {
        this.pending.add(block);
        this.source.fetch(block * BLOCK, BLOCK, this.sort, this.filter, this.generation);
      }
      return undefined;
    }
    return rows[index - block * BLOCK];
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
