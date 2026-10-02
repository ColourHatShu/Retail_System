import { currentDb, rows } from '../db';
import { fromCents } from '../lib/money';
import { getSettings } from './settings.service';

/**
 * Profit and movement for a date range. Revenue is before tax and after both
 * discounts and every return; cost uses the unit cost captured at the sale
 * (or the current cost for receipts older than that snapshot). Voided
 * receipts count for nothing.
 */

const LINES = `
  WITH lines AS (
    SELECT si.product_id, si.product_name, s.cashier_id, s.created_at, p.department_id,
           (si.quantity - COALESCE((SELECT SUM(ri.quantity) FROM return_items ri WHERE ri.sale_item_id = si.id), 0))
             AS net_qty,
           si.quantity,
           si.total_price_cents::numeric
             * CASE WHEN s.subtotal_cents > 0 THEN (s.subtotal_cents - s.discount_cents)::numeric / s.subtotal_cents ELSE 0 END
             AS line_net,
           COALESCE(si.cost_cents, p.cost_price_cents, 0) AS unit_cost
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    LEFT JOIN products p ON p.id = si.product_id
    WHERE s.status <> 'VOIDED' AND s.created_at >= $1 AND s.created_at < $2
  ),
  priced AS (
    SELECT *, CASE WHEN quantity > 0 THEN line_net * net_qty / quantity ELSE 0 END AS revenue,
           unit_cost * net_qty AS cost
    FROM lines
  )
`;

interface Agg {
  key: string;
  units: number;
  revenue: number;
  cost: number;
}

const toAgg = (r: { key: string | null; units: number; revenue: number; cost: number }) => ({
  name: r.key ?? 'Unknown',
  units: Number(r.units),
  revenue: fromCents(Math.round(Number(r.revenue))),
  cost: fromCents(Math.round(Number(r.cost))),
  profit: fromCents(Math.round(Number(r.revenue) - Number(r.cost))),
});

export async function salesReport(from: Date, to: Date) {
  const db = currentDb();
  const { timezone } = await getSettings(db);
  const args = [from, to];

  const totals = (
    await rows<Agg>(db, `${LINES} SELECT 'all' AS key, COALESCE(SUM(net_qty), 0) AS units,
                                 COALESCE(SUM(revenue), 0) AS revenue, COALESCE(SUM(cost), 0) AS cost FROM priced`, args)
  )[0];
  const products = await rows<Agg>(
    db,
    `${LINES} SELECT product_name AS key, SUM(net_qty) AS units, SUM(revenue) AS revenue, SUM(cost) AS cost
     FROM priced GROUP BY product_id, product_name HAVING SUM(net_qty) > 0
     ORDER BY SUM(revenue) DESC LIMIT 15`,
    args,
  );
  const departments = await rows<Agg>(
    db,
    `${LINES} SELECT d.name AS key, SUM(net_qty) AS units, SUM(revenue) AS revenue, SUM(cost) AS cost
     FROM priced LEFT JOIN departments d ON d.id = priced.department_id
     GROUP BY d.name ORDER BY SUM(revenue) DESC`,
    args,
  );
  const cashiers = await rows<Agg>(
    db,
    `${LINES} SELECT u.display_name AS key, SUM(net_qty) AS units, SUM(revenue) AS revenue, SUM(cost) AS cost
     FROM priced LEFT JOIN users u ON u.id = priced.cashier_id
     GROUP BY u.display_name ORDER BY SUM(revenue) DESC`,
    args,
  );
  const hours = await rows<Agg>(
    db,
    `${LINES} SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $3)::int::text AS key, SUM(net_qty) AS units,
            SUM(revenue) AS revenue, SUM(cost) AS cost
     FROM priced GROUP BY 1`,
    [...args, timezone],
  );
  hours.sort((a, b) => Number(a.key) - Number(b.key));
  // Stocked items that did not sell at all in the range.
  const slow = await rows<{ name: string; stock_quantity: number; stock_value_cents: number }>(
    db,
    `SELECT p.name, p.stock_quantity, p.stock_quantity * p.cost_price_cents AS stock_value_cents
     FROM products p
     WHERE p.is_active AND p.stock_quantity > 0
       AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                       WHERE si.product_id = p.id AND s.created_at >= $1 AND s.created_at < $2)
     ORDER BY p.stock_quantity * p.cost_price_cents DESC LIMIT 15`,
    args,
  );

  const t = toAgg(totals);
  return {
    totals: { ...t, margin_percent: t.revenue > 0 ? Math.round((t.profit / t.revenue) * 1000) / 10 : 0 },
    top_products: products.map(toAgg),
    departments: departments.map(toAgg),
    cashiers: cashiers.map(toAgg),
    hours: hours.map((h) => ({ ...toAgg(h), hour: Number(h.key) })),
    slow_movers: slow.map((s) => ({
      name: s.name,
      stock_quantity: s.stock_quantity,
      stock_value: fromCents(Number(s.stock_value_cents)),
    })),
  };
}
