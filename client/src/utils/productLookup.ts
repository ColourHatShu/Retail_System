import { Department } from '../types';

export interface ProductLookupResult {
  found: boolean;
  name?: string;
  brand?: string;
  departmentId?: number;
  departmentName?: string;
  unit?: string;
  sku?: string;
  suggestedPrice?: number;
  source?: string;
}

/**
 * Matches a list of category tags and product name keywords to an existing store department
 */
function matchDepartment(
  textToMatch: string,
  departments: Department[]
): { id: number; name: string } | undefined {
  if (!departments || departments.length === 0) return undefined;

  const lower = textToMatch.toLowerCase();

  const rules: Array<{ keywords: string[]; deptCodes: string[] }> = [
    {
      keywords: [
        'beverage',
        'drink',
        'water',
        'mineral water',
        'spring water',
        'soda',
        'cola',
        'juice',
        'tea',
        'coffee',
        'beer',
        'wine',
        'energy drink',
        'liquid',
        'bottled water',
      ],
      deptCodes: ['BEV', 'BEVERAGES', 'DRINKS'],
    },
    {
      keywords: [
        'snack',
        'bakery',
        'bread',
        'biscuit',
        'cookie',
        'chip',
        'crisp',
        'cracker',
        'cake',
        'chocolate',
        'candy',
        'wafer',
        'pastry',
      ],
      deptCodes: ['BAKE', 'SNACK', 'BAKERY'],
    },
    {
      keywords: [
        'dairy',
        'milk',
        'cheese',
        'butter',
        'yogurt',
        'cream',
        'frozen',
        'ice cream',
        'ice-cream',
        'curd',
      ],
      deptCodes: ['DAIRY', 'FROZEN'],
    },
    {
      keywords: [
        'shampoo',
        'soap',
        'personal care',
        'beauty',
        'cosmetic',
        'toothpaste',
        'lotion',
        'hygiene',
        'deodorant',
        'skin',
        'hair',
      ],
      deptCodes: ['CARE', 'BEAUTY', 'PERSONAL'],
    },
    {
      keywords: [
        'electronic',
        'tech',
        'cable',
        'battery',
        'charger',
        'adapter',
        'usb',
        'phone',
        'headphone',
        'earphone',
      ],
      deptCodes: ['ELEC', 'TECH'],
    },
    {
      keywords: [
        'grocery',
        'pantry',
        'flour',
        'rice',
        'spice',
        'sauce',
        'oil',
        'pasta',
        'canned',
        'cereal',
        'noodle',
      ],
      deptCodes: ['GROC', 'PANTRY', 'GROCERY'],
    },
  ];

  for (const rule of rules) {
    if (rule.keywords.some((k) => lower.includes(k))) {
      const match = departments.find(
        (d) =>
          rule.deptCodes.some((code) => d.code.toUpperCase().includes(code)) ||
          rule.keywords.some((k) => d.name.toLowerCase().includes(k))
      );
      if (match) return { id: match.id, name: match.name };
    }
  }

  // Fallback to Grocery or first department
  const fallback =
    departments.find((d) => d.code.toUpperCase().includes('GROC')) || departments[0];
  return fallback ? { id: fallback.id, name: fallback.name } : undefined;
}

/**
 * Infers appropriate retail selling unit from product details
 */
function inferUnit(textToMatch: string): string {
  const lower = textToMatch.toLowerCase();
  if (lower.includes('bottle') || lower.includes(' fl oz') || lower.includes('ml') || lower.includes('liter') || lower.includes('litre')) {
    return 'bottle';
  }
  if (lower.includes('can') || lower.includes('tin')) {
    return 'can';
  }
  if (lower.includes('pack') || lower.includes('box') || lower.includes('bag') || lower.includes('pouch')) {
    return 'pack';
  }
  if (lower.includes('kg') || lower.includes('g') || lower.includes('gram')) {
    return 'pack';
  }
  return 'pcs';
}

/**
 * Automatically looks up barcode details across global online retail registries
 */
