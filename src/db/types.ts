// The pluggable database layer. Each database (Oracle, PostgreSQL, ...) is a
// DbProvider; everything above it (saved connections, the tree, imports into
// DuckDB) only talks to these interfaces. Kept free of `vscode` for tests.

export type DbKind = 'oracle' | 'postgres';

export interface ConnectionProfile {
  id: string;
  name: string;
  kind: DbKind;
  host?: string;
  port?: number;
  /** Oracle service name or PostgreSQL database name. */
  database?: string;
  /** Oracle only: Easy Connect string, TNS alias or full descriptor, used instead of host/port/service. */
  connectString?: string;
  /** Oracle only: folder with tnsnames.ora (and a wallet for TCPS). */
  configDir?: string;
  /** PostgreSQL only. */
  ssl?: 'disable' | 'require' | 'verify-full';
  user: string;
}

export interface DbObject {
  schema: string;
  name: string;
  kind: 'table' | 'view';
}

/** A result column with the DuckDB type its values are cast to on import. */
export interface DbColumn {
  name: string;
  duckType: string;
}

/**
 * A streaming query result. Values arrive as text (or null) in batches and are
 * cast to `duckType` inside DuckDB, which keeps numbers and timestamps exact.
 */
export interface DbCursor {
  readonly columns: DbColumn[];
  /** Returns the next batch, or an empty array when the result is exhausted. */
  next(): Promise<(string | null)[][]>;
  close(): Promise<void>;
}

export interface DbSession {
  readonly serverVersion: string;
  listSchemas(): Promise<string[]>;
  /** The schema the user lands in, listed first in the tree. */
  defaultSchema(): Promise<string>;
  listObjects(schema: string): Promise<DbObject[]>;
  /** SQL that selects every row of `obj`, quoted for this database. */
  selectAll(obj: DbObject): string;
  query(sql: string, batchSize: number): Promise<DbCursor>;
  /** Throws if the connection is no longer usable. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface DbProvider {
  readonly kind: DbKind;
  readonly label: string;
  readonly defaultPort: number;
  connect(profile: ConnectionProfile, password: string | undefined): Promise<DbSession>;
}

/** Where connection profiles and their passwords are kept. */
export interface ConnectionStore {
  list(): ConnectionProfile[];
  save(profile: ConnectionProfile): Promise<void>;
  remove(id: string): Promise<void>;
  getPassword(id: string): Promise<string | undefined>;
  setPassword(id: string, password: string | undefined): Promise<void>;
}

/** Turns a driver value into the text DuckDB casts from. */
export function toText(v: unknown): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
    return String(v);
  }
  if (v instanceof Date) {
    return v.toISOString();
  }
  if (v instanceof Uint8Array) {
    return Buffer.from(v).toString('hex');
  }
  if (ArrayBuffer.isView(v)) {
    return JSON.stringify(Array.from(v as unknown as ArrayLike<number>));
  }
  return JSON.stringify(v);
}

/** Formats a Date's local wall-clock time, which is how drivers return zone-less timestamps. */
export function localTimestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/** Removes trailing semicolons and SQL*Plus `/` terminators, which drivers reject. */
export function cleanSql(sql: string): string {
  let s = sql.trim();
  for (;;) {
    const next = s.replace(/(;|\n\s*\/)\s*$/, '').trimEnd();
    if (next === s) {
      return s;
    }
    s = next;
  }
}
