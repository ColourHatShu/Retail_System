import { createClient } from '@supabase/supabase-js';
import { Department, Product, StockMovement, Sale } from '../types';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = (): boolean => {
  return !!(supabaseUrl && supabaseAnonKey && supabaseUrl.startsWith('http'));
};

export const supabase = isSupabaseConfigured()
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export const supabaseApi = {
  // Departments
  async getDepartments(): Promise<Department[]> {
    if (!supabase) throw new Error('Supabase not configured');
    const { data: depts, error: deptErr } = await supabase
      .from('departments')
      .select('*')
      .order('name', { ascending: true });

    if (deptErr) throw deptErr;

    // Get counts and values
    const { data: prods, error: prodErr } = await supabase
      .from('products')
      .select('department_id, stock_quantity, price');

    if (prodErr) throw prodErr;

    const statsMap: Record<number, { count: number; stock: number; value: number }> = {};
    (prods || []).forEach((p) => {
      if (!statsMap[p.department_id]) {
        statsMap[p.department_id] = { count: 0, stock: 0, value: 0 };
      }
      statsMap[p.department_id].count += 1;
      statsMap[p.department_id].stock += p.stock_quantity;
      statsMap[p.department_id].value += p.stock_quantity * Number(p.price);
    });

    return (depts || []).map((d) => ({
      ...d,
      product_count: statsMap[d.id]?.count || 0,
      total_stock: statsMap[d.id]?.stock || 0,
      inventory_value: statsMap[d.id]?.value || 0,
    }));
  },

  async createDepartment(data: Partial<Department>): Promise<Department> {
    if (!supabase) throw new Error('Supabase not configured');
    const { data: created, error } = await supabase
      .from('departments')
      .insert([
        {
          name: data.name?.trim(),
          code: data.code?.trim().toUpperCase(),
          description: data.description?.trim(),
          color: data.color || '#4f46e5',
        },
      ])
      .select()
      .single();

    if (error) throw error;
    return created;
  },

  async updateDepartment(id: number, data: Partial<Department>): Promise<Department> {
    if (!supabase) throw new Error('Supabase not configured');
    const { data: updated, error } = await supabase
      .from('departments')
      .update({
        name: data.name?.trim(),
        code: data.code?.trim().toUpperCase(),
        description: data.description?.trim(),
        color: data.color,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return updated;
  },

  async deleteDepartment(id: number): Promise<{ message: string }> {
    if (!supabase) throw new Error('Supabase not configured');
    const { count } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('department_id', id);

    if (count && count > 0) {
      throw new Error(`Cannot delete department with ${count} active products.`);
    }

    const { error } = await supabase.from('departments').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Department deleted' };
  },

  // Products
  async getProducts(params?: {
    department_id?: number | string;
    search?: string;
    low_stock?: boolean;
  }): Promise<Product[]> {
    if (!supabase) throw new Error('Supabase not configured');
    let query = supabase
      .from('products')
      .select('*, departments(name, code, color)')
      .order('name', { ascending: true });

    if (params?.department_id && params.department_id !== 'ALL') {
      query = query.eq('department_id', params.department_id);
    }
    if (params?.search) {
      query = query.or(
        `name.ilike.%${params.search}%,barcode.ilike.%${params.search}%,sku.ilike.%${params.search}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    let items = (data || []).map((p: any) => ({
      ...p,
      price: Number(p.price),
      cost_price: Number(p.cost_price || 0),
      department_name: p.departments?.name,
      department_code: p.departments?.code,
      department_color: p.departments?.color,
    }));

    if (params?.low_stock) {
      items = items.filter((p) => p.stock_quantity <= p.min_stock_level);
    }

    return items;
  },

  async getProductByBarcode(barcode: string): Promise<Product> {
    if (!supabase) throw new Error('Supabase not configured');
    const { data, error } = await supabase
      .from('products')
      .select('*, departments(name, code, color)')
      .eq('barcode', barcode.trim())
      .single();

    if (error || !data) throw new Error(`Product with barcode ${barcode} not found`);

    return {
      ...data,
      price: Number(data.price),
      cost_price: Number(data.cost_price || 0),
      department_name: data.departments?.name,
      department_code: data.departments?.code,
      department_color: data.departments?.color,
    };
  },

  async createProduct(data: Partial<Product>): Promise<Product> {
    if (!supabase) throw new Error('Supabase not configured');
    const { data: newProd, error } = await supabase
      .from('products')
      .insert([
        {
          barcode: data.barcode?.trim(),
          sku: data.sku?.trim() || null,
          name: data.name?.trim(),
          department_id: Number(data.department_id),
          price: Number(data.price),
          cost_price: Number(data.cost_price || 0),
          stock_quantity: Number(data.stock_quantity || 0),
          min_stock_level: Number(data.min_stock_level || 5),
          unit: data.unit?.trim() || 'pcs',
        },
      ])
      .select('*, departments(name, code, color)')
      .single();

    if (error) throw error;

    // Log initial stock movement
    if (newProd.stock_quantity > 0) {
      await supabase.from('stock_movements').insert([
        {
          product_id: newProd.id,
          type: 'INITIAL',
          quantity_change: newProd.stock_quantity,
          quantity_before: 0,
          quantity_after: newProd.stock_quantity,
          reference_id: 'INIT-CREATE',
          reason: 'Initial stock on product creation',
        },
      ]);
    }

    return {
      ...newProd,
      price: Number(newProd.price),
      department_name: newProd.departments?.name,
      department_code: newProd.departments?.code,
      department_color: newProd.departments?.color,
    };
  },

  async updateProduct(id: number, data: Partial<Product>): Promise<Product> {
    if (!supabase) throw new Error('Supabase not configured');
    const updateObj: any = { updated_at: new Date().toISOString() };
    if (data.barcode !== undefined) updateObj.barcode = data.barcode.trim();
    if (data.sku !== undefined) updateObj.sku = data.sku ? data.sku.trim() : null;
    if (data.name !== undefined) updateObj.name = data.name.trim();
    if (data.department_id !== undefined) updateObj.department_id = Number(data.department_id);
    if (data.price !== undefined) updateObj.price = Number(data.price);
    if (data.cost_price !== undefined) updateObj.cost_price = Number(data.cost_price);
    if (data.min_stock_level !== undefined) updateObj.min_stock_level = Number(data.min_stock_level);
    if (data.unit !== undefined) updateObj.unit = data.unit.trim();

    const { data: updated, error } = await supabase
      .from('products')
      .update(updateObj)
      .eq('id', id)
      .select('*, departments(name, code, color)')
      .single();

    if (error) throw error;
    return {
      ...updated,
      price: Number(updated.price),
      department_name: updated.departments?.name,
      department_code: updated.departments?.code,
      department_color: updated.departments?.color,
    };
  },

  async deleteProduct(id: number): Promise<{ message: string }> {
    if (!supabase) throw new Error('Supabase not configured');
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) throw error;
    return { message: 'Product deleted' };
  },

  // Stock Adjustment via Barcode Scan
  async scanAdjustStock(params: {
    barcode: string;
    change_quantity: number;
    type: 'RESTOCK' | 'ADJUSTMENT_ADD' | 'ADJUSTMENT_REMOVE' | 'RETURN';
    reason?: string;
    reference_id?: string;
  }): Promise<{ product: Product; movement: StockMovement }> {
    if (!supabase) throw new Error('Supabase not configured');
    const prod = await this.getProductByBarcode(params.barcode);
    const qtyChange = Number(params.change_quantity);
    const delta = params.type === 'ADJUSTMENT_REMOVE' ? -Math.abs(qtyChange) : Math.abs(qtyChange);

    const qtyBefore = prod.stock_quantity;
    const qtyAfter = qtyBefore + delta;
    if (qtyAfter < 0) {
      throw new Error(`Cannot reduce stock below 0. Current stock is ${qtyBefore}.`);
    }

    const { data: updatedProd, error: updErr } = await supabase
      .from('products')
      .update({ stock_quantity: qtyAfter, updated_at: new Date().toISOString() })
      .eq('id', prod.id)
      .select('*, departments(name, code, color)')
      .single();

    if (updErr) throw updErr;

    const defaultReason =
      params.type === 'RESTOCK'
        ? 'Restock shipment received'
        : params.type === 'ADJUSTMENT_REMOVE'
        ? params.reason || 'Inventory reduction'
        : params.reason || 'Stock adjustment';

    const { data: movement, error: movErr } = await supabase
      .from('stock_movements')
      .insert([
        {
          product_id: prod.id,
          type: params.type,
          quantity_change: delta,
          quantity_before: qtyBefore,
          quantity_after: qtyAfter,
          reference_id: params.reference_id || (params.type === 'RESTOCK' ? 'SCAN-IN' : 'SCAN-OUT'),
          reason: defaultReason,
        },
      ])
      .select()
      .single();

    if (movErr) throw movErr;

    return {
      product: {
        ...updatedProd,
        price: Number(updatedProd.price),
        department_name: updatedProd.departments?.name,
        department_code: updatedProd.departments?.code,
        department_color: updatedProd.departments?.color,
      },
      movement,
    };
  },

  async setPhysicalCount(data: {
    barcode: string;
    actual_count: number;
    reason?: string;
  }): Promise<{ product: Product; movement: StockMovement | null }> {
    const prod = await this.getProductByBarcode(data.barcode);
    const delta = data.actual_count - prod.stock_quantity;
    if (delta === 0) return { product: prod, movement: null };

    return this.scanAdjustStock({
      barcode: data.barcode,
      change_quantity: Math.abs(delta),
      type: delta > 0 ? 'ADJUSTMENT_ADD' : 'ADJUSTMENT_REMOVE',
      reason: data.reason || 'Physical cycle count adjustment',
      reference_id: 'STOCK-AUDIT',
    });
  },

  // POS Checkout (Atomic via Supabase RPC)
  async checkout(order: {
    items: Array<{
      product_id: number;
      barcode?: string;
      quantity: number;
      unit_price: number;
    }>;
    subtotal: number;
    tax_rate?: number;
    tax_amount?: number;
    discount?: number;
    total: number;
    payment_method: 'CASH' | 'CARD' | 'UPI_QR' | 'SPLIT';
    amount_paid: number;
    customer_name?: string;
    customer_phone?: string;
  }): Promise<Sale> {
    if (!supabase) throw new Error('Supabase not configured');

    const { data: result, error } = await supabase.rpc('process_pos_checkout', {
      p_items: order.items,
      p_subtotal: order.subtotal,
      p_tax_rate: order.tax_rate || 0,
      p_tax_amount: order.tax_amount || 0,
      p_discount: order.discount || 0,
      p_total: order.total,
      p_payment_method: order.payment_method,
      p_amount_paid: order.amount_paid,
      p_change_due: Math.max(0, order.amount_paid - order.total),
      p_customer_name: order.customer_name || 'Walk-in Customer',
      p_customer_phone: order.customer_phone || null,
    });

    if (error) throw error;
    return result as Sale;
  },

  async getSales(limit = 50, offset = 0): Promise<Sale[]> {
    if (!supabase) throw new Error('Supabase not configured');
    const { data, error } = await supabase
      .from('sales')
      .select('*, sale_items(*)')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return (data || []).map((s: any) => ({
      ...s,
      total: Number(s.total),
      subtotal: Number(s.subtotal),
      tax_amount: Number(s.tax_amount || 0),
      amount_paid: Number(s.amount_paid),
      change_due: Number(s.change_due || 0),
      item_count: s.sale_items?.length || 1,
      items: (s.sale_items || []).map((i: any) => ({
        product_id: i.product_id,
        name: i.product_name,
        barcode: i.barcode,
        quantity: i.quantity,
        unit_price: Number(i.unit_price),
        total_price: Number(i.total_price),
      })),
    }));
  },

  // Movements Audit Ledger
  async getMovements(params?: {
    product_id?: number | string;
    department_id?: number | string;
    type?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<StockMovement[]> {
    if (!supabase) throw new Error('Supabase not configured');
    let query = supabase
      .from('stock_movements')
      .select('*, products(name, barcode, sku, unit, price, department_id, departments(name, code, color))')
      .order('created_at', { ascending: false });

    if (params?.product_id) query = query.eq('product_id', params.product_id);
    if (params?.type && params.type !== 'ALL') query = query.eq('type', params.type);

    const limit = params?.limit || 100;
    const offset = params?.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) throw error;

    let results = (data || []).map((m: any) => ({
      ...m,
      product_name: m.products?.name,
      product_barcode: m.products?.barcode,
      product_sku: m.products?.sku,
      product_unit: m.products?.unit,
      product_price: Number(m.products?.price || 0),
      department_name: m.products?.departments?.name,
      department_code: m.products?.departments?.code,
      department_color: m.products?.departments?.color,
      department_id: m.products?.department_id,
    }));

    if (params?.department_id && params.department_id !== 'ALL') {
      results = results.filter((r) => String(r.department_id) === String(params.department_id));
    }

    if (params?.search) {
      const q = params.search.toLowerCase();
      results = results.filter(
        (r) =>
          r.product_name?.toLowerCase().includes(q) ||
          r.product_barcode?.toLowerCase().includes(q) ||
          r.customer_name?.toLowerCase().includes(q) ||
          r.reference_id?.toLowerCase().includes(q) ||
          r.reason?.toLowerCase().includes(q)
      );
    }

    return results;
  },

  async getMovementSummary(): Promise<{
    total_movements: number;
    total_sold_units: number;
    total_restocked_units: number;
    total_adjusted_units: number;
  }> {
    if (!supabase) throw new Error('Supabase not configured');
    const { data: movements, error } = await supabase
      .from('stock_movements')
      .select('type, quantity_change');

    if (error) throw error;

    let totalSold = 0;
    let totalRestocked = 0;
    let totalAdjusted = 0;

    (movements || []).forEach((m) => {
      if (m.type === 'SALE') totalSold += Math.abs(m.quantity_change);
      else if (m.type === 'RESTOCK') totalRestocked += m.quantity_change;
      else if (m.type.startsWith('ADJUSTMENT')) totalAdjusted += Math.abs(m.quantity_change);
    });

    return {
      total_movements: movements?.length || 0,
      total_sold_units: totalSold,
      total_restocked_units: totalRestocked,
      total_adjusted_units: totalAdjusted,
    };
  },

  // Excel Batch Import with Auto-Department Addition
  async importProductsBatch(items: any[]): Promise<{
    inserted_count: number;
    updated_count: number;
    created_departments: Department[];
    total_processed: number;
  }> {
    if (!supabase) throw new Error('Supabase not configured');

    const PRESET_COLORS = ['#0ea5e9', '#10b981', '#6366f1', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e'];
    const { data: existingDepts } = await supabase.from('departments').select('*');
    const deptMapByName = new Map<string, any>();
    const existingCodes = new Set<string>();

    (existingDepts || []).forEach((d) => {
      deptMapByName.set(d.name.trim().toLowerCase(), d);
      existingCodes.add(d.code.toUpperCase());
    });

    const createdDepartments: Department[] = [];
    let insertedCount = 0;
    let updatedCount = 0;

    for (const item of items) {
      if (!item.name || !item.barcode) continue;

      const cleanDeptName = String(item.department || 'General').trim();
      let dept = deptMapByName.get(cleanDeptName.toLowerCase());

      if (!dept) {
        let baseCode = cleanDeptName.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase();
        if (baseCode.length < 2) baseCode = 'DEPT';
        let finalCode = baseCode;
        let counter = 1;
        while (existingCodes.has(finalCode)) {
          finalCode = `${baseCode.substring(0, 3)}${counter++}`;
        }
        existingCodes.add(finalCode);

        const randomColor = PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
        const { data: newDept, error: deptErr } = await supabase
          .from('departments')
          .insert([
            {
              name: cleanDeptName,
              code: finalCode,
              description: 'Auto-created from Excel import',
              color: randomColor,
            },
          ])
          .select()
          .single();

        if (deptErr) throw deptErr;
        dept = newDept;
        deptMapByName.set(cleanDeptName.toLowerCase(), dept);
        createdDepartments.push(newDept);
      }

      const cleanBarcode = String(item.barcode).trim();
      const stockQty = parseInt(item.stock_quantity || item.stock, 10) || 0;

      const { data: existingProd } = await supabase
        .from('products')
        .select('*')
        .eq('barcode', cleanBarcode)
        .maybeSingle();

      if (existingProd) {
        const newStock = existingProd.stock_quantity + stockQty;
        await supabase
          .from('products')
          .update({
            name: String(item.name).trim(),
            department_id: dept.id,
            price: parseFloat(item.price) || 0,
            cost_price: parseFloat(item.cost_price || item.cost) || 0,
            stock_quantity: newStock,
            unit: String(item.unit || 'pcs').trim(),
            sku: item.sku ? String(item.sku).trim() : existingProd.sku,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingProd.id);

        if (stockQty > 0) {
          await supabase.from('stock_movements').insert([
            {
              product_id: existingProd.id,
              type: 'RESTOCK',
              quantity_change: stockQty,
              quantity_before: existingProd.stock_quantity,
              quantity_after: newStock,
              reference_id: 'EXCEL-IMPORT',
              reason: 'Restock imported from spreadsheet',
            },
          ]);
        }
        updatedCount++;
      } else {
        const { data: newProd, error: insErr } = await supabase
          .from('products')
          .insert([
            {
              barcode: cleanBarcode,
              sku: item.sku ? String(item.sku).trim() : null,
              name: String(item.name).trim(),
              department_id: dept.id,
              price: parseFloat(item.price) || 0,
              cost_price: parseFloat(item.cost_price || item.cost) || 0,
              stock_quantity: stockQty,
              min_stock_level: parseInt(item.min_stock_level, 10) || 5,
              unit: String(item.unit || 'pcs').trim(),
            },
          ])
          .select()
          .single();

        if (insErr) throw insErr;

        if (stockQty > 0) {
          await supabase.from('stock_movements').insert([
            {
              product_id: newProd.id,
              type: 'INITIAL',
              quantity_change: stockQty,
              quantity_before: 0,
              quantity_after: stockQty,
              reference_id: 'EXCEL-IMPORT',
              reason: 'Initial stock from spreadsheet import',
            },
          ]);
        }
        insertedCount++;
      }
    }

    return {
      inserted_count: insertedCount,
      updated_count: updatedCount,
      created_departments: createdDepartments,
      total_processed: insertedCount + updatedCount,
    };
  },
};