export async function lookupBarcodeOnline(
  barcode: string,
  departments: Department[] = []
): Promise<ProductLookupResult> {
  const clean = barcode.trim();
  if (!clean || clean.length < 6) {
    return { found: false };
  }

  // 1. Primary Query: Open Food Facts API (Tens of millions of global retail beverages, foods, snacks)
  try {
    const offRes = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json`
    );
    if (offRes.ok) {
      const data = await offRes.json();
      if (data.status === 1 && data.product) {
        const p = data.product;
        const brand = p.brands ? p.brands.split(',')[0].trim() : '';
        const rawName = p.product_name || p.product_name_en || p.generic_name || '';
        const quantity = p.quantity ? ` ${p.quantity}` : '';

        // Formulate clean title without duplicate brand name
        let fullName = rawName;
        if (brand && !rawName.toLowerCase().includes(brand.toLowerCase())) {
          fullName = `${brand} ${rawName}`;
        }
        if (quantity && !fullName.includes(p.quantity)) {
          fullName = `${fullName}${quantity}`;
        }

        const categoryText = [
          ...(p.categories_tags || []),
          p.categories || '',
          fullName,
        ].join(' ');

        const matchedDept = matchDepartment(categoryText, departments);
        const unit = inferUnit(`${categoryText} ${quantity}`);
        const lastDigits = clean.replace(/\D/g, '').slice(-4) || '101';
        const deptCode = departments.find((d) => d.id === matchedDept?.id)?.code || 'ITEM';
        const sku = `${deptCode}-${lastDigits}`;

        return {
          found: true,
          name: fullName.trim(),
          brand,
          departmentId: matchedDept?.id,
          departmentName: matchedDept?.name,
          unit,
          sku,
          source: 'Open Food Facts',
        };
      }
    }
  } catch (err) {
    console.warn('OpenFoodFacts lookup failed:', err);
  }

  // 2. Secondary Query: Open Beauty Facts (Cosmetics, Shampoos, Personal Care)
  try {
    const obfRes = await fetch(
      `https://world.openbeautyfacts.org/api/v0/product/${encodeURIComponent(clean)}.json`
    );
    if (obfRes.ok) {
      const data = await obfRes.json();
      if (data.status === 1 && data.product) {
        const p = data.product;
        const brand = p.brands ? p.brands.split(',')[0].trim() : '';
        const rawName = p.product_name || p.product_name_en || '';
        const fullName = brand && !rawName.toLowerCase().includes(brand.toLowerCase())
          ? `${brand} ${rawName}`
          : rawName;

        const careDept = departments.find(
          (d) => d.code.toUpperCase().includes('CARE') || d.name.toLowerCase().includes('care')
        );
        const lastDigits = clean.replace(/\D/g, '').slice(-4) || '101';
        const sku = `${careDept?.code || 'CARE'}-${lastDigits}`;

        return {
          found: true,
          name: fullName.trim(),
          brand,
          departmentId: careDept?.id,
          departmentName: careDept?.name,
          unit: 'bottle',
          sku,
          source: 'Open Beauty Facts',
        };
      }
    }
  } catch (err) {
    console.warn('OpenBeautyFacts lookup failed:', err);
  }

  // 3. Tertiary Query: UPC Item DB (General retail, electronics, household goods)
  try {
    const upcRes = await fetch(
      `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(clean)}`
    );
    if (upcRes.ok) {
      const data = await upcRes.json();
      if (data.code === 'OK' && data.items && data.items.length > 0) {
        const item = data.items[0];
        const title = item.title || item.description || '';
        const categoryText = `${item.category || ''} ${title}`;
        const matchedDept = matchDepartment(categoryText, departments);
        const unit = inferUnit(categoryText);
        const lastDigits = clean.replace(/\D/g, '').slice(-4) || '101';
        const deptCode = departments.find((d) => d.id === matchedDept?.id)?.code || 'ITEM';
        const sku = `${deptCode}-${lastDigits}`;
        const suggestedPrice = item.lowest_recorded_price > 0 ? item.lowest_recorded_price : undefined;

        return {
          found: true,
          name: title.trim(),
          brand: item.brand,
          departmentId: matchedDept?.id,
          departmentName: matchedDept?.name,
          unit,
          sku,
          suggestedPrice,
          source: 'UPC Item DB',
        };
      }
    }
  } catch (err) {
    console.warn('UPCItemDB lookup failed:', err);
  }

  // Fallback: If not found in online registries, generate clean SKU and suggested default
  const defaultDept = departments[0];
  const lastDigits = clean.replace(/\D/g, '').slice(-4) || Math.floor(100 + Math.random() * 900).toString();
  const sku = `${defaultDept?.code || 'GEN'}-${lastDigits}`;

  return {
    found: false,
    departmentId: defaultDept?.id,
    sku,
    unit: 'pcs',
  };
}
