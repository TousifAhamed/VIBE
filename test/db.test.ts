import assert from 'node:assert/strict';
import { test } from 'node:test';
import oracledb from 'oracledb';
import { PanelController } from '../src/controller';
import { oracleDuckType } from '../src/db/oracle';
import { postgresDuckType } from '../src/db/postgres';
import { DatabaseService } from '../src/db/service';
import { cleanSql, localTimestamp, toText, type ConnectionProfile, type ConnectionStore, type DbProvider, type DbSession } from '../src/db/types';
import { DataEngine, ImportCancelled, uniqueColumnNames } from '../src/engine/engine';
import type { HostMessage } from '../src/protocol';

test('Oracle columns map to DuckDB types', () => {
  const num = (precision: number, scale: number) => oracleDuckType({ dbType: oracledb.DB_TYPE_NUMBER, precision, scale });
  assert.equal(num(10, 0), 'BIGINT');
  assert.equal(num(18, 0), 'BIGINT');
  assert.equal(num(38, 0), 'DECIMAL(38,0)');
  assert.equal(num(12, 2), 'DECIMAL(12,2)');
  assert.equal(num(0, -127), 'DOUBLE'); // unconstrained NUMBER or an expression
  assert.equal(num(126, -127), 'DOUBLE'); // FLOAT
  assert.equal(oracleDuckType({ dbType: oracledb.DB_TYPE_DATE }), 'TIMESTAMP');
  assert.equal(oracleDuckType({ dbType: oracledb.DB_TYPE_TIMESTAMP_TZ }), 'TIMESTAMPTZ');
  assert.equal(oracleDuckType({ dbType: oracledb.DB_TYPE_BINARY_DOUBLE }), 'DOUBLE');
  assert.equal(oracleDuckType({ dbType: oracledb.DB_TYPE_VARCHAR }), 'VARCHAR');
  assert.equal(oracleDuckType({ dbType: oracledb.DB_TYPE_CLOB }), 'VARCHAR');
});

test('PostgreSQL columns map to DuckDB types', () => {
  assert.equal(postgresDuckType(23), 'BIGINT');
  assert.equal(postgresDuckType(701), 'DOUBLE');
  assert.equal(postgresDuckType(1700, -1), 'DOUBLE');
  assert.equal(postgresDuckType(1700, ((12 << 16) | 2) + 4), 'DECIMAL(12,2)');
  assert.equal(postgresDuckType(1184), 'TIMESTAMPTZ');
  assert.equal(postgresDuckType(16), 'BOOLEAN');
  assert.equal(postgresDuckType(3802), 'VARCHAR');
});

test('SQL terminators are removed and values become text', () => {
  assert.equal(cleanSql('select 1 from dual;  \n'), 'select 1 from dual');
  assert.equal(cleanSql('select 1 from dual;\n/\n'), 'select 1 from dual');
  assert.equal(cleanSql('select 4/2 from dual'), 'select 4/2 from dual');
  assert.equal(toText(Buffer.from([0xab, 0x01])), 'ab01');
  assert.equal(toText({ a: 1 }), '{"a":1}');
  assert.equal(toText(null), null);
  assert.equal(localTimestamp(new Date(2024, 0, 2, 3, 4, 5, 6)), '2024-01-02 03:04:05.006');
  assert.deepEqual(uniqueColumnNames(['ID', 'id', '', 'ID']), ['ID', 'id_1', 'column3', 'ID_2']);
});

function batches(rows: (string | null)[][], size: number) {
  let i = 0;
  let calls = 0;
  return {
    next: async () => {
      calls++;
      const b = rows.slice(i, i + size);
      i += size;
      return b;
    },
    calls: () => calls,
  };
}

