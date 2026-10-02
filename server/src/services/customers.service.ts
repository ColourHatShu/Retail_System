import { currentDb, row, rows } from '../db';
import { conflict, notFound } from '../lib/errors';
import { fromCents } from '../lib/money';
import type { CustomerCreate, CustomerUpdate } from '../schemas';

export interface Customer {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  points: number;
  visits: number;
  total_spent: number;
  last_visit: string | null;
  created_at: string;
}

export interface CustomerDetail extends Customer {
  recent_sales: Array<{ id: number; receipt_number: string; total: number; status: string; created_at: string }>;
}

const SELECT = `
  SELECT c.*,
         (SELECT COUNT(*)::int FROM sales s WHERE s.customer_id = c.id AND s.status <> 'VOIDED') AS visits,
         (SELECT COALESCE(SUM(s.total_cents), 0) - COALESCE(SUM((SELECT COALESCE(SUM(r.refund_cents), 0)
                                                                FROM returns r WHERE r.sale_id = s.id)), 0)
            FROM sales s WHERE s.customer_id = c.id) AS spent_cents,
         (SELECT MAX(s.created_at) FROM sales s WHERE s.customer_id = c.id) AS last_visit
  FROM customers c
`;

type Row = Omit<Customer, 'total_spent'> & { spent_cents: number };

const serialize = ({ spent_cents, ...r }: Row): Customer => ({ ...r, total_spent: fromCents(spent_cents) });

/** Phone numbers are stored as digits only, so "(416) 555-0100" and "4165550100" match. */
const digits = (phone: string | null | undefined) => {
  if (phone === undefined) return undefined;
  const d = (phone ?? '').replace(/\D/g, '');
  return d === '' ? null : d;
};

function duplicate(err: unknown): never {
  if ((err as { code?: string }).code === '23505') {
    throw conflict('DUPLICATE_PHONE', 'Another customer already has that phone number');
  }
  throw err;
}

export async function searchCustomers(q: string | undefined, limit: number): Promise<Customer[]> {
  const term = (q ?? '').trim();
  if (!term) {
    return (await rows<Row>(currentDb(), `${SELECT} ORDER BY c.updated_at DESC LIMIT $1`, [limit])).map(serialize);
  }
  const phone = term.replace(/\D/g, '');
  const list = await rows<Row>(
    currentDb(),
    `${SELECT} WHERE c.name ILIKE $1 OR ($2 <> '' AND c.phone LIKE $3) ORDER BY c.name LIMIT $4`,
    [`%${term}%`, phone, `%${phone}%`, limit],
  );
  return list.map(serialize);
}

export async function getCustomer(id: number): Promise<CustomerDetail> {
  const r = await row<Row>(currentDb(), `${SELECT} WHERE c.id = $1`, [id]);
  if (!r) throw notFound('Customer not found');
  const recent = await rows<{ id: number; receipt_number: string; total_cents: number; status: string; created_at: string }>(
    currentDb(),
    `SELECT id, receipt_number, total_cents, status, created_at FROM sales
     WHERE customer_id = $1 ORDER BY id DESC LIMIT 20`,
    [id],
  );
  return {
    ...serialize(r),
    recent_sales: recent.map((s) => ({
      id: s.id,
      receipt_number: s.receipt_number,
      total: fromCents(s.total_cents),
      status: s.status,
      created_at: s.created_at,
    })),
  };
}

export async function createCustomer(input: CustomerCreate): Promise<CustomerDetail> {
  try {
    const created = (await row<{ id: number }>(
      currentDb(),
      'INSERT INTO customers (name, phone, email, notes) VALUES ($1, $2, $3, $4) RETURNING id',
      [input.name, digits(input.phone) ?? null, input.email ?? null, input.notes ?? null],
    ))!;
    return getCustomer(created.id);
  } catch (err) {
    duplicate(err);
  }
}

export async function updateCustomer(id: number, input: CustomerUpdate): Promise<CustomerDetail> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const assign = (col: string, v: unknown) => {
    values.push(v);
    sets.push(`${col} = $${values.length}`);
  };
  if (input.name !== undefined) assign('name', input.name);
  if (input.phone !== undefined) assign('phone', digits(input.phone));
  if (input.email !== undefined) assign('email', input.email);
  if (input.notes !== undefined) assign('notes', input.notes);
  if (input.points !== undefined) assign('points', input.points);
  if (sets.length > 0) {
    values.push(id);
    try {
      const done = await row(
        currentDb(),
        `UPDATE customers SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING id`,
        values,
      );
      if (!done) throw notFound('Customer not found');
    } catch (err) {
      duplicate(err);
    }
  }
  return getCustomer(id);
}
