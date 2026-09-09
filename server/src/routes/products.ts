import { Router } from 'express';
import { MANAGER_UP, actor, requireRole } from '../lib/authz';
import { input, validate } from '../lib/validate';
import * as s from '../schemas';
import * as products from '../services/products.service';

/** Mounted behind requireAuth. Reads: any role. Writes: manager or owner. */
export const productRouter = Router();

productRouter.get('/', validate({ query: s.productListQuery }), async (_req, res) => {
  res.json({ success: true, data: await products.listProducts(input<s.ProductListQuery>(res, 'query')) });
});

// Primary lookup for scanners. Must be declared before '/:id'.
productRouter.get('/barcode/:barcode', validate({ params: s.barcodeParam }), async (_req, res) => {
  const { barcode } = input<{ barcode: string }>(res, 'params');
  res.json({ success: true, data: await products.getProductByBarcode(barcode) });
});

productRouter.get('/:id', validate({ params: s.idParam }), async (_req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  res.json({ success: true, data: await products.getProduct(id) });
});

productRouter.post('/', requireRole(...MANAGER_UP), validate({ body: s.productCreate }), async (_req, res) => {
  res
    .status(201)
    .json({ success: true, data: await products.createProduct(input<s.ProductCreate>(res, 'body'), actor(res)) });
});

productRouter.put(
  '/:id',
  requireRole(...MANAGER_UP),
  validate({ params: s.idParam, body: s.productUpdate }),
  async (_req, res) => {
    const { id } = input<{ id: number }>(res, 'params');
    res.json({ success: true, data: await products.updateProduct(id, input<s.ProductUpdate>(res, 'body')) });
  },
);

productRouter.delete('/:id', requireRole(...MANAGER_UP), validate({ params: s.idParam }), async (_req, res) => {
  const { id } = input<{ id: number }>(res, 'params');
  await products.deleteProduct(id);
  res.json({ success: true, message: 'Product deleted successfully' });
});
