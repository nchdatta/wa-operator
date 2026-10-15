import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { and, asc, gte, isNull, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { ledger } from '../persistence/schema.js';
import { duesByParty } from './store.js';

/**
 * A plain Excel copy of the ledger for the owner to open: Records/Ledger - <year>.xlsx.
 * The encrypted database stays the master copy; this file is rewritten on every export.
 */

const KIND_LABEL = { sale: 'Sale', expense: 'Expense', purchase: 'Purchase', due: 'Due given', due_paid: 'Due paid' };

export async function exportLedger(ctx: AppContext, year: number): Promise<{ file: string; rows: number }> {
  const rows = ctx.db
    .select()
    .from(ledger)
    .where(and(isNull(ledger.deletedAt), gte(ledger.day, `${year}-01-01`), lte(ledger.day, `${year}-12-31`)))
    .orderBy(asc(ledger.day), asc(ledger.createdAt))
    .all();

  const wb = new ExcelJS.Workbook();
  const header = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const money = '#,##0.00';

  const entries = wb.addWorksheet('Entries');
  entries.columns = [
    { header: 'Date', key: 'day', width: 12 },
    { header: 'Type', key: 'kind', width: 11 },
    { header: 'Amount', key: 'amount', width: 12, style: { numFmt: money } },
    { header: 'Customer / Supplier', key: 'party', width: 22 },
    { header: 'Item', key: 'item', width: 24 },
    { header: 'Qty', key: 'qty', width: 7 },
    { header: 'Note', key: 'note', width: 36 },
    { header: 'From', key: 'source', width: 8 },
  ];
  for (const r of rows) entries.addRow({ ...r, kind: KIND_LABEL[r.kind] });
  header(entries);
  entries.autoFilter = { from: 'A1', to: 'H1' };

  const months = wb.addWorksheet('By month');
  months.columns = [
    { header: 'Month', key: 'month', width: 10 },
    ...(['sale', 'expense', 'purchase', 'due', 'due_paid'] as const).map((k) => ({
      header: KIND_LABEL[k],
      key: k,
      width: 13,
      style: { numFmt: money },
    })),
    { header: 'Net', key: 'net', width: 13, style: { numFmt: money } },
  ];
  const byMonth = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const m = byMonth.get(r.day.slice(0, 7)) ?? { sale: 0, expense: 0, purchase: 0, due: 0, due_paid: 0 };
    m[r.kind] = (m[r.kind] ?? 0) + r.amount;
    byMonth.set(r.day.slice(0, 7), m);
  }
  for (const [month, m] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    months.addRow({ month, ...m, net: (m.sale ?? 0) - (m.expense ?? 0) - (m.purchase ?? 0) });
  }
  header(months);

  const dues = wb.addWorksheet('Dues now');
  dues.columns = [
    { header: 'Customer', key: 'party', width: 24 },
    { header: 'Owes', key: 'owed', width: 13, style: { numFmt: money } },
  ];
  for (const d of duesByParty(ctx)) dues.addRow(d);
  header(dues);

  await fs.promises.mkdir(ctx.config.folders.records, { recursive: true });
  const file = path.join(ctx.config.folders.records, `Ledger - ${year}.xlsx`);
  await wb.xlsx.writeFile(file);
  return { file, rows: rows.length };
}
