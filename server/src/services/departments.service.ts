import { getPool, row, rows } from '../db';
import type { Queryable } from '../db';
import { conflict, notFound } from '../lib/errors';
import { fromCents } from '../lib/money';
import type { DepartmentCreate, DepartmentUpdate } from '../schemas';
import type { Department, DepartmentRow } from '../types';

function serialize(r: DepartmentRow): Department {
  const { inventory_value_cents, ...rest } = r;
  return {
    ...rest,
    ...(inventory_value_cents !== undefined ? { inventory_value: fromCents(inventory_value_cents) } : {}),
  };
}

export async function listDepartments(db: Queryable = getPool()): Promise<Department[]> {
  const list = await rows<DepartmentRow>(
    db,
    `SELECT d.*,
            COUNT(p.id) AS product_count,
            COALESCE(SUM(p.stock_quantity), 0) AS total_stock,
            COALESCE(SUM(p.stock_quantity * p.price_cents), 0) AS inventory_value_cents
     FROM departments d
     LEFT JOIN products p ON p.department_id = d.id
     GROUP BY d.id
     ORDER BY d.name ASC`,
  );
  return list.map(serialize);
}

export async function getDepartment(id: number, db: Queryable = getPool()): Promise<Department> {
  const r = await row<DepartmentRow>(db, 'SELECT * FROM departments WHERE id = $1', [id]);
  if (!r) throw notFound(`Department ${id} not found`);
  return serialize(r);
}

export async function createDepartment(input: DepartmentCreate): Promise<Department> {
  const created = await row<DepartmentRow>(
    getPool(),
    'INSERT INTO departments (name, code, description, color) VALUES ($1, $2, $3, $4) RETURNING *',
    [input.name, input.code, input.description ?? null, input.color ?? '#4f46e5'],
  );
  return serialize(created!);
}

export async function updateDepartment(id: number, input: DepartmentUpdate): Promise<Department> {
  const db = getPool();
  await getDepartment(id, db);

  const sets: string[] = [];
  const params: unknown[] = [];
  const assign = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.name !== undefined) assign('name', input.name);
  if (input.code !== undefined) assign('code', input.code);
  if (input.description !== undefined) assign('description', input.description);
  if (input.color !== undefined) assign('color', input.color);

  if (sets.length > 0) {
    params.push(id);
    await db.query(`UPDATE departments SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }
  return getDepartment(id, db);
}

export async function deleteDepartment(id: number): Promise<void> {
  const db = getPool();
  await getDepartment(id, db);
  const { count } = (await row<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM products WHERE department_id = $1', [
    id,
  ]))!;
  if (count > 0) {
    throw conflict(
      'IN_USE',
      `Cannot delete a department with ${count} product(s). Move or delete the products first.`,
      { product_count: count },
    );
  }
  await db.query('DELETE FROM departments WHERE id = $1', [id]);
}
