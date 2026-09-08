import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDatabase } from './db';
import { departmentRouter } from './routes/departments';
import { productRouter } from './routes/products';
import { inventoryRouter } from './routes/inventory';
import { salesRouter } from './routes/sales';
import { movementRouter } from './routes/movements';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Initialize SQLite Database schema & initial data
initDatabase();

// Mount API routes
app.use('/api/departments', departmentRouter);
app.use('/api/products', productRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/sales', salesRouter);
app.use('/api/movements', movementRouter);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    system: 'Retail POS & Inventory System',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`[Retail POS Server] running on http://localhost:${PORT}`);
});
