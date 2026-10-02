import React, { useEffect, useState } from 'react';
import { CircleAlert, CheckCircle2, Store, Receipt, KeyRound, UserRound } from 'lucide-react';
import { User } from '../types';
import { api } from '../utils/api';
import type { StoreSettings } from '../utils/api';
import { PROVINCE_OPTIONS } from '../utils/tax';

const PRIMARY_BTN =
  'h-11 px-4 inline-flex items-center justify-center gap-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 disabled:opacity-60 text-white text-[13px] font-semibold transition-colors';
const FIELD_LABEL = 'text-[13px] leading-5 font-semibold text-zinc-800';
const FIELD =
  'w-full h-11 px-3 text-sm bg-white border border-zinc-200 rounded-xl text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900';
const HINT = 'text-xs leading-4 text-zinc-500';

/** Same rule as the server: 9 digits, RT, 4 digits (spaces ignored). */
const GST_PATTERN = /^\d{9}RT\d{4}$/;

/** Separate provincial tax, and what the province calls it. HST provinces have none. */
const PST_NAME: Record<string, string> = { BC: 'PST', SK: 'PST', MB: 'RST', QC: 'QST' };
const HST_PROVINCES = new Set(['ON', 'NB', 'NL', 'NS', 'PE']);

const Card: React.FC<{ icon: React.FC<{ className?: string }>; title: string; children: React.ReactNode }> = ({
  icon: Icon,
  title,
  children,
}) => (
  <section className="rounded-2xl border border-zinc-200/80 bg-white shadow-xs p-5 flex flex-col gap-4">
    <h2 className="flex items-center gap-2 text-[15px] font-semibold text-zinc-950">
      <Icon className="w-4 h-4 text-zinc-500" />
      {title}
    </h2>
    {children}
  </section>
);

const Banner: React.FC<{ kind: 'error' | 'ok'; children: React.ReactNode }> = ({ kind, children }) => (
  <div
    role={kind === 'error' ? 'alert' : 'status'}
    className={`flex items-start gap-2 p-3 rounded-xl border text-[13px] leading-5 ${
      kind === 'error' ? 'bg-rose-50 border-rose-200 text-rose-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'
    }`}
  >
    {kind === 'error' ? (
      <CircleAlert className="w-4 h-4 mt-px flex-shrink-0" />
    ) : (
      <CheckCircle2 className="w-4 h-4 mt-px flex-shrink-0" />
    )}
    <span>{children}</span>
  </div>
);

