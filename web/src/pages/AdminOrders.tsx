import { useEffect, useMemo, useState } from 'react';
import { useAddon } from '../context';
import { useT, fmt, fmtDate } from '../i18n';
import { createApi } from '../lib/api';

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number | null;
  active: boolean;
}
interface OrderLine { product_id: string; name: string; unit_price: number; quantity: number; }
interface Order {
  id: string;
  user_id: string;
  items: OrderLine[];
  total: number;
  currency: string;
  status: 'paid' | 'fulfilled' | 'cancelled';
  created_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  paid: 'badge-green', fulfilled: 'badge-amber', cancelled: 'badge-red',
};

interface ProductForm { name: string; description: string; price: string; stock: string; active: boolean; }
const EMPTY_FORM: ProductForm = { name: '', description: '', price: '', stock: '', active: true };

export default function AdminOrders() {
  const { token, role, lang } = useAddon();
  const t = useT();
  const api = useMemo(() => createApi(token), [token]);

  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders]     = useState<Order[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [walletWarn, setWalletWarn] = useState(false);

  // Formulaire produit (création / édition)
  const [editingId, setEditingId] = useState<string | null>(null); // null = fermé, '' = nouveau
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = () => {
    Promise.all([
      api.get<{ products: Product[] }>('products?all=true').then((d) => setProducts(d.products)),
      api.get<{ orders: Order[] }>('orders?all=true').then((d) => setOrders(d.orders)),
      api.get<{ available: boolean; configured: boolean }>('wallet-status')
        .then((s) => setWalletWarn(!s.available || !s.configured))
        .catch(() => setWalletWarn(true)),
    ])
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!token || role !== 'ADMIN') { setLoading(false); return; }
    load();
  }, [token, role]);

  const openNew = () => { setEditingId(''); setForm(EMPTY_FORM); setFeedback(null); };
  const openEdit = (p: Product) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      description: p.description ?? '',
      price: String(p.price),
      stock: p.stock === null ? '' : String(p.stock),
      active: p.active,
    });
    setFeedback(null);
  };

  const saveProduct = async () => {
    const price = parseFloat(form.price);
    if (!form.name.trim() || isNaN(price) || price < 0) return;
    setSaving(true); setFeedback(null);
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      price,
      active: form.active,
    };
    // stock vide → illimité (on n'envoie pas la clé en création ;
    // en édition on envoie -1 ? non : le backend traite 'absent' = inchangé.
    // Pour repasser en illimité on ne peut pas via PATCH ici → on documente :
    if (form.stock.trim() !== '') body.stock = Math.max(0, parseInt(form.stock, 10) || 0);

    try {
      if (editingId) await api.patch(`products/${editingId}`, body);
      else await api.post('products', body);
      setEditingId(null);
      load();
    } catch (e: any) {
      setFeedback({ type: 'err', msg: e.message });
    } finally {
      setSaving(false);
    }
  };

  const deleteProduct = async (p: Product) => {
    if (!window.confirm(t('confirmDelete'))) return;
    try { await api.del(`products/${p.id}`); load(); }
    catch (e: any) { setFeedback({ type: 'err', msg: e.message }); }
  };

  const setStatus = async (o: Order, status: 'fulfilled' | 'cancelled') => {
    try {
      await api.patch(`orders/${o.id}/status`, { status });
      setFeedback({ type: 'ok', msg: t(status) });
      load();
    } catch (e: any) {
      setFeedback({ type: 'err', msg: e.message });
    }
  };

  if (!token) return <div className="page"><div className="empty">{t('noToken')}</div></div>;
  if (role !== 'ADMIN') return <div className="page"><div className="empty">{t('noAdmin')}</div></div>;
  if (loading) return <div className="page"><div className="loading">{t('loading')}</div></div>;
  if (error)   return <div className="page"><div className="alert alert-error">{error}</div></div>;

  return (
    <div className="page space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="section-title" style={{ marginBottom: 0 }}>{t('storeManagement')}</h1>
        <button className="btn btn-primary" onClick={openNew}>+ {t('addProduct')}</button>
      </div>

      {walletWarn && <div className="alert alert-warn">{t('walletNotConfigured')}</div>}
      {feedback && (
        <div className={`alert alert-${feedback.type === 'ok' ? 'success' : 'error'}`}>{feedback.msg}</div>
      )}

      {/* Formulaire produit */}
      {editingId !== null && (
        <div className="card" style={{ background: 'var(--bg2)' }}>
          <div className="text-bold mb-3">{editingId ? t('editProduct') : t('addProduct')}</div>
          <div className="space-y-3">
            <div>
              <label className="label-text">{t('name')}</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </div>
            <div>
              <label className="label-text">{t('description')}</label>
              <textarea className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="grid-2">
              <div>
                <label className="label-text">{t('price')} (EUR)</label>
                <input className="input" type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0.00" />
              </div>
              <div>
                <label className="label-text">{t('stock')} ({t('unlimited').toLowerCase()} = vide)</label>
                <input className="input" type="number" min="0" step="1" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} placeholder="∞" />
              </div>
            </div>
            <label className="flex items-center gap-2" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              <span className="text-sm">{t('active')}</span>
            </label>
            <div className="form-row">
              <button className="btn btn-primary" onClick={saveProduct} disabled={saving}>{saving ? '…' : t('save')}</button>
              <button className="btn btn-outline" onClick={() => setEditingId(null)}>{t('cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Produits */}
      <div>
        <div className="stat-label mb-2">{t('products')}</div>
        <div className="card" style={{ padding: 0 }}>
          {products.length === 0 ? (
            <div className="empty">{t('noProducts')}</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('name')}</th>
                    <th>{t('price')}</th>
                    <th>{t('stock')}</th>
                    <th>{t('status')}</th>
                    <th>{t('actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.id}>
                      <td className="text-bold">{p.name}</td>
                      <td>{fmt(p.price, p.currency, lang)}</td>
                      <td className="mono">{p.stock === null ? '∞' : p.stock}</td>
                      <td><span className={`badge ${p.active ? 'badge-green' : 'badge-muted'}`}>{p.active ? t('active') : t('inactive')}</span></td>
                      <td>
                        <div className="flex gap-1">
                          <button className="btn btn-sm btn-outline" onClick={() => openEdit(p)}>{t('edit')}</button>
                          <button className="btn btn-sm btn-danger" onClick={() => deleteProduct(p)}>{t('delete')}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Commandes */}
      <div>
        <div className="stat-label mb-2">{t('allOrders')}</div>
        <div className="card" style={{ padding: 0 }}>
          {orders.length === 0 ? (
            <div className="empty">{t('noOrders')}</div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('date')}</th>
                    <th>{t('customer')}</th>
                    <th>{t('items')}</th>
                    <th>{t('total')}</th>
                    <th>{t('status')}</th>
                    <th>{t('actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td className="mono">{fmtDate(o.created_at, lang)}</td>
                      <td><span className="mono truncate">{o.user_id.slice(0, 12)}…</span></td>
                      <td className="text-sm">{o.items.map((l) => `${l.quantity}× ${l.name}`).join(', ')}</td>
                      <td className="text-bold">{fmt(o.total, o.currency, lang)}</td>
                      <td><span className={`badge ${STATUS_BADGE[o.status]}`}>{t(o.status)}</span></td>
                      <td>
                        {o.status !== 'cancelled' && (
                          <div className="flex gap-1">
                            {o.status === 'paid' && (
                              <button className="btn btn-sm btn-success" onClick={() => setStatus(o, 'fulfilled')}>{t('markFulfilled')}</button>
                            )}
                            <button className="btn btn-sm btn-danger" onClick={() => setStatus(o, 'cancelled')}>{t('cancelRefund')}</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
