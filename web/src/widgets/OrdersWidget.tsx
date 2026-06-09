/**
 * Widget compact (100 px) affiché sur le Dashboard du panel.
 * Manifeste : { "zone": "/", "path": "/widget/dashboard", "height": 100 }
 *
 * Réservé aux admins : pour un USER, les appels ?all=true échouent → widget vide.
 */
import { useEffect, useMemo, useState } from 'react';
import { useAddon } from '../context';
import { useT, fmt } from '../i18n';
import { createApi } from '../lib/api';

interface Order { total: number; currency: string; status: string; }
interface Product { active: boolean; }

export default function OrdersWidget() {
  const { token, lang } = useAddon();
  const t = useT();
  const api = useMemo(() => createApi(token), [token]);

  const [orders, setOrders]     = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [ready, setReady]       = useState(false);

  useEffect(() => {
    if (!token) return;
    Promise.all([
      api.get<{ orders: Order[] }>('orders?all=true').then((d) => setOrders(d.orders)),
      api.get<{ products: Product[] }>('products?all=true').then((d) => setProducts(d.products)),
    ])
      .then(() => setReady(true))
      .catch(() => {/* pas admin → widget masqué */});
  }, [token]);

  if (!ready) return null;

  const revenue  = orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
  const currency = orders[0]?.currency ?? 'EUR';
  const active   = products.filter((p) => p.active).length;

  const stats = [
    { label: t('ordersCount'),    value: String(orders.length) },
    { label: t('revenue'),        value: fmt(revenue, currency, lang) },
    { label: t('activeProducts'), value: String(active) },
  ];

  return (
    <div className="grid-3 widget" style={{ height: '100%', alignItems: 'stretch' }}>
      {stats.map((s) => (
        <div key={s.label} className="card card-sm" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div className="stat-label">{s.label}</div>
          <div className="stat-value" style={{ fontSize: '1.1rem' }}>{s.value}</div>
          <div className="stat-sub">Orders addon</div>
        </div>
      ))}
    </div>
  );
}
