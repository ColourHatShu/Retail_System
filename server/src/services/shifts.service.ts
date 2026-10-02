import { currentDb, row, rows, withTransaction } from '../db';
import type { Queryable } from '../db';
import { conflict, notFound } from '../lib/errors';
import { fromCents, toCents } from '../lib/money';
import type { AuthUser } from '../types';

/**
 * The cash drawer. One shift is open at a time per shop: it starts with a
 * counted float, every cash sale, cash refund and pay-in/out lands on it, and
 * closing it compares the cashier's count with what the system expected.
 */

interface ShiftRow {
  id: number;
  status: 'OPEN' | 'CLOSED';
  opened_by: number | null;
  opened_by_name: string | null;
  opened_at: string;
  opening_float_cents: number;
  closed_by: number | null;
  closed_by_name: string | null;
  closed_at: string | null;
  expected_cash_cents: number | null;
  counted_cash_cents: number | null;
  note: string | null;
}

export interface CashMovement {
  id: number;
  type: 'PAY_IN' | 'PAY_OUT';
  amount: number;
  reason: string;
  user_name: string | null;
  created_at: string;
}

export interface ShiftReport {
  id: number;
  status: 'OPEN' | 'CLOSED';
  opened_at: string;
  opened_by_name: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  note: string | null;
  opening_float: number;
  sales_count: number;
  sales_total: number;
  tax_total: number;
  discount_total: number;
  /** What each tender actually brought in; cash is net of change given. */
  tenders: Record<string, number>;
  refunds_count: number;
  refunds_total: number;
  refunds_by_method: Record<string, number>;
  pay_ins: number;
  pay_outs: number;
  movements: CashMovement[];
  expected_cash: number;
  counted_cash: number | null;
  /** counted - expected: positive is over, negative is short. */
  over_short: number | null;
}

const SHIFT_SELECT = `
  SELECT sh.*, ou.display_name AS opened_by_name, cu.display_name AS closed_by_name
  FROM shifts sh
  LEFT JOIN users ou ON ou.id = sh.opened_by
  LEFT JOIN users cu ON cu.id = sh.closed_by
`;