test('importRows casts text into typed columns and respects maxRows', async () => {
  const engine = await DataEngine.create();
  const cols = [
    { name: 'id', duckType: 'BIGINT' },
    { name: 'amount', duckType: 'DECIMAL(12,2)' },
    { name: 'at', duckType: 'TIMESTAMP' },
    { name: 'ok', duckType: 'BOOLEAN' },
    { name: 'name', duckType: 'VARCHAR' },
  ];
  const rows = Array.from({ length: 250_001 }, (_, i) => [String(i), `${i}.25`, '2024-05-06 07:08:09', i % 2 ? 't' : 'f', i === 3 ? null : `n${i}`]);
  const src = batches(rows, 10_000);
  let progressed = 0;
  const all = await engine.importRows('orders', 'test', cols, src.next, { onProgress: (n) => (progressed = n) });
  assert.equal(all.truncated, false);
  assert.equal(all.table.rowCount, 250_001);
  assert.equal(progressed, 250_001);
  assert.deepEqual(all.table.columns.map((c) => c.type), ['BIGINT', 'DECIMAL(12,2)', 'TIMESTAMP', 'BOOLEAN', 'VARCHAR']);
  const [first] = await engine.getRows('orders', 3, 1);
  assert.deepEqual(first.slice(0, 2), ['3', '3.25']);
  assert.equal(first[3], true);
  assert.equal(first[4], null);
  const agg = await engine.aggregate('orders', 'ok', 'amount', 'count');
  assert.equal(agg.values.reduce((a, b) => a + b, 0), 250_001);

  const capped = await engine.importRows('orders', 'test', cols, batches(rows, 10_000).next, { maxRows: 25_000 });
  assert.equal(capped.table.name, 'orders_2');
  assert.equal(capped.table.rowCount, 25_000);
  assert.equal(capped.truncated, true);

  const exact = await engine.importRows('small', 'test', cols, batches(rows.slice(0, 20), 10).next, { maxRows: 20 });
  assert.equal(exact.table.rowCount, 20);
  assert.equal(exact.truncated, false);
  engine.close();
});

test('a cancelled import leaves no table behind', async () => {
  const engine = await DataEngine.create();
  const rows = Array.from({ length: 50 }, (_, i) => [String(i)]);
  let n = 0;
  await assert.rejects(
    engine.importRows('t', 'test', [{ name: 'x', duckType: 'BIGINT' }], batches(rows, 10).next, { isCancelled: () => ++n > 2 }),
    ImportCancelled,
  );
  assert.deepEqual(engine.listTables(), []);
  const out: HostMessage[] = [];
  const controller = new PanelController(engine, (m) => out.push(m), async () => []);
  await controller.importData('db', () => Promise.reject(new ImportCancelled()));
  assert.ok(!out.some((m) => m.type === 'error'));
  engine.close();
});

class MemoryStore implements ConnectionStore {
  profiles: ConnectionProfile[] = [];
  passwords = new Map<string, string>();
  list() {
    return this.profiles;
  }
  async save(p: ConnectionProfile) {
    this.profiles = [...this.profiles.filter((x) => x.id !== p.id), p];
  }
  async remove(id: string) {
    this.profiles = this.profiles.filter((x) => x.id !== id);
  }
  async getPassword(id: string) {
    return this.passwords.get(id);
  }
  async setPassword(id: string, pw: string | undefined) {
    if (pw === undefined) this.passwords.delete(id);
    else this.passwords.set(id, pw);
  }
}

test('DatabaseService reuses sessions, reconnects dead ones and imports', async () => {
  let connects = 0;
  let alive = true;
  const seenSql: string[] = [];
  const fake: DbProvider = {
    kind: 'postgres',
    label: 'Fake',
    defaultPort: 1,
    async connect(_p, pw): Promise<DbSession> {
      assert.equal(pw, 'secret');
      connects++;
      alive = true;
      return {
        serverVersion: 'Fake 1',
        listSchemas: async () => ['public'],
        defaultSchema: async () => 'public',
        listObjects: async (schema) => [{ schema, name: 'Sales Data', kind: 'table' }],
        selectAll: (o) => `SELECT * FROM ${o.name}`,
        async query(sql) {
          seenSql.push(sql);
          const src = batches([['1', 'a'], ['2', 'b']], 1);
          return { columns: [{ name: 'id', duckType: 'BIGINT' }, { name: 'v', duckType: 'VARCHAR' }], next: src.next, close: async () => undefined };
        },
        ping: async () => {
          if (!alive) throw new Error('gone');
        },
        close: async () => undefined,
      };
    },
  };
  const store = new MemoryStore();
  const profile: ConnectionProfile = { id: 'c1', name: 'Local', kind: 'postgres', user: 'u' };
  await store.save(profile);
  await store.setPassword('c1', 'secret');
  const service = new DatabaseService(store, { postgres: fake });
  const engine = await DataEngine.create();

  const r = await service.importTable(profile, { schema: 'public', name: 'Sales Data', kind: 'table' }, engine);
  assert.equal(r.table.name, 'Sales_Data');
  assert.equal(r.table.rowCount, 2);
  await service.importQuery(profile, 'select * from x;', engine);
  assert.equal(seenSql.at(-1), 'select * from x');
  assert.equal(connects, 1);

  alive = false;
  await service.session(profile);
  assert.equal(connects, 2);
  assert.equal(await service.test(profile, 'secret'), 'Fake 1');
  await service.disconnectAll();
  engine.close();
});