export const StoreProfilePage: React.FC<{ currentUser: User }> = ({ currentUser }) => {
  const [loaded, setLoaded] = useState<StoreSettings | null>(null);
  const [form, setForm] = useState({
    store_name: '',
    store_address: '',
    store_phone: '',
    province: '',
    gst_rate_percent: '5',
    pst_rate_percent: '0',
    gst_number: '',
    pst_number: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);

  const fill = (s: StoreSettings) => {
    setLoaded(s);
    setForm({
      store_name: s.store_name,
      store_address: s.store_address ?? '',
      store_phone: s.store_phone ?? '',
      province: s.province ?? '',
      gst_rate_percent: String(s.gst_rate_percent),
      pst_rate_percent: String(s.pst_rate_percent),
      gst_number: s.gst_number ?? '',
      pst_number: s.pst_number ?? '',
    });
  };

  useEffect(() => {
    api
      .getSettings()
      .then(fill)
      .catch((err) => setError(err.message || 'Could not load the store profile'));
  }, []);

  const set =
    (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const isHst = HST_PROVINCES.has(form.province);
  const pstName = PST_NAME[form.province];
  const gstClean = form.gst_number.toUpperCase().replace(/\s+/g, '');
  const gstInvalid = gstClean !== '' && !GST_PATTERN.test(gstClean);
  const provinceChanged = form.province !== (loaded?.province ?? '');

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!form.store_name.trim()) return setError('Store name is required.');
    if (gstInvalid) return setError('GST/HST number must look like 123456789 RT0001.');
    setSaving(true);
    try {
      const saved = await api.updateSettings({
        store_name: form.store_name.trim(),
        store_address: form.store_address.trim() || null,
        store_phone: form.store_phone.trim() || null,
        gst_number: gstClean || null,
        pst_number: form.pst_number.trim() || null,
        // A new province brings its own rates; otherwise keep what was typed.
        ...(provinceChanged
          ? { province: form.province || null }
          : {
              gst_rate_percent: Number(form.gst_rate_percent) || 0,
              pst_rate_percent: Number(form.pst_rate_percent) || 0,
            }),
      });
      fill(saved);
      setNotice(
        provinceChanged && saved.province
          ? `Saved. Tax is now ${saved.tax_labels.gst}${saved.tax_labels.pst ? ` + ${saved.tax_labels.pst}` : ''} (${saved.tax_rate_percent}% on fully taxable items).`
          : 'Store profile saved.',
      );
    } catch (err: any) {
      setError(err.message || 'Could not save the store profile');
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);
    if (pw.next !== pw.confirm) return setPwMsg({ kind: 'error', text: 'The new passwords do not match.' });
    setPwBusy(true);
    try {
      await api.changePassword({ current_password: pw.current, new_password: pw.next });
      setPw({ current: '', next: '', confirm: '' });
      setPwMsg({ kind: 'ok', text: 'Password changed.' });
    } catch (err: any) {
      setPwMsg({ kind: 'error', text: err.message || 'Could not change the password' });
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <div className="w-full px-4 sm:px-6 py-4 sm:py-6 flex flex-col gap-4 max-w-3xl">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl lg:text-[22px] lg:leading-7 font-bold tracking-[-0.01em] text-zinc-950">Store Profile</h1>
        <p className="text-[13px] leading-5 text-zinc-500">
          Your business details and tax registration. Everything here prints on every receipt.
        </p>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}

      <Card icon={UserRound} title="Owner account">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
          <div>
            <div className={HINT}>Name</div>
            <div className="font-semibold text-zinc-900">{currentUser.display_name}</div>
          </div>
          <div>
            <div className={HINT}>Username</div>
            <div className="font-semibold text-zinc-900">{currentUser.username}</div>
          </div>
        </div>
      </Card>

      <form onSubmit={save} className="flex flex-col gap-4">
        <Card icon={Store} title="Business details">
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Store name</span>
            <input className={FIELD} value={form.store_name} onChange={set('store_name')} maxLength={120} required />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Address</span>
            <textarea
              className={`${FIELD} h-auto py-2`}
              rows={2}
              value={form.store_address}
              onChange={set('store_address')}
              maxLength={200}
              placeholder="123 Main St, Toronto ON M5V 1A1"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Phone</span>
            <input className={FIELD} value={form.store_phone} onChange={set('store_phone')} maxLength={30} inputMode="tel" />
          </label>
        </Card>

        <Card icon={Receipt} title="Sales tax">
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Province or territory</span>
            <select className={FIELD} value={form.province} onChange={set('province')}>
              <option value="">Not set (one flat rate)</option>
              {PROVINCE_OPTIONS.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className={HINT}>Choosing a province fills in its current rates when you save.</span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>GST/HST registration number</span>
            <input
              className={`${FIELD} font-mono ${gstInvalid ? 'border-rose-300 focus:ring-rose-500' : ''}`}
              value={form.gst_number}
              onChange={set('gst_number')}
              placeholder="123456789 RT0001"
              maxLength={20}
              aria-invalid={gstInvalid}
            />
            <span className={gstInvalid ? 'text-xs leading-4 text-rose-600' : HINT}>
              {gstInvalid
                ? 'Nine digits, then RT and four digits.'
                : 'Printed on every receipt. Leave blank if you are not registered yet.'}
            </span>
          </label>

          {pstName && (
            <label className="flex flex-col gap-1.5">
              <span className={FIELD_LABEL}>{pstName} registration number</span>
              <input className={`${FIELD} font-mono`} value={form.pst_number} onChange={set('pst_number')} maxLength={40} />
            </label>
          )}

          {!provinceChanged && (
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span className={FIELD_LABEL}>{isHst ? 'HST federal part %' : form.province ? 'GST %' : 'Tax %'}</span>
                <input
                  className={FIELD}
                  type="number"
                  step="0.001"
                  min="0"
                  max="100"
                  value={form.gst_rate_percent}
                  onChange={set('gst_rate_percent')}
                />
              </label>
              {(isHst || pstName) && (
                <label className="flex flex-col gap-1.5">
                  <span className={FIELD_LABEL}>{isHst ? 'HST provincial part %' : `${pstName} %`}</span>
                  <input
                    className={FIELD}
                    type="number"
                    step="0.001"
                    min="0"
                    max="100"
                    value={form.pst_rate_percent}
                    onChange={set('pst_rate_percent')}
                  />
                </label>
              )}
            </div>
          )}
          {loaded && (
            <p className={HINT}>
              Fully taxable items currently pay <b>{loaded.tax_rate_percent}%</b> ({loaded.tax_labels.gst}
              {loaded.tax_labels.pst ? ` + ${loaded.tax_labels.pst}` : ''}). Set each product&apos;s tax type in
              Inventory.
            </p>
          )}
        </Card>

        <div>
          <button type="submit" className={PRIMARY_BTN} disabled={saving || !loaded}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>

      <form onSubmit={changePassword}>
        <Card icon={KeyRound} title="Change password">
          {pwMsg && <Banner kind={pwMsg.kind}>{pwMsg.text}</Banner>}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {(
              [
                ['current', 'Current password', 'current-password'],
                ['next', 'New password', 'new-password'],
                ['confirm', 'Repeat new password', 'new-password'],
              ] as const
            ).map(([key, label, auto]) => (
              <label key={key} className="flex flex-col gap-1.5">
                <span className={FIELD_LABEL}>{label}</span>
                <input
                  className={FIELD}
                  type="password"
                  autoComplete={auto}
                  value={pw[key]}
                  onChange={(e) => setPw((p) => ({ ...p, [key]: e.target.value }))}
                  required
                />
              </label>
            ))}
          </div>
          <div>
            <button type="submit" className={PRIMARY_BTN} disabled={pwBusy}>
              {pwBusy ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </Card>
      </form>
    </div>
  );
};
