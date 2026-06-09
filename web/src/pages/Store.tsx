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
  items: OrderLine[];
  total: number;
  currency: string;
  status: 'paid' | 'fulfilled' | 'cancelled';
  created_at: string;
}
interface Balance { balance: number; currency: string; available: boolean; }

const STATUS_BADGE: Record<string, string> = {
  paid: 'badge-green', fulfilled: 'badge-amber', cancelled: 'badge-red',
};

export default function Store() {
  const { token, lang } = useAddon();
  const t = useT();
  const api = useMemo(() => createApi(token), [token]);

  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders]     = useState<Order[]>([]);
  const [balance, setBalance]   = useState<Balance | null>(null);
  const [cart, setCart]         = useState<Record<string, number>>({});
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [placing, setPlacing]   = useState(false);

  const load = () => {
    Promise.all([
      api.get<{ products: Product[] }>('products').then((d) => setProducts(d.products)),
      api.get<{ orders: Order[] }>('orders').then((d) => setOrders(d.orders)),
      api.get<Balance>('balance').then(setBalance).catch(() => setBalance(null)),
    ])
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    load();
  }, [token]);

  const currency = balance?.currency ?? products[0]?.currency ?? 'EUR';
  const cartTotal = useMemo(
    () => products.reduce((s, p) => s + (cart[p.id] ?? 0) * p.price, 0),
    [cart, products],
  );
  const cartCount = Object.values(cart).reduce((s, n) => s + n, 0);

  const setQty = (p: Product, qty: number) => {
    const max = p.stock === null ? 9999 : p.stock;
    const clamped = Math.max(0, Math.min(max, qty));
    setCart((c) => {
      const next = { ...c };
      if (clamped <= 0) delete next[p.id];
      else next[p.id] = clamped;
      return next;
    });
  };

  const checkout = async () => {
    const items = Object.entries(cart).map(([product_id, quantity]) => ({ product_id, quantity }));
    if (!items.length) return;
    setPlacing(true); setFeedback(null);
    try {
      await api.post('orders', { items });
      setFeedback({ type: 'ok', msg: t('orderPlaced') });
      setCart({});
      load();
    } catch (e: any) {
      setFeedback({ type: 'err', msg: e.message });
    } finally {
      setPlacing(false);
    }
  };

  if (!token)  return <div className="page"><div className="empty">{t('noToken')}</div></div>;
  if (loading) return <div className="page"><div className="loading">{t('loading')}</div></div>;
  if (error)   return <div className="page"><div className="alert alert-error">{error}</div></div>;

  const walletDown = balance && !balance.available;

  return (
    <div className="page">
      {/* En-tête : titre + solde */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="section-title" style={{ marginBottom: 0 }}>{t('store')}</h1>
        {balance?.available && (
          <span className="balance-pill">
            {t('myBalance')} : {fmt(balance.balance, balance.currency, lang)}
          </span>
        )}
      </div>

      {walletDown && (
        <div className="alert alert-warn mb-4">{t('walletRequired')}</div>
      )}

      {feedback && (
        <div className={`alert alert-${feedback.type === 'ok' ? 'success' : 'error'} mb-4`}>
          {feedback.msg}
        </div>
      )}

      {/* Catalogue */}
      <div className="section-title" style={{ fontSize: '1rem' }}>{t('catalog')}</div>
      {products.length === 0 ? (
        <div className="card empty">{t('noProducts')}</div>
      ) : (
        <div className="product-grid mb-4">
          {products.map((p) => {
            const qty = cart[p.id] ?? 0;
            const soldOut = p.stock !== null && p.stock <= 0;
            return (
              <div key={p.id} className="card product">
                <div className="product-name">{p.name}</div>
                {p.description && <div className="product-desc">{p.description}</div>}
                <div className="flex items-center justify-between">
                  <span className="product-price">{fmt(p.price, p.currency, lang)}</span>
                  {p.stock !== null && (
                    <span className={`badge ${soldOut ? 'badge-red' : 'badge-muted'}`}>
                      {soldOut ? t('outOfStock') : `${p.stock} ${t('available')}`}
                    </span>
                  )}
                </div>
                {soldOut ? (
                  <button className="btn btn-outline btn-block" disabled>{t('outOfStock')}</button>
                ) : qty > 0 ? (
                  <div className="form-row" style={{ justifyContent: 'center' }}>
                    <button className="btn btn-sm btn-outline" onClick={() => setQty(p, qty - 1)}>−</button>
                    <span className="text-bold" style={{ minWidth: 28, textAlign: 'center' }}>{qty}</span>
                    <button className="btn btn-sm btn-outline" onClick={() => setQty(p, qty + 1)}>+</button>
                  </div>
                ) : (
                  <button
                    className="btn btn-primary btn-block"
                    disabled={!!walletDown}
                    onClick={() => setQty(p, 1)}
                  >
                    {t('addToCart')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Panier */}
      {cartCount > 0 && (
        <div className="card mb-4" style={{ background: 'var(--bg2)' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-bold">{t('cart')} ({cartCount})</span>
            <span className="product-price">{fmt(cartTotal, currency, lang)}</span>
          </div>
          <button
            className="btn btn-primary btn-block"
            onClick={checkout}
            disabled={placing || !!walletDown}
          >
            {placing ? '…' : `${t('orderNow')} — ${fmt(cartTotal, currency, lang)}`}
          </button>
        </div>
      )}

      {/* Mes commandes */}
      <div className="section-title" style={{ fontSize: '1rem' }}>{t('myOrders')}</div>
      <div className="card" style={{ padding: 0 }}>
        {orders.length === 0 ? (
          <div className="empty">{t('noOrders')}</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('date')}</th>
                  <th>{t('items')}</th>
                  <th>{t('total')}</th>
                  <th>{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{fmtDate(o.created_at, lang)}</td>
                    <td className="text-sm">{o.items.map((l) => `${l.quantity}× ${l.name}`).join(', ')}</td>
                    <td className="text-bold">{fmt(o.total, o.currency, lang)}</td>
                    <td><span className={`badge ${STATUS_BADGE[o.status]}`}>{t(o.status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
