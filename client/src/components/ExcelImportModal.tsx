import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  UploadCloud,
  FileSpreadsheet,
  Download,
  CheckCircle2,
  AlertCircle,
  X,
  Plus,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { Department } from '../types';
import { api } from '../utils/api';
import { playScanSuccessSound, playPaymentSuccessSound } from '../utils/audio';

interface ExcelImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  departments: Department[];
  onImportComplete: () => Promise<void>;
}

interface ParsedRow {
  name: string;
  barcode: string;
  department: string;
  price: number;
  cost_price?: number;
  stock_quantity?: number;
  min_stock_level?: number;
  unit?: string;
  sku?: string;
  isNewDepartment?: boolean;
}

export const ExcelImportModal: React.FC<ExcelImportModalProps> = ({
  isOpen,
  onClose,
  departments,
  onImportComplete,
}) => {
  const [parsedItems, setParsedItems] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [newDepartmentsDetected, setNewDepartmentsDetected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    inserted_count: number;
    updated_count: number;
    created_departments: Department[];
    skipped?: Array<{ row: number; reason: string }>;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  if (!isOpen) return null;

  const existingDeptNames = new Set(
    departments.map((d) => d.name.trim().toLowerCase())
  );

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setImportResult(null);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const workbook = XLSX.read(bstr, { type: 'binary' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const rawJson: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

        if (rawJson.length === 0) {
          setError('Spreadsheet is empty or could not be parsed.');
          return;
        }

        const detectedNewDepts = new Set<string>();
        const mappedRows: ParsedRow[] = [];

        rawJson.forEach((row) => {
          // Normalize column keys
          const keys = Object.keys(row);
          const getKey = (patterns: string[]) => {
            const found = keys.find((k) =>
              patterns.some((p) => k.toLowerCase().trim().replace(/[^a-z]/g, '') === p)
            );
            return found ? row[found] : '';
          };

          const name = String(getKey(['name', 'productname', 'itemname', 'item', 'title'])).trim();
          const barcode = String(getKey(['barcode', 'upc', 'ean', 'code', 'sku'])).trim();
          const department = String(getKey(['department', 'dept', 'category', 'group']) || 'General').trim();
          const price = parseFloat(getKey(['price', 'retailprice', 'sellingprice', 'unitprice'])) || 0;
          const cost_price = parseFloat(getKey(['cost', 'costprice', 'buyprice'])) || 0;
          const stock_quantity = parseInt(getKey(['stock', 'quantity', 'stockquantity', 'qty', 'initialstock']), 10) || 0;
          const min_stock_level = parseInt(getKey(['minstock', 'lowstock', 'alertlevel', 'minimum']), 10) || 5;
          const unit = String(getKey(['unit', 'uom', 'measurement']) || 'pcs').trim();
          const sku = String(getKey(['sku', 'itemcode'])).trim();

          if (name && barcode) {
            const isNewDept = !existingDeptNames.has(department.toLowerCase());
            if (isNewDept) {
              detectedNewDepts.add(department);
            }

            mappedRows.push({
              name,
              barcode,
              department,
              price,
              cost_price,
              stock_quantity,
              min_stock_level,
              unit,
              sku,
              isNewDepartment: isNewDept,
            });
          }
        });

        if (mappedRows.length === 0) {
          setError('Could not find valid product rows with Name and Barcode columns.');
          return;
        }

        setParsedItems(mappedRows);
        setNewDepartmentsDetected(Array.from(detectedNewDepts));
        playScanSuccessSound();
      } catch (err: any) {
        setError('Failed to read Excel file: ' + err.message);
      }
    };
    reader.readAsBinaryString(file);
  };

  const downloadTemplate = () => {
    const templateData = [
      {
        'Product Name': 'Gourmet Cold Brew Coffee 330ml',
        'Barcode': '8901234567950',
        'Department': 'Artisan Beverages',
        'Price': 3.99,
        'Cost Price': 1.80,
        'Stock Quantity': 30,
        'Min Stock Alert': 8,
        'Unit': 'bottle',
        'SKU': 'ART-BEV-01',
      },
      {
        'Product Name': 'Organic Gluten-Free Granola 500g',
        'Barcode': '8901234567951',
        'Department': 'Healthy Breakfast',
        'Price': 7.49,
        'Cost Price': 4.10,
        'Stock Quantity': 20,
        'Min Stock Alert': 5,
        'Unit': 'pack',
        'SKU': 'HLTH-BRK-01',
      },
      {
        'Product Name': 'Raw Unpasteurized Honey 250g',
        'Barcode': '8901234567952',
        'Department': 'Grocery & Pantry',
        'Price': 8.99,
        'Cost Price': 5.00,
        'Stock Quantity': 15,
        'Min Stock Alert': 4,
        'Unit': 'jar',
        'SKU': 'GROC-HNY-01',
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(templateData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Inventory Template');
    XLSX.writeFile(workbook, 'Nexus_POS_Inventory_Import_Template.xlsx');
  };

  const handleExecuteImport = async () => {
    if (parsedItems.length === 0) return;
    try {
      setLoading(true);
      setError(null);

      const result = await api.importProductsBatch(parsedItems);
      setImportResult(result);
      playPaymentSuccessSound();
      await onImportComplete();
    } catch (err: any) {
      setError(err.message || 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-zinc-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
          <div>
            <h3 className="text-base font-bold text-zinc-950 flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
              Import Inventory via Excel / CSV
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Bulk import items • Departments are automatically created if they don't exist
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5">
          {error && (
            <div className="p-3 text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Success Result View */}
          {importResult ? (
            <div className="p-6 bg-emerald-50 rounded-2xl border border-emerald-200 text-center space-y-3">
              <div className="w-12 h-12 bg-emerald-600 text-white rounded-full flex items-center justify-center mx-auto shadow-sm">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h4 className="text-base font-bold text-emerald-950">
                Import Successfully Completed!
              </h4>
              <p className="text-xs text-emerald-800">
                <strong>{importResult.inserted_count}</strong> new items added,{' '}
                <strong>{importResult.updated_count}</strong> existing items updated.
              </p>

              {importResult.created_departments.length > 0 && (
                <div className="bg-white/80 p-3 rounded-xl border border-emerald-200 text-left">
                  <span className="text-[10px] uppercase font-bold text-emerald-700 block mb-1">
                    Auto-Created Departments ({importResult.created_departments.length}):
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {importResult.created_departments.map((d, i) => (
                      <span
                        key={i}
                        className="text-xs font-semibold px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-900 border border-emerald-300"
                      >
                        {d.name} ({d.code})
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {importResult.skipped && importResult.skipped.length > 0 && (
                <div className="bg-amber-50 p-3 rounded-xl border border-amber-200 text-left">
                  <span className="text-[10px] uppercase font-bold text-amber-800 block mb-1">
                    Skipped Rows ({importResult.skipped.length}) — fix these in the sheet and re-import:
                  </span>
                  <ul className="text-xs text-amber-900 space-y-0.5 max-h-32 overflow-y-auto">
                    {importResult.skipped.map((s) => (
                      <li key={s.row}>
                        Row {s.row}: {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="pt-2">
                <button
                  onClick={onClose}
                  className="px-5 py-2.5 bg-zinc-900 text-white text-xs font-bold rounded-xl hover:bg-zinc-800"
                >
                  Done & View Inventory
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* File Upload Box */}
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-zinc-300 hover:border-zinc-900 rounded-2xl p-6 text-center cursor-pointer transition-colors bg-zinc-50/60 hover:bg-zinc-50"
              >
                <UploadCloud className="w-10 h-10 text-zinc-400 mx-auto mb-2" />
                <p className="text-xs font-bold text-zinc-900">
                  {fileName ? fileName : 'Click to browse or drop your Excel file here'}
                </p>
                <p className="text-[11px] text-zinc-500 mt-1">
                  Supports .xlsx, .xls, and .csv formats
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </div>

              {/* Template download helper button */}
              <div className="flex items-center justify-between p-3 bg-zinc-100 rounded-xl">
                <div className="text-xs text-zinc-600">
                  Need the standard format?
                </div>
                <button
                  type="button"
                  onClick={downloadTemplate}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-zinc-50 text-zinc-900 text-xs font-semibold rounded-lg border border-zinc-200 shadow-xs"
                >
                  <Download className="w-3.5 h-3.5 text-zinc-600" />
                  Download Sample Template (.xlsx)
                </button>
              </div>

              {/* Auto-Department Detection Badge */}
              {newDepartmentsDetected.length > 0 && (
                <div className="p-3 bg-indigo-50/80 border border-indigo-200 rounded-xl space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-indigo-950">
                    <Sparkles className="w-4 h-4 text-indigo-600" />
                    <span>
                      {newDepartmentsDetected.length} New Department(s) will be automatically created:
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {newDepartmentsDetected.map((d, idx) => (
                      <span
                        key={idx}
                        className="text-[11px] font-semibold px-2 py-0.5 rounded bg-indigo-100 text-indigo-900 border border-indigo-200"
                      >
                        + {d}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Parsed Items Preview Table */}
              {parsedItems.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-zinc-800">
                    <span>Preview of Parsed Items ({parsedItems.length} items ready):</span>
                  </div>
                  <div className="border border-zinc-200 rounded-xl overflow-hidden max-h-56 overflow-y-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-zinc-50 text-zinc-500 font-semibold border-b border-zinc-200 text-[10px] uppercase">
                        <tr>
                          <th className="py-2 px-3">Item Name</th>
                          <th className="py-2 px-3 font-mono">Barcode</th>
                          <th className="py-2 px-3">Department</th>
                          <th className="py-2 px-3 text-right">Price</th>
                          <th className="py-2 px-3 text-center">Stock</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100">
                        {parsedItems.slice(0, 8).map((row, idx) => (
                          <tr key={idx} className="hover:bg-zinc-50/60">
                            <td className="py-2 px-3 font-semibold text-zinc-900 truncate max-w-[160px]">
                              {row.name}
                            </td>
                            <td className="py-2 px-3 font-mono text-zinc-500 text-[11px]">
                              {row.barcode}
                            </td>
                            <td className="py-2 px-3">
                              <span
                                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                                  row.isNewDepartment
                                    ? 'bg-indigo-100 text-indigo-800'
                                    : 'bg-zinc-100 text-zinc-700'
                                }`}
                              >
                                {row.department} {row.isNewDepartment ? '★' : ''}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-right font-bold font-mono">
                              ${row.price.toFixed(2)}
                            </td>
                            <td className="py-2 px-3 text-center font-mono">
                              {row.stock_quantity} {row.unit}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {parsedItems.length > 8 && (
                    <p className="text-[10px] text-zinc-400 text-right">
                      + {parsedItems.length - 8} more rows will be imported
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Actions */}
        {!importResult && (
          <div className="p-4 bg-zinc-50 border-t border-zinc-100 flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 text-xs font-semibold text-zinc-700 bg-white border border-zinc-200 rounded-xl hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExecuteImport}
              disabled={loading || parsedItems.length === 0}
              className="flex-2 flex items-center justify-center gap-2 py-2.5 px-6 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-sm"
            >
              {loading ? (
                'Importing items...'
              ) : (
                <>
                  <span>Import {parsedItems.length} Items</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
