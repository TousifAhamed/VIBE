import ExcelJS from 'exceljs';

export interface SheetData {
  name: string;
  columns: string[];
  types: ('DOUBLE' | 'BOOLEAN' | 'TIMESTAMP' | 'VARCHAR')[];
  /** Every value is text (or null) so it can go through a VARCHAR appender. */
  rows: (string | null)[][];
}

type Scalar = string | number | boolean | Date | null;

/** Flattens ExcelJS cell values (formulas, rich text, hyperlinks) to a scalar. */
export function cellScalar(value: ExcelJS.CellValue): Scalar {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) {
    return value;
  }
  if (typeof value === 'object') {
    if ('result' in value) {
      return cellScalar(value.result as ExcelJS.CellValue);
    }
    if ('richText' in value) {
      return value.richText.map((r) => r.text).join('');
    }
    if ('text' in value) {
      return String(value.text);
    }
    if ('error' in value) {
      return null;
    }
  }
  return String(value);
}

function inferType(values: Scalar[]): SheetData['types'][number] {
  let kind: SheetData['types'][number] | undefined;
  for (const v of values) {
    if (v === null || v === '') {
      continue;
    }
    const t = typeof v === 'number' ? 'DOUBLE' : typeof v === 'boolean' ? 'BOOLEAN' : v instanceof Date ? 'TIMESTAMP' : 'VARCHAR';
    if (kind === undefined) {
      kind = t;
    } else if (kind !== t) {
      return 'VARCHAR';
    }
  }
  return kind ?? 'VARCHAR';
}

function toText(v: Scalar): string | null {
  if (v === null) {
    return null;
  }
  if (v instanceof Date) {
    return v.toISOString().replace('T', ' ').replace('Z', '');
  }
  return String(v);
}

/** Reads every non-empty worksheet. The first non-empty row is the header. */
export async function readExcel(path: string): Promise<SheetData[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheets: SheetData[] = [];

  for (const ws of workbook.worksheets) {
    const grid: Scalar[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values: Scalar[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        values[col - 1] = cellScalar(cell.value);
      });
      grid.push(Array.from(values, (v) => (v === undefined ? null : v)));
    });
    if (grid.length === 0) {
      continue;
    }

    const width = Math.max(...grid.map((r) => r.length));
    const header = grid[0];
    const seen = new Map<string, number>();
    const columns = Array.from({ length: width }, (_, i) => {
      const base = toText(header[i] ?? null)?.trim() || `column${i + 1}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n === 0 ? base : `${base}_${n}`;
    });

    const body = grid.slice(1);
    const types = columns.map((_, i) => inferType(body.map((r) => r[i] ?? null)));
    const rows = body.map((r) => columns.map((_, i) => toText(r[i] ?? null)));
    sheets.push({ name: ws.name, columns, types, rows });
  }
  return sheets;
}
