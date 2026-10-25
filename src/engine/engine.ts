import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { open } from 'node:fs/promises';
import * as path from 'node:path';
import type { Aggregation, Cell, ColumnInfo, FilterSpec, SortSpec, TableInfo } from '../protocol';
import { detectDelimiter } from './delimiter';
import { readExcel } from './excel';

export const SUPPORTED_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx'];

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Turns a file name into a readable SQL table name. */
export function tableNameFor(file: string): string {
  const base = path.basename(file, path.extname(file));
  const cleaned = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `t_${cleaned || 'data'}`;
}

async function readSample(file: string, bytes = 64 * 1024): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v ?? null;
  }
  return JSON.stringify(v);
}

/**
 * In-memory analytical store backed by DuckDB. Every loaded file becomes a
 * table; the UI pulls windows of rows and aggregates on demand, so the cost of
 * showing a 10M row file is the cost of the rows on screen.
 */
export class DataEngine {
  private readonly tables = new Map<string, TableInfo>();

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  static async create(): Promise<DataEngine> {
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    return new DataEngine(instance, conn);
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
  }

  listTables(): TableInfo[] {
    return [...this.tables.values()];
  }

  getTable(name: string): TableInfo {
    const t = this.tables.get(name);
    if (!t) {
      throw new Error(`Unknown table: ${name}`);
    }
    return t;
  }

  private uniqueName(base: string): string {
    let name = base;
    for (let i = 2; this.tables.has(name); i++) {
      name = `${base}_${i}`;
    }
    return name;
  }

