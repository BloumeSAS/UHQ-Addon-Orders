import { useState } from 'react';
import { useT } from '../i18n';
import { copyText, downloadFile } from '../lib/format';
import { Icon } from './icons';
import { Badge, CopyButton } from './ui';

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number | null;
  active: boolean;
  delivery?: DeliveryConfig;
}

export interface DeliveryAccount {
  threads_limit?: number;
  traffic_limit_bytes?: number;
  country_filter?: string;
  sticky_session_ttl?: number;
  bandwidth_limit?: number;
  expires_days?: number;
  allowed_ips?: string;
  tags?: string;
  custom_proxies?: string;
  pool?: string;
}

export interface DeliveryConfig {
  mode: 'none' | 'panel_account';
  account?: DeliveryAccount;
}

export interface OrderLine {
  product_id: string;
  name: string;
  unit_price: number;
  quantity: number;
}

export interface Delivered {
  product_name: string;
  username: string;
  password: string;
  host: string;
  port: string;
  connection: string;
}

export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'cancelled';
export type PayMethod = 'wallet' | 'stripe' | 'nowpayments';

export interface Order {
  id: string;
  user_id: string;
  user_email?: string;
  items: OrderLine[];
  total: number;
  currency: string;
  status: OrderStatus;
  payment_method?: PayMethod;
  deliveries?: Delivered[];
  created_at: string;
  updated_at: string;
}

export const shortId = (id: string) => `#${id.slice(0, 8).toUpperCase()}`;

const STATUS_TONE: Record<OrderStatus, 'warn' | 'info' | 'good' | 'bad'> = { pending: 'warn', paid: 'info', fulfilled: 'good', cancelled: 'bad' };
const STATUS_ICON = { pending: 'clock', paid: 'check', fulfilled: 'package', cancelled: 'ban' } as const;

export function StatusBadge({ status }: { status: OrderStatus }) {
  const t = useT();
  return <Badge tone={STATUS_TONE[status]} icon={STATUS_ICON[status]}>{t(`status.${status}`)}</Badge>;
}

export function PaymentBadge({ method }: { method?: PayMethod }) {
  const t = useT();
  const m = method ?? 'wallet';
  return <Badge icon={m === 'wallet' ? 'wallet' : m === 'stripe' ? 'card' : 'coins'}>{t(`pay.${m}`)}</Badge>;
}

/** Frise de suivi : Commande → Paiement → Livraison / terminée (ou Annulée). */
export function Timeline({ order }: { order: Pick<Order, 'status'> & { deliveries?: Delivered[] } }) {
  const t = useT();
  const s = order.status;
  const paid = s === 'paid' || s === 'fulfilled';
  const steps: { label: string; done: boolean; bad?: boolean }[] = [
    { label: t('tl.ordered'), done: true },
    { label: t('tl.paid'), done: paid },
    s === 'cancelled'
      ? { label: t('tl.cancelled'), done: true, bad: true }
      : { label: (order.deliveries?.length ?? 0) > 0 ? t('tl.delivered') : t('tl.completed'), done: paid },
  ];
  return (
    <div className="timeline" aria-label={t('tl.label')}>
      {steps.map((st, i) => (
        <span key={i} className="row gap-1" style={{ flexWrap: 'nowrap' }}>
          {i > 0 && <span className={`tl-line ${steps[i - 1].done && st.done && !st.bad ? 'done' : ''}`} />}
          <span className={`tl-step ${st.done ? 'done' : ''} ${st.bad ? 'bad' : ''}`}><span className="tl-dot" />{st.label}</span>
        </span>
      ))}
    </div>
  );
}

/** Identifiants livrés : mot de passe masqué par défaut, copie d'une ligne ou de tout, téléchargement en .txt. */
export function Credentials({ deliveries, filename }: { deliveries: Delivered[]; filename: string }) {
  const t = useT();
  const [shown, setShown] = useState<Set<number>>(new Set());
  const all = deliveries.map((d) => d.connection).join('\n');

  return (
    <div className="stack-sm">
      <div className="row-between">
        <div className="text-sm text-bold row gap-2"><Icon name="key" size={15} />{t('delivered', { n: deliveries.length })}</div>
        <div className="row gap-1">
          {deliveries.length > 1 && <CopyButton text={all} label={t('copyAll')} />}
          <button className="btn btn-outline btn-sm" onClick={() => downloadFile(filename, `${all}\n`)}><Icon name="download" size={13} />{t('downloadTxt')}</button>
        </div>
      </div>
      <div className="text-xs text-muted">{t('credFormat')}</div>
      {deliveries.map((d, i) => {
        const reveal = shown.has(i);
        const masked = `${d.host}:${d.port}:${d.username}:${'•'.repeat(8)}`;
        return (
          <div key={i} className="cred">
            <div className="grow">
              <div className="text-xs text-muted">{d.product_name}</div>
              <code>{reveal ? d.connection : masked}</code>
            </div>
            <button className="btn btn-ghost btn-icon btn-sm" aria-label={reveal ? t('hide') : t('reveal')} title={reveal ? t('hide') : t('reveal')} onClick={() => setShown((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>
              <Icon name={reveal ? 'eyeOff' : 'eye'} size={15} />
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => void copyText(d.connection)} aria-label={`${t('ui.copy')} ${d.username}`}><Icon name="copy" size={13} />{t('ui.copy')}</button>
          </div>
        );
      })}
    </div>
  );
}
