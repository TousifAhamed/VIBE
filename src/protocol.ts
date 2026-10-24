// Messages exchanged between the extension host and the data panel webview.
// Data never leaves DuckDB in bulk: the webview asks for row windows and
// aggregates, and the host answers with just what is on screen.

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface TableInfo {
  name: string;
  source: string;
  columns: ColumnInfo[];
  rowCount: number;
}

export type Aggregation = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface SortSpec {
  column: string;
  desc: boolean;
}

/** Rows are kept when `column` equals one of `values` (rendered as text). */
export interface FilterSpec {
  column: string;
  values: string[];
}

export type Cell = string | number | boolean | null;

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'pickFile' }
  | { type: 'getRows'; reqId: number; table: string; offset: number; limit: number; sort?: SortSpec; filter?: FilterSpec }
  | { type: 'aggregate'; reqId: number; table: string; x: string; y: string | null; agg: Aggregation; orderBy: 'value' | 'label' };

export type HostMessage =
  | { type: 'tables'; tables: TableInfo[]; active?: string }
  | { type: 'loading'; file: string }
  | { type: 'rows'; reqId: number; table: string; offset: number; total: number; rows: Cell[][] }
  | { type: 'aggregate'; reqId: number; labels: string[]; values: number[] }
  | { type: 'error'; message: string };
