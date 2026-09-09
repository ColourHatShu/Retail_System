import { Router } from 'express';
import { MANAGER_UP, requireRole } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as departments from '../services/departments.service';

/** Mounted behind requireAuth. Reads: any role. Writes: manager or owner. */
export const departmentRouter = Router();

departmentRouter.get('/', async (_req, res) => {
  res.json({ success: true, data: await departments.listDepartments() });
});

departmentRouter.get('/:id', validate({ params: s.idParam }), async (_req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({ success: true, data: await departments.getDepartment(id) });
});

departmentRouter.post('/', requireRole(...MANAGER_UP), validate({ body: s.departmentCreate }), async (_req, res) => {
  res
    .status(201)
    .json({ success: true, data: await departments.createDepartment(input<s.DepartmentCreate>(res, 'body')) });
});

departmentRouter.put(
  '/:id',
  requireRole(...MANAGER_UP),
  validate({ params: s.idParam, body: s.departmentUpdate }),
  async (_req, res) => {
    const { id } = input<{ id: number }>(res, 'params');
    res.json({ success: true, data: await departments.updateDepartment(id, input<s.DepartmentUpdate>(res, 'body')) });
  },
);

departmentRouter.delete('/:id', requireRole(...MANAGER_UP), validate({ params: s.idParam }), async (_req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  await departments.deleteDepartment(id);
  res.json({ success: true, message: 'Department deleted successfully' });
});
