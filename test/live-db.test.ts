// Runs against real databases when they are configured, as in CI:
//   VIBE_PG_HOST, VIBE_PG_PORT, VIBE_PG_DB, VIBE_PG_USER, VIBE_PG_PASSWORD
//   VIBE_ORACLE_CONNECT (e.g. localhost:1521/FREEPDB1), VIBE_ORACLE_USER, VIBE_ORACLE_PASSWORD
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oracleProvider } from '../src/db/oracle';
import { postgresProvider } from '../src/db/postgres';
import { DatabaseService } from '../src/db/service';
import type { ConnectionProfile, ConnectionStore, DbProvider } from '../src/db/types';
import { DataEngine } from '../src/engine/engine';

const env = process.env;
const ROWS = Number(env.VIBE_LIVE_ROWS ?? 200_000);

function storeFor(profile: ConnectionProfile, password: string): ConnectionStore {
  return {
    list: () => [profile],
    save: async () => undefined,
    remove: async () => undefined,
    getPassword: async () => password,
    setPassword: async () => undefined,
  };
}

interface Case {
  provider: DbProvider;
  profile: ConnectionProfile;
  password: string;
  setup: string[];
  schema: string;
  table: string;
  expectTypes: string[];
}

async function exercise(c: Case): Promise<void> {
  const service = new DatabaseService(storeFor(c.profile, c.password), { [c.provider.kind]: c.provider });
  const engine = await DataEngine.create();
  try {
    await run(c, service, engine);
  } finally {
    await service.disconnectAll();
    engine.close();
  }
}

async function run(c: Case, service: DatabaseService, engine: DataEngine): Promise<void> {
  const session = await service.session(c.profile);
  for (const sql of c.setup) {
    const cur = await session.query(sql, 10);
    await cur.close();
  }
  const schemas = await session.listSchemas();
  assert.equal(schemas[0], c.schema);
  const objects = await session.listObjects(c.schema);
  const obj = objects.find((o) => o.name === c.table);
  assert.ok(obj, `table ${c.table} listed in ${objects.map((o) => o.name).join(', ')}`);

  const started = performance.now();
  const r = await service.importTable(c.profile, obj, engine);
  const ms = performance.now() - started;
  console.log(`${c.provider.label}: imported ${r.table.rowCount} rows in ${ms.toFixed(0)} ms (${session.serverVersion})`);
  assert.equal(r.table.rowCount, ROWS);
  assert.deepEqual(r.table.columns.map((col) => col.type), c.expectTypes);

  const [row] = await engine.getRows(r.table.name, 0, 1, { column: r.table.columns[0].name, desc: false });
  assert.equal(String(row[0]), '1');
  assert.equal(row[2], '1.50');
  assert.equal(row[3], '2024-03-04 05:06:07');
  assert.equal(row[4], 'name 1');

  const q = await service.importQuery(c.profile, `SELECT COUNT(*) AS n FROM ${session.selectAll(obj).slice('SELECT * FROM '.length)};`, engine);
  assert.equal(Number((await engine.getRows(q.table.name, 0, 1))[0][0]), ROWS);

  const capped = await service.importTable(c.profile, obj, engine, { maxRows: 1000 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.table.rowCount, 1000);
}

test('PostgreSQL end to end', { skip: !env.VIBE_PG_HOST && 'VIBE_PG_HOST not set' }, async () => {
  await exercise({
    provider: postgresProvider,
    profile: {
      id: 'pg',
      name: 'pg',
      kind: 'postgres',
      host: env.VIBE_PG_HOST,
      port: Number(env.VIBE_PG_PORT ?? 5432),
      database: env.VIBE_PG_DB ?? 'postgres',
      user: env.VIBE_PG_USER ?? 'postgres',
    },
    password: env.VIBE_PG_PASSWORD ?? '',
    setup: [
      'DROP TABLE IF EXISTS vibe_orders',
      `CREATE TABLE vibe_orders AS SELECT g AS id, (g % 7 = 0) AS flag, (g + 0.5)::numeric(12,2) AS amount,
         timestamp '2024-03-04 05:06:07' + (g - 1) * interval '1 minute' AS ordered_at, 'name ' || g AS label,
         (g * 1.25)::float8 AS score, '{"k": 1}'::jsonb AS doc FROM generate_series(1, ${ROWS}) g`,
    ],
    schema: 'public',
    table: 'vibe_orders',
    expectTypes: ['BIGINT', 'BOOLEAN', 'DECIMAL(12,2)', 'TIMESTAMP', 'VARCHAR', 'DOUBLE', 'VARCHAR'],
  });
});

test('Oracle end to end', { skip: !env.VIBE_ORACLE_CONNECT && 'VIBE_ORACLE_CONNECT not set' }, async () => {
  const user = env.VIBE_ORACLE_USER ?? 'vibe';
  await exercise({
    provider: oracleProvider,
    profile: { id: 'ora', name: 'ora', kind: 'oracle', connectString: env.VIBE_ORACLE_CONNECT, user },
    password: env.VIBE_ORACLE_PASSWORD ?? '',
    setup: [
      `BEGIN EXECUTE IMMEDIATE 'DROP TABLE vibe_orders PURGE'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
      `CREATE TABLE vibe_orders AS SELECT CAST(LEVEL AS NUMBER(10)) AS id, CASE WHEN MOD(LEVEL, 7) = 0 THEN 'Y' ELSE 'N' END AS flag,
         CAST(LEVEL + 0.5 AS NUMBER(12,2)) AS amount, TIMESTAMP '2024-03-04 05:06:07' + NUMTODSINTERVAL(LEVEL - 1, 'MINUTE') AS ordered_at,
         'name ' || LEVEL AS label, CAST(LEVEL * 1.25 AS BINARY_DOUBLE) AS score, DATE '2024-01-01' + LEVEL AS due
         FROM dual CONNECT BY LEVEL <= ${ROWS}`,
    ],
    schema: user.toUpperCase(),
    table: 'VIBE_ORDERS',
    expectTypes: ['BIGINT', 'VARCHAR', 'DECIMAL(12,2)', 'TIMESTAMP', 'VARCHAR', 'DOUBLE', 'TIMESTAMP'],
  });
});
