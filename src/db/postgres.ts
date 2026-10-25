import { Client, type FieldDef } from 'pg';
import Cursor from 'pg-cursor';
import type { ConnectionProfile, DbColumn, DbCursor, DbObject, DbProvider, DbSession } from './types';

/** DuckDB type for a PostgreSQL result column, from its type OID and modifier. */
export function postgresDuckType(oid: number, typmod = -1): string {
  switch (oid) {
    case 16:
      return 'BOOLEAN';
    case 20: // int8
    case 21: // int2
    case 23: // int4
    case 26: // oid
      return 'BIGINT';
    case 700: // float4
    case 701: // float8
      return 'DOUBLE';
    case 1700: {
      // numeric(p, s) packs precision and scale into the modifier; plain numeric has none.
      if (typmod < 4) {
        return 'DOUBLE';
      }
      const p = ((typmod - 4) >> 16) & 0xffff;
      const s = (typmod - 4) & 0xffff;
      return p <= 38 && s <= p ? `DECIMAL(${p},${s})` : 'DOUBLE';
    }
    case 1082:
      return 'DATE';
    case 1083:
      return 'TIME';
    case 1114:
      return 'TIMESTAMP';
    case 1184:
      return 'TIMESTAMPTZ';
    case 1186:
      return 'INTERVAL';
    case 2950:
      return 'UUID';
    default:
      return 'VARCHAR';
  }
}

// Every value comes back as PostgreSQL's own text form; DuckDB does the casting.
const textTypes = { getTypeParser: () => (value: string) => value };

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

class PostgresCursor implements DbCursor {
  columns: DbColumn[] = [];
  private pending: (string | null)[][] | undefined;
  private batchSize = 0;

  constructor(private readonly cursor: Cursor<(string | null)[]>) {}

  /** Reads the first batch, which is also when the column list becomes known. */
  async open(batchSize: number): Promise<void> {
    const { rows, fields } = await new Promise<{ rows: (string | null)[][]; fields: FieldDef[] }>((resolve, reject) =>
      this.cursor.read(batchSize, (err, rows, result) => (err ? reject(err) : resolve({ rows, fields: result.fields }))),
    );
    this.columns = fields.map((f) => ({ name: f.name, duckType: postgresDuckType(f.dataTypeID, f.dataTypeModifier) }));
    this.pending = rows;
    this.batchSize = batchSize;
  }

  async next(): Promise<(string | null)[][]> {
    if (this.pending) {
      const rows = this.pending;
      this.pending = undefined;
      return rows;
    }
    return this.cursor.read(this.batchSize);
  }

  async close(): Promise<void> {
    await this.cursor.close();
  }
}

class PostgresSession implements DbSession {
  constructor(
    private readonly client: Client,
    readonly serverVersion: string,
  ) {}

  async defaultSchema(): Promise<string> {
    const r = await this.client.query<{ s: string }>(`SELECT coalesce(current_schema(), 'public') AS s`);
    return r.rows[0].s;
  }

  async listSchemas(): Promise<string[]> {
    const r = await this.client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\\_%'
       ORDER BY nspname`,
    );
    const schemas = r.rows.map((row) => row.nspname);
    const own = await this.defaultSchema();
    return schemas.includes(own) ? [own, ...schemas.filter((s) => s !== own)] : schemas;
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    // r = table, p = partitioned table, f = foreign table, v = view, m = materialized view.
    const r = await this.client.query<{ relname: string; relkind: string }>(
      `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm') AND NOT c.relispartition
       ORDER BY c.relname`,
      [schema],
    );
    return r.rows.map((row) => ({
      schema,
      name: row.relname,
      kind: row.relkind === 'v' || row.relkind === 'm' ? 'view' : 'table',
    }));
  }

  selectAll(obj: DbObject): string {
    return `SELECT * FROM ${quote(obj.schema)}.${quote(obj.name)}`;
  }

  async query(sql: string, batchSize: number): Promise<DbCursor> {
    const cursor = this.client.query(new Cursor<(string | null)[]>(sql, [], { rowMode: 'array', types: textTypes }));
    const result = new PostgresCursor(cursor);
    try {
      await result.open(batchSize);
    } catch (err) {
      await cursor.close().catch(() => undefined);
      throw err;
    }
    return result;
  }

  async ping(): Promise<void> {
    await this.client.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export const postgresProvider: DbProvider = {
  kind: 'postgres',
  label: 'PostgreSQL',
  defaultPort: 5432,
  async connect(profile: ConnectionProfile, password: string | undefined): Promise<DbSession> {
    const client = new Client({
      host: profile.host || 'localhost',
      port: profile.port ?? 5432,
      database: profile.database || undefined,
      user: profile.user,
      password,
      ssl: profile.ssl === 'require' ? { rejectUnauthorized: false } : profile.ssl === 'verify-full' ? true : undefined,
      application_name: 'VIBE',
      connectionTimeoutMillis: 20000,
    });
    // An idle connection that drops would otherwise raise an unhandled 'error' event.
    client.on('error', () => undefined);
    await client.connect();
    const v = await client.query<{ server_version: string }>('SHOW server_version');
    return new PostgresSession(client, `PostgreSQL ${v.rows[0].server_version}`);
  },
};