async function buildReport(db: Queryable, sh: ShiftRow): Promise<ShiftReport> {
  const sales = (await row<{ n: number; total: number; tax: number; discount: number; change: number }>(
    db,
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_cents), 0) AS total, COALESCE(SUM(tax_cents), 0) AS tax,
            COALESCE(SUM(discount_cents), 0) AS discount, COALESCE(SUM(change_due_cents), 0) AS change
     FROM sales WHERE shift_id = $1`,
    [sh.id],
  ))!;
  const tenderRows = await rows<{ method: string; cents: number }>(
    db,
    `SELECT sp.method, SUM(sp.amount_cents) AS cents
     FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
     WHERE s.shift_id = $1 GROUP BY sp.method`,
    [sh.id],
  );
  const refundRows = await rows<{ method: string; n: number; cents: number }>(
    db,
    `SELECT refund_method AS method, COUNT(*)::int AS n, SUM(refund_cents) AS cents
     FROM returns WHERE shift_id = $1 GROUP BY refund_method`,
    [sh.id],
  );
  const moves = await rows<{
    id: number;
    type: 'PAY_IN' | 'PAY_OUT';
    amount_cents: number;
    reason: string;
    user_name: string | null;
    created_at: string;
  }>(
    db,
    `SELECT cm.id, cm.type, cm.amount_cents, cm.reason, u.display_name AS user_name, cm.created_at
     FROM cash_movements cm LEFT JOIN users u ON u.id = cm.user_id
     WHERE cm.shift_id = $1 ORDER BY cm.id`,
    [sh.id],
  );

  const tenders: Record<string, number> = {};
  for (const t of tenderRows) tenders[t.method] = t.cents;
  tenders.CASH = (tenders.CASH ?? 0) - sales.change;

  const refundsBy: Record<string, number> = {};
  for (const r of refundRows) refundsBy[r.method] = r.cents;
  const payIns = moves.filter((m) => m.type === 'PAY_IN').reduce((a, m) => a + m.amount_cents, 0);
  const payOuts = moves.filter((m) => m.type === 'PAY_OUT').reduce((a, m) => a + m.amount_cents, 0);

  const expected =
    sh.status === 'CLOSED' && sh.expected_cash_cents !== null
      ? sh.expected_cash_cents
      : sh.opening_float_cents + tenders.CASH - (refundsBy.CASH ?? 0) + payIns - payOuts;

  const money = (rec: Record<string, number>) =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, fromCents(v)]));

  return {
    id: sh.id,
    status: sh.status,
    opened_at: sh.opened_at,
    opened_by_name: sh.opened_by_name,
    closed_at: sh.closed_at,
    closed_by_name: sh.closed_by_name,
    note: sh.note,
    opening_float: fromCents(sh.opening_float_cents),
    sales_count: sales.n,
    sales_total: fromCents(sales.total),
    tax_total: fromCents(sales.tax),
    discount_total: fromCents(sales.discount),
    tenders: money(tenders),
    refunds_count: refundRows.reduce((a, r) => a + r.n, 0),
    refunds_total: fromCents(refundRows.reduce((a, r) => a + r.cents, 0)),
    refunds_by_method: money(refundsBy),
    pay_ins: fromCents(payIns),
    pay_outs: fromCents(payOuts),
    movements: moves.map((m) => ({
      id: m.id,
      type: m.type,
      amount: fromCents(m.amount_cents),
      reason: m.reason,
      user_name: m.user_name,
      created_at: m.created_at,
    })),
    expected_cash: fromCents(expected),
    counted_cash: sh.counted_cash_cents === null ? null : fromCents(sh.counted_cash_cents),
    over_short: sh.counted_cash_cents === null ? null : fromCents(sh.counted_cash_cents - expected),
  };
}

async function openShiftRow(db: Queryable, lock = false): Promise<ShiftRow | undefined> {
  return row<ShiftRow>(db, `${SHIFT_SELECT} WHERE sh.status = 'OPEN'${lock ? ' FOR UPDATE OF sh' : ''}`);
}

export async function getCurrentShift(): Promise<ShiftReport | null> {
  const db = currentDb();
  const sh = await openShiftRow(db);
  return sh ? buildReport(db, sh) : null;
}

export async function getShift(id: number): Promise<ShiftReport> {
  const db = currentDb();
  const sh = await row<ShiftRow>(db, `${SHIFT_SELECT} WHERE sh.id = $1`, [id]);
  if (!sh) throw notFound('Shift not found');
  return buildReport(db, sh);
}

export async function listShifts(limit: number): Promise<
  Array<{
    id: number;
    status: string;
    opened_at: string;
    opened_by_name: string | null;
    closed_at: string | null;
    closed_by_name: string | null;
    expected_cash: number | null;
    counted_cash: number | null;
    over_short: number | null;
  }>
> {
  const list = await rows<ShiftRow>(currentDb(), `${SHIFT_SELECT} ORDER BY sh.id DESC LIMIT $1`, [limit]);
  return list.map((sh) => ({
    id: sh.id,
    status: sh.status,
    opened_at: sh.opened_at,
    opened_by_name: sh.opened_by_name,
    closed_at: sh.closed_at,
    closed_by_name: sh.closed_by_name,
    expected_cash: sh.expected_cash_cents === null ? null : fromCents(sh.expected_cash_cents),
    counted_cash: sh.counted_cash_cents === null ? null : fromCents(sh.counted_cash_cents),
    over_short:
      sh.counted_cash_cents === null || sh.expected_cash_cents === null
        ? null
        : fromCents(sh.counted_cash_cents - sh.expected_cash_cents),
  }));
}

export async function openShift(openingFloat: number, user: AuthUser): Promise<ShiftReport> {
  return withTransaction(async (tx) => {
    if (await openShiftRow(tx)) {
      throw conflict('SHIFT_ALREADY_OPEN', 'A shift is already open. Close it before opening another.');
    }
    try {
      await tx.query('INSERT INTO shifts (opening_float_cents, opened_by) VALUES ($1, $2)', [
        toCents(openingFloat),
        user.id,
      ]);
    } catch (err) {
      // Two counters pressing "Open" together: the unique index lets one win.
      if ((err as { code?: string }).code === '23505') {
        throw conflict('SHIFT_ALREADY_OPEN', 'A shift is already open. Close it before opening another.');
      }
      throw err;
    }
    return buildReport(tx, (await openShiftRow(tx))!);
  });
}

export async function addCashMovement(
  type: 'PAY_IN' | 'PAY_OUT',
  amount: number,
  reason: string,
  user: AuthUser,
): Promise<ShiftReport> {
  return withTransaction(async (tx) => {
    const sh = await openShiftRow(tx, true);
    if (!sh) throw conflict('NO_OPEN_SHIFT', 'Open a shift before taking cash in or out of the drawer.');
    await tx.query(
      'INSERT INTO cash_movements (shift_id, type, amount_cents, reason, user_id) VALUES ($1, $2, $3, $4, $5)',
      [sh.id, type, toCents(amount), reason, user.id],
    );
    return buildReport(tx, sh);
  });
}

export async function closeShift(countedCash: number, note: string | undefined, user: AuthUser): Promise<ShiftReport> {
  return withTransaction(async (tx) => {
    const sh = await openShiftRow(tx, true);
    if (!sh) throw conflict('NO_OPEN_SHIFT', 'There is no open shift to close.');
    const live = await buildReport(tx, sh);
    await tx.query(
      `UPDATE shifts SET status = 'CLOSED', closed_by = $1, closed_at = now(),
              expected_cash_cents = $2, counted_cash_cents = $3, note = $4
       WHERE id = $5`,
      [user.id, toCents(live.expected_cash), toCents(countedCash), note ?? null, sh.id],
    );
    const closed = (await row<ShiftRow>(tx, `${SHIFT_SELECT} WHERE sh.id = $1`, [sh.id]))!;
    return buildReport(tx, closed);
  });
}
