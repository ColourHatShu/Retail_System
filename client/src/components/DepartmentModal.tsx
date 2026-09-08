import React, { useState } from 'react';
import { X, Plus, Trash2, FolderPlus, Tag } from 'lucide-react';
import { Department } from '../types';

interface DepartmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  departments: Department[];
  onAddDepartment: (data: Partial<Department>) => Promise<void>;
  onDeleteDepartment: (id: number) => Promise<void>;
}

const PRESET_COLORS = [
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#6366f1', // indigo
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // purple
  '#14b8a6', // teal
  '#f43f5e', // rose
];

export const DepartmentModal: React.FC<DepartmentModalProps> = ({
  isOpen,
  onClose,
  departments,
  onAddDepartment,
  onDeleteDepartment,
}) => {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !code.trim()) {
      setError('Name and short Code are required');
      return;
    }

    try {
      setLoading(true);
      await onAddDepartment({
        name: name.trim(),
        code: code.trim().toUpperCase(),
        description: description.trim() || undefined,
        color,
      });
      setName('');
      setCode('');
      setDescription('');
    } catch (err: any) {
      setError(err.message || 'Failed to create department');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: number, productCount?: number) => {
    if (productCount && productCount > 0) {
      alert(`Cannot delete this department because it still has ${productCount} active products.`);
      return;
    }
    if (!confirm('Are you sure you want to delete this department?')) return;

    try {
      await onDeleteDepartment(id);
    } catch (err: any) {
      alert(err.message || 'Failed to delete department');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/60 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-zinc-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
          <div>
            <h3 className="text-base font-semibold text-zinc-900 flex items-center gap-2">
              <FolderPlus className="w-5 h-5 text-zinc-700" />
              Manage Departments
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Organize your inventory catalog by retail departments
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded-lg hover:bg-zinc-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          {/* Create New Department Form */}
          <form onSubmit={handleSubmit} className="p-4 bg-zinc-50 rounded-xl border border-zinc-200/80 space-y-3">
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider">
              Add New Department
            </h4>

            {error && (
              <div className="p-2.5 text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded-lg">
                {error}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <input
                  type="text"
                  placeholder="Department Name (e.g. Organic Produce)"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!code) {
                      setCode(e.target.value.substring(0, 4).toUpperCase());
                    }
                  }}
                  className="w-full px-3 py-2 text-xs bg-white border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900"
                  required
                />
              </div>
              <div>
                <input
                  type="text"
                  placeholder="Code (PROD)"
                  value={code}
                  maxLength={6}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  className="w-full px-3 py-2 text-xs uppercase font-mono bg-white border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900"
                  required
                />
              </div>
            </div>

            <input
              type="text"
              placeholder="Description (Optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-white border border-zinc-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />

            {/* Color selection */}
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full transition-transform ${
                      color === c ? 'scale-125 ring-2 ring-zinc-900 ring-offset-2' : 'hover:scale-110'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <button
                type="submit"
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-zinc-900 hover:bg-zinc-800 rounded-lg shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Dept
              </button>
            </div>
          </form>

          {/* Department List */}
          <div>
            <h4 className="text-xs font-bold text-zinc-900 uppercase tracking-wider mb-2">
              Existing Departments ({departments.length})
            </h4>
            <div className="divide-y divide-zinc-100 border border-zinc-200 rounded-xl overflow-hidden bg-white">
              {departments.map((dept) => (
                <div key={dept.id} className="p-3 flex items-center justify-between hover:bg-zinc-50 transition-colors">
                  <div className="flex items-center gap-3">
                    <span
                      className="w-3.5 h-3.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: dept.color || '#4f46e5' }}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-zinc-900">{dept.name}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-100 text-zinc-600 rounded font-medium">
                          {dept.code}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500">
                        {dept.product_count || 0} items • Valuation: ${(dept.inventory_value || 0).toFixed(2)}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => handleDelete(dept.id, dept.product_count)}
                    className="p-1.5 text-zinc-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors"
                    title="Delete department"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
