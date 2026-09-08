import { Router, Request, Response } from 'express';
import { db } from '../db';

export const departmentRouter = Router();

// GET all departments with aggregated statistics
departmentRouter.get('/', (req: Request, res: Response) => {
  try {
    const departments = db.prepare(`
      SELECT 
        d.*,
        COUNT(p.id) as product_count,
        COALESCE(SUM(p.stock_quantity), 0) as total_stock,
        COALESCE(SUM(p.stock_quantity * p.price), 0) as inventory_value
      FROM departments d
      LEFT JOIN products p ON p.department_id = d.id
      GROUP BY d.id
      ORDER BY d.name ASC
    `).all();

    res.json({ success: true, data: departments });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET single department
departmentRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const department = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
    if (!department) {
      return res.status(404).json({ success: false, error: 'Department not found' });
    }
    res.json({ success: true, data: department });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST create department
departmentRouter.post('/', (req: Request, res: Response) => {
  try {
    const { name, code, description, color } = req.body;
    if (!name || !code) {
      return res.status(400).json({ success: false, error: 'Name and Code are required' });
    }

    const cleanCode = code.trim().toUpperCase();
    const cleanName = name.trim();

    const insert = db.prepare(`
      INSERT INTO departments (name, code, description, color)
      VALUES (?, ?, ?, ?)
    `);

    const result = insert.run(cleanName, cleanCode, description || null, color || '#4f46e5');
    const newDept = db.prepare('SELECT * FROM departments WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({ success: true, data: newDept });
  } catch (error: any) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ success: false, error: 'Department name or code already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT update department
departmentRouter.put('/:id', (req: Request, res: Response) => {
  try {
    const { name, code, description, color } = req.body;
    const { id } = req.params;

    const existing = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Department not found' });
    }

    const update = db.prepare(`
      UPDATE departments 
      SET name = COALESCE(?, name),
          code = COALESCE(?, code),
          description = COALESCE(?, description),
          color = COALESCE(?, color)
      WHERE id = ?
    `);

    update.run(
      name ? name.trim() : null,
      code ? code.trim().toUpperCase() : null,
      description !== undefined ? description : null,
      color !== undefined ? color : null,
      id
    );

    const updatedDept = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
    res.json({ success: true, data: updatedDept });
  } catch (error: any) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ success: false, error: 'Department name or code already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE department (only if no products)
departmentRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const count = db.prepare('SELECT COUNT(*) as count FROM products WHERE department_id = ?').get(id) as { count: number };
    if (count.count > 0) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete department with ${count.count} active product(s). Move or delete products first.`
      });
    }

    db.prepare('DELETE FROM departments WHERE id = ?').run(id);
    res.json({ success: true, message: 'Department deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
