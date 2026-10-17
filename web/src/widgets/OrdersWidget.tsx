/**
 * Widget compact (100 px) affiché sur le Dashboard du panel (admin uniquement : un utilisateur simple n'a pas accès aux statistiques).
 * Manifeste : { "zone": "/", "path": "/widget/dashboard", "height": 100 }
 */
import { useAddon } from '../context';
import { useT } from '../i18n';
import { useFetch } from '../lib/api';
import { fmtMoney } from '../lib/format';

interface Stats { orders: number; pending: number; toFulfill: number; toApprove?: number; revenue: number; currency: string; activeProducts: number }

export default function OrdersWidget() {
  const { token, lang, role } = useAddon();
  const t = useT();
  const { data } = useFetch<Stats>(token && role === 'ADMIN' ? 'stats' : null);
  if (!data) return null;

  const stats = [
    { label: t('ordersCount'), value: String(data.orders), sub: ((data.toApprove ?? 0) > 0) ? t('toApprove') + ' : ' + data.toApprove : data.toFulfill > 0 ? t('toFulfillCount', { n: data.toFulfill }) : t('noPending') },
    { label: t('revenue'), value: fmtMoney(data.revenue, data.currency, lang), sub: 'Orders' },
    { label: t('activeProducts'), value: String(data.activeProducts), sub: t('products') },
  ];

  return (
    <div className="grid widget" style={{ height: '100%', alignItems: 'stretch', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
      {stats.map((s) => (
        <div key={s.label} className="card card-sm" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div className="stat-label">{s.label}</div>
          <div className="stat-value" style={{ fontSize: '1.15rem' }}>{s.value}</div>
          <div className="stat-sub">{s.sub}</div>
        </div>
      ))}
    </div>
  );
}