  /** Loads a file and returns the tables it produced (one per Excel sheet). */
  async loadFile(file: string): Promise<TableInfo[]> {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.xlsx') {
      return this.loadExcel(file);
    }
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      throw new Error(`Unsupported file type: ${ext || path.basename(file)}`);
    }
    const delim = ext === '.tsv' ? '\t' : detectDelimiter(await readSample(file));
    return [await this.loadDelimited(file, delim)];
  }

  async loadDelimited(file: string, delim: string): Promise<TableInfo> {
    const name = this.uniqueName(tableNameFor(file));
    await this.conn.run(
      `CREATE TABLE ${quoteIdent(name)} AS SELECT * FROM read_csv(${quoteLiteral(file)}, delim = ${quoteLiteral(delim)}, header = true, sample_size = 20480)`,
    );
    return this.register(name, file);
  }

  private async loadExcel(file: string): Promise<TableInfo[]> {
    const sheets = await readExcel(file);
    if (sheets.length === 0) {
      throw new Error(`No data found in ${path.basename(file)}`);
    }
    const loaded: TableInfo[] = [];
    for (const sheet of sheets) {
      const base = sheets.length === 1 ? tableNameFor(file) : `${tableNameFor(file)}_${tableNameFor(sheet.name)}`;
      const name = this.uniqueName(base);
      const staging = `__stage_${name}`;
      const cols = sheet.columns.map((c) => `${quoteIdent(c)} VARCHAR`).join(', ');
      await this.conn.run(`CREATE TEMP TABLE ${quoteIdent(staging)} (${cols})`);
      const appender = await this.conn.createAppender(staging, 'main', 'temp');
      for (const row of sheet.rows) {
        for (const v of row) {
          if (v === null) {
            appender.appendNull();
          } else {
            appender.appendVarchar(v);
          }
        }
        appender.endRow();
      }
      appender.closeSync();
      const casts = sheet.columns
        .map((c, i) => `CAST(${quoteIdent(c)} AS ${sheet.types[i]}) AS ${quoteIdent(c)}`)
        .join(', ');
      await this.conn.run(`CREATE TABLE ${quoteIdent(name)} AS SELECT ${casts} FROM temp.${quoteIdent(staging)}`);
      await this.conn.run(`DROP TABLE temp.${quoteIdent(staging)}`);
      loaded.push(await this.register(name, sheets.length === 1 ? file : `${file} [${sheet.name}]`));
    }
    return loaded;
  }

  private async register(name: string, source: string): Promise<TableInfo> {
    const desc = await this.conn.runAndReadAll(`DESCRIBE ${quoteIdent(name)}`);
    const columns: ColumnInfo[] = desc.getRowObjectsJson().map((r) => ({
      name: String(r.column_name),
      type: String(r.column_type),
    }));
    const count = await this.conn.runAndReadAll(`SELECT count(*)::DOUBLE AS n FROM ${quoteIdent(name)}`);
    const info: TableInfo = { name, source, columns, rowCount: Number(count.getRowsJS()[0][0]) };
    this.tables.set(name, info);
    return info;
  }

  private whereClause(table: TableInfo, filter?: FilterSpec): string {
    if (!filter || filter.values.length === 0) {
      return '';
    }
    this.checkColumn(table, filter.column);
    const list = filter.values.map(quoteLiteral).join(', ');
    return ` WHERE CAST(${quoteIdent(filter.column)} AS VARCHAR) IN (${list})`;
  }

  private checkColumn(table: TableInfo, column: string): void {
    if (!table.columns.some((c) => c.name === column)) {
      throw new Error(`Unknown column ${column} in ${table.name}`);
    }
  }

  async countRows(tableName: string, filter?: FilterSpec): Promise<number> {
    const table = this.getTable(tableName);
    if (!filter || filter.values.length === 0) {
      return table.rowCount;
    }
    const r = await this.conn.runAndReadAll(
      `SELECT count(*)::DOUBLE FROM ${quoteIdent(table.name)}${this.whereClause(table, filter)}`,
    );
    return Number(r.getRowsJS()[0][0]);
  }

  /** Returns one window of rows, already converted to JSON-safe cells. */
  async getRows(tableName: string, offset: number, limit: number, sort?: SortSpec, filter?: FilterSpec): Promise<Cell[][]> {
    const table = this.getTable(tableName);
    let sql = `SELECT * FROM ${quoteIdent(table.name)}${this.whereClause(table, filter)}`;
    if (sort) {
      this.checkColumn(table, sort.column);
      sql += ` ORDER BY ${quoteIdent(sort.column)} ${sort.desc ? 'DESC' : 'ASC'} NULLS LAST`;
    }
    sql += ` LIMIT ${Math.max(0, Math.floor(limit))} OFFSET ${Math.max(0, Math.floor(offset))}`;
    const reader = await this.conn.runAndReadAll(sql);
    return reader.getRowsJson().map((row) => row.map(toCell));
  }

  /** Groups by `x` and aggregates `y` (or counts rows), keeping the largest groups. */
  async aggregate(
    tableName: string,
    x: string,
    y: string | null,
    agg: Aggregation,
    orderBy: 'value' | 'label' = 'value',
    maxGroups = 50,
  ): Promise<{ labels: string[]; values: number[] }> {
    const table = this.getTable(tableName);
    this.checkColumn(table, x);
    let measure: string;
    if (agg === 'count' || !y) {
      measure = 'count(*)';
    } else {
      this.checkColumn(table, y);
      measure = `${agg}(TRY_CAST(${quoteIdent(y)} AS DOUBLE))`;
    }
    const xs = quoteIdent(x);
    // Keep the top groups by value, then order them for display.
    const sql =
      `SELECT label, value FROM (` +
      `SELECT ${xs} AS k, CAST(${xs} AS VARCHAR) AS label, (${measure})::DOUBLE AS value ` +
      `FROM ${quoteIdent(table.name)} GROUP BY ${xs} ORDER BY value DESC NULLS LAST LIMIT ${maxGroups}) ` +
      (orderBy === 'label' ? `ORDER BY k NULLS LAST` : `ORDER BY value DESC NULLS LAST`);
    const reader = await this.conn.runAndReadAll(sql);
    const rows = reader.getRowsJS();
    return {
      labels: rows.map((r) => (r[0] === null ? '(null)' : String(r[0]))),
      values: rows.map((r) => (r[1] === null ? 0 : Number(r[1]))),
    };
  }
}
