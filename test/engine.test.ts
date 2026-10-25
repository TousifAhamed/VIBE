import ExcelJS from 'exceljs';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { DataEngine, tableNameFor } from '../src/engine/engine';

const fixtures = path.join(__dirname, '..', '..', 'test', 'fixtures');
let engine: DataEngine;

before(async () => {
  engine = await DataEngine.create();
});
after(() => engine.close());

test('tableNameFor makes safe identifiers', () => {
  assert.equal(tableNameFor('/x/My Sales (2026).csv'), 'My_Sales_2026');
  assert.equal(tableNameFor('/x/2026.csv'), 't_2026');
});

test('loads a CSV with quoted fields and typed columns', async () => {
  const [t] = await engine.loadFile(path.join(fixtures, 'sales.csv'));
  assert.equal(t.name, 'sales');
  assert.equal(t.rowCount, 10);
  const types = Object.fromEntries(t.columns.map((c) => [c.name, c.type]));
  assert.equal(types.region, 'VARCHAR');
  assert.equal(types.revenue, 'DOUBLE');
  assert.equal(types.order_date, 'DATE');
  const rows = await engine.getRows('sales', 9, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], 'South, Coastal');
});

test('loads TXT files with detected delimiters', async () => {
  const [pipe] = await engine.loadFile(path.join(fixtures, 'scores_pipe.txt'));
  assert.deepEqual(pipe.columns.map((c) => c.name), ['id', 'name', 'score']);
  assert.equal(pipe.rowCount, 4);
  const [tab] = await engine.loadFile(path.join(fixtures, 'cities_tab.txt'));
  assert.deepEqual(tab.columns.map((c) => c.name), ['id', 'city', 'population']);
  const [semi] = await engine.loadFile(path.join(fixtures, 'semicolon.txt'));
  assert.deepEqual(semi.columns.map((c) => c.name), ['code', 'label', 'amount']);
  assert.equal(semi.rowCount, 3);
});

test('loading the same file twice keeps both tables', async () => {
  const [again] = await engine.loadFile(path.join(fixtures, 'scores_pipe.txt'));
  assert.equal(again.name, 'scores_pipe_2');
});

test('loads every sheet of an Excel workbook with inferred types', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-'));
  const file = path.join(dir, 'Budget.xlsx');
  const wb = new ExcelJS.Workbook();
  const plan = wb.addWorksheet('Plan');
  plan.addRow(['dept', 'amount', 'approved', 'due']);
  plan.addRow(['Ops', 1200.5, true, new Date(Date.UTC(2026, 0, 15))]);
  plan.addRow(['R&D', { formula: '1000*2', result: 2000 }, false, new Date(Date.UTC(2026, 1, 1))]);
  plan.addRow(['HR', null, true, null]);
  const notes = wb.addWorksheet('Notes');
  notes.addRow(['note', 'note']);
  notes.addRow([{ richText: [{ text: 'Hello ' }, { text: 'world' }] }, 'x']);
  wb.addWorksheet('Empty');
  await wb.xlsx.writeFile(file);

  const loaded = await engine.loadFile(file);
  assert.deepEqual(loaded.map((t) => t.name), ['Budget_Plan', 'Budget_Notes']);
  const types = Object.fromEntries(loaded[0].columns.map((c) => [c.name, c.type]));
  assert.deepEqual(types, { dept: 'VARCHAR', amount: 'DOUBLE', approved: 'BOOLEAN', due: 'TIMESTAMP' });
  const rows = await engine.getRows('Budget_Plan', 0, 10);
  assert.equal(rows[1][1], 2000);
  assert.equal(rows[2][1], null);
  assert.deepEqual(loaded[1].columns.map((c) => c.name), ['note', 'note_1']);
  assert.equal((await engine.getRows('Budget_Notes', 0, 1))[0][0], 'Hello world');
});

test('pages, sorts and filters rows', async () => {
  const sorted = await engine.getRows('sales', 0, 3, { column: 'revenue', desc: true });
  assert.deepEqual(sorted.map((r) => r[4]), [600, 330, 300]);
  const filter = { column: 'region', values: ['North'] };
  assert.equal(await engine.countRows('sales', filter), 3);
  const north = await engine.getRows('sales', 0, 10, undefined, filter);
  assert.ok(north.every((r) => r[1] === 'North'));
});

test('aggregates for the chart', async () => {
  const sum = await engine.aggregate('sales', 'product', 'revenue', 'sum');
  assert.deepEqual(sum.labels, ['Gizmo', 'Widget', 'Gadget']);
  assert.deepEqual(sum.values, [1050, 860.75, 560]);
  const counts = await engine.aggregate('sales', 'order_date', null, 'count', 'label');
  assert.equal(counts.labels[0], '2026-01-03');
  assert.equal(counts.values[1], 2);
});

test('rejects unknown columns and unsupported files', async () => {
  await assert.rejects(engine.getRows('sales', 0, 1, { column: 'nope', desc: false }), /Unknown column/);
  await assert.rejects(engine.loadFile('/tmp/data.parquet'), /Unsupported/);
});
