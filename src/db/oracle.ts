import oracledb from 'oracledb';
import { localTimestamp, toText, type ConnectionProfile, type DbColumn, type DbCursor, type DbObject, type DbProvider, type DbSession } from './types';

type Meta = oracledb.Metadata<unknown>;

/** DuckDB type for an Oracle result column. */
export function oracleDuckType(meta: Pick<Meta, 'dbType' | 'precision' | 'scale'>): string {
  const t = meta.dbType;
  if (t === oracledb.DB_TYPE_NUMBER) {
    const p = meta.precision ?? 0;
    const s = meta.scale ?? -127;
    // Unconstrained NUMBER, FLOAT and expressions report scale -127.
    if (p === 0 || s === -127 || s < 0) {
      return 'DOUBLE';
    }
    if (s === 0 && p <= 18) {
      return 'BIGINT';
    }
    return p <= 38 && s <= p ? `DECIMAL(${p},${s})` : 'DOUBLE';
  }
  if (t === oracledb.DB_TYPE_BINARY_FLOAT || t === oracledb.DB_TYPE_BINARY_DOUBLE || t === oracledb.DB_TYPE_BINARY_INTEGER) {
    return 'DOUBLE';
  }
  if (t === oracledb.DB_TYPE_DATE || t === oracledb.DB_TYPE_TIMESTAMP) {
    return 'TIMESTAMP';
  }
  if (t === oracledb.DB_TYPE_TIMESTAMP_TZ || t === oracledb.DB_TYPE_TIMESTAMP_LTZ) {
    return 'TIMESTAMPTZ';
  }
  if (t === oracledb.DB_TYPE_BOOLEAN) {
    return 'BOOLEAN';
  }
  return 'VARCHAR';
}

/** How each column is fetched, chosen so every value converts to exact text. */
function fetchTypeHandler(meta: Meta): oracledb.FetchTypeResponse | undefined {
  const t = meta.dbType;
  if (t === oracledb.DB_TYPE_NUMBER || t === oracledb.DB_TYPE_CLOB || t === oracledb.DB_TYPE_NCLOB) {
    return { type: oracledb.STRING };
  }
  if (t === oracledb.DB_TYPE_DATE || t === oracledb.DB_TYPE_TIMESTAMP) {
    // The driver builds zone-less values as local-time Dates; read them back the same way.
    return { converter: (d) => (d instanceof Date ? localTimestamp(d) : null) };
  }
  if (t === oracledb.DB_TYPE_BLOB || t === oracledb.DB_TYPE_BFILE) {
    // Binary objects are not useful for analysis and can be huge, so they are left out.
    return { converter: () => null };
  }
  return undefined;
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

class OracleCursor implements DbCursor {
  constructor(
    readonly columns: DbColumn[],
    private readonly rs: oracledb.ResultSet<unknown[]> | undefined,
    private readonly batchSize: number,
  ) {}

  async next(): Promise<(string | null)[][]> {
    if (!this.rs) {
      return [];
    }
    const rows = await this.rs.getRows(this.batchSize);
    return rows.map((r) => r.map(toText));
  }

  async close(): Promise<void> {
    await this.rs?.close();
  }
}

class OracleSession implements DbSession {
  constructor(private readonly conn: oracledb.Connection) {}

  get serverVersion(): string {
    return `Oracle ${this.conn.oracleServerVersionString}`;
  }

  private async rows(sql: string, binds: oracledb.BindParameters = []): Promise<unknown[][]> {
    const r = await this.conn.execute<unknown[]>(sql, binds, { outFormat: oracledb.OUT_FORMAT_ARRAY });
    return r.rows ?? [];
  }

  async defaultSchema(): Promise<string> {
    const [[user]] = await this.rows(`SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL`);
    return String(user);
  }

  async listSchemas(): Promise<string[]> {
    const objects = `SELECT DISTINCT o.owner FROM all_objects o WHERE o.object_type IN ('TABLE', 'VIEW')`;
    let rows: unknown[][];
    try {
      // ORACLE_MAINTAINED (12c+) hides SYS, SYSTEM and the other built-in schemas.
      rows = await this.rows(
        `${objects} AND o.owner IN (SELECT username FROM all_users WHERE oracle_maintained = 'N') ORDER BY 1`,
      );
    } catch {
      rows = await this.rows(`${objects} ORDER BY 1`);
    }
    const schemas = rows.map((r) => String(r[0]));
    const own = await this.defaultSchema();
    return [own, ...schemas.filter((s) => s !== own)];
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const rows = await this.rows(
      `SELECT object_name, MIN(object_type) FROM all_objects
       WHERE owner = :owner AND object_type IN ('TABLE', 'VIEW') AND object_name NOT LIKE 'BIN$%'
       GROUP BY object_name ORDER BY object_name`,
      { owner: schema },
    );
    return rows.map((r) => ({ schema, name: String(r[0]), kind: r[1] === 'VIEW' ? 'view' : 'table' }));
  }

  selectAll(obj: DbObject): string {
    return `SELECT * FROM ${quote(obj.schema)}.${quote(obj.name)}`;
  }

  async query(sql: string, batchSize: number): Promise<DbCursor> {
    const r = await this.conn.execute<unknown[]>(sql, [], {
      resultSet: true,
      outFormat: oracledb.OUT_FORMAT_ARRAY,
      fetchArraySize: batchSize,
      prefetchRows: batchSize,
      fetchTypeHandler,
    });
    const columns = (r.metaData ?? []).map((m) => ({ name: m.name, duckType: oracleDuckType(m) }));
    return new OracleCursor(columns, r.resultSet, batchSize);
  }

  async ping(): Promise<void> {
    await this.conn.ping();
  }

  async close(): Promise<void> {
    await this.conn.close();
  }
}

/** Oracle through node-oracledb Thin mode: pure JavaScript, no Instant Client needed. */
export const oracleProvider: DbProvider = {
  kind: 'oracle',
  label: 'Oracle',
  defaultPort: 1521,
  async connect(profile: ConnectionProfile, password: string | undefined): Promise<DbSession> {
    const connectString =
      profile.connectString?.trim() || `${profile.host ?? 'localhost'}:${profile.port ?? 1521}/${profile.database ?? ''}`;
    const conn = await oracledb.getConnection({
      user: profile.user,
      password,
      connectString,
      configDir: profile.configDir || undefined,
      walletLocation: profile.configDir || undefined,
      connectTimeout: 20,
    });
    return new OracleSession(conn);
  },
};
