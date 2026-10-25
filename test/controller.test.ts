import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { PanelController } from '../src/controller';
import { DataEngine } from '../src/engine/engine';
import type { HostMessage } from '../src/protocol';

const fixtures = path.join(__dirname, '..', '..', 'test', 'fixtures');

test('controller loads a file and serves rows and aggregates', async () => {
  const engine = await DataEngine.create();
  const out: HostMessage[] = [];
  const controller = new PanelController(engine, (m) => out.push(m), async () => [path.join(fixtures, 'sales.csv')]);

  await controller.handle({ type: 'pickFile' });
  const tables = out.find((m) => m.type === 'tables');
  assert.ok(tables && tables.type === 'tables');
  assert.equal(tables.active, 'sales');

  await controller.handle({ type: 'getRows', reqId: 7, table: 'sales', offset: 0, limit: 2, filter: { column: 'region', values: ['West'] } });
  const rows = out.at(-1);
  assert.ok(rows?.type === 'rows');
  assert.equal(rows.reqId, 7);
  assert.equal(rows.total, 2);
  assert.equal(rows.rows.length, 2);

  await controller.handle({ type: 'aggregate', reqId: 8, table: 'sales', x: 'region', y: 'units', agg: 'max', orderBy: 'value' });
  const agg = out.at(-1);
  assert.ok(agg?.type === 'aggregate');
  assert.equal(agg.labels[0], 'West');
  assert.equal(agg.values[0], 20);

  await controller.handle({ type: 'getRows', reqId: 9, table: 'missing', offset: 0, limit: 1 });
  assert.equal(out.at(-1)?.type, 'error');
  engine.close();
});

test('controller reports load failures without stopping', async () => {
  const engine = await DataEngine.create();
  const out: HostMessage[] = [];
  const controller = new PanelController(engine, (m) => out.push(m), async () => []);
  await controller.loadFiles(['/nope/missing.csv', path.join(fixtures, 'scores_pipe.txt')]);
  assert.ok(out.some((m) => m.type === 'error' && m.message.includes('missing.csv')));
  const tables = out.at(-1);
  assert.ok(tables?.type === 'tables');
  assert.deepEqual(tables.tables.map((t) => t.name), ['scores_pipe']);
  engine.close();
});
