import { useState } from 'react';
import { toast } from 'sonner';
import { useAddon } from '../context';
import { useT } from '../i18n';
import { createApi, useApi, useDebounced, useFetch } from '../lib/api';
import { downloadFile, fmtDateTime, fmtMoney, toCsv } from '../lib/format';
import { Icon } from '../components/icons';
import { Credentials, DeliveryAccount, Order, OrderStatus, PaymentBadge, Product, shortId, StatusBadge, Timeline } from '../components/OrderMeta';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, PageSkeleton, Pagination, SearchInput, Seg, Stat, Switch, Tabs, useConfirm } from '../components/ui';

interface Stats { orders: number; pending: number; toFulfill: number; revenue: number; revenueMonth: number; currency: string; activeProducts: number; lowStock: number }
interface PoolInfo { name: string; antiVpnEnabled: boolean }

type Tab = 'products' | 'orders' | 'settings';

/** Gestion de la boutique (admin) : indicateurs, produits (création guidée), commandes (recherche, détail, remboursement) et état des paiements. */
export default function AdminOrders() {
  const { token, role, lang } = useAddon();
  const t = useT();
  const isAdmin = role === 'ADMIN';
  const stats = useFetch<Stats>(token && isAdmin ? 'stats' : null);
  const [tab, setTab] = useState<Tab>('products');

  if (!token) return <div className="page"><Empty icon="key" title={t('noToken')} text={t('noTokenText')} /></div>;
  if (!isAdmin) return <div className="page"><Empty icon="ban" title={t('noAdmin')} text={t('noAdminText')} /></div>;
  if (stats.loading && !stats.data) return <div className="page"><PageSkeleton /></div>;
  if (stats.error && !stats.data) return <div className="page"><ErrorBox message={stats.error} onRetry={stats.reload} /></div>;

  const s = stats.data;
  return (
    <div className="page stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('storeManagement')}</h1>
          <p className="page-sub">{t('storeManagementSub')}</p>
        </div>
      </div>

      {s && (
        <div className="stat-grid">
          <Stat label={t('revenue')} value={fmtMoney(s.revenue, s.currency, lang)} sub={t('revenueMonth', { v: fmtMoney(s.revenueMonth, s.currency, lang) })} tone="primary" />
          <Stat label={t('ordersCount')} value={s.orders} sub={s.pending > 0 ? t('pendingCount', { n: s.pending }) : t('noPending')} />
          <Stat label={t('toFulfill')} value={s.toFulfill} sub={t('toFulfillSub')} tone={s.toFulfill > 0 ? 'warn' : undefined} />
          <Stat label={t('activeProducts')} value={s.activeProducts} sub={s.lowStock > 0 ? t('lowStockCount', { n: s.lowStock }) : t('stockOk')} tone={s.lowStock > 0 ? 'warn' : undefined} />
        </div>
      )}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'products', label: t('products'), icon: 'package' },
          { id: 'orders', label: t('allOrders'), icon: 'receipt', count: s?.toFulfill },
          { id: 'settings', label: t('payments'), icon: 'card' },
        ]}
      />

      {tab === 'products' && <ProductsTab onChanged={stats.reload} />}
      {tab === 'orders' && <OrdersTab onChanged={stats.reload} />}
      {tab === 'settings' && <PaymentsTab />}
    </div>
  );
}

// ─── Produits ──────────────────────────────────────────────────────────────────

function ProductsTab({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const { lang } = useAddon();
  const api = useApi();
  const products = useFetch<{ products: Product[] }>('products?all=true');
  const pools = useFetch<{ pools: PoolInfo[] }>('pools');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [confirm, confirmEl] = useConfirm();
  const list = products.data?.products ?? [];

  const refresh = () => { products.reload(); onChanged(); };

  const toggleActive = async (p: Product, active: boolean) => {
    try { await api.patch(`products/${p.id}`, { active }); refresh(); } catch (e: any) { toast.error(e.message); }
  };
  const duplicate = async (p: Product) => {
    try {
      await api.post('products', { name: `${p.name} ${t('copySuffix')}`, description: p.description ?? undefined, price: p.price, currency: p.currency, stock: p.stock, active: false, delivery: p.delivery });
      toast.success(t('duplicated'));
      refresh();
    } catch (e: any) { toast.error(e.message); }
  };
  const remove = async (p: Product) => {
    if (!(await confirm({ title: t('delete'), message: t('confirmDelete', { name: p.name }), confirmLabel: t('delete') }))) return;
    try { await api.del(`products/${p.id}`); refresh(); } catch (e: any) { toast.error(e.message); }
  };

  if (products.loading && !products.data) return <PageSkeleton rows={4} />;
  if (products.error && !products.data) return <ErrorBox message={products.error} onRetry={products.reload} />;

  return (
    <div className="stack">
      <div className="row-between">
        <span className="text-sm text-muted">{t('productCount', { n: list.length })}</span>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} />{t('addProduct')}</button>
      </div>

      {list.length === 0 ? (
        <Card>
          <Empty
            icon="package"
            title={t('emptyProductsTitle')}
            text={t('emptyProductsText')}
            action={<button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} />{t('createFirst')}</button>}
          />
        </Card>
      ) : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('name')}</th><th className="num">{t('price')}</th><th>{t('stock')}</th><th>{t('delivery')}</th><th>{t('active')}</th><th style={{ textAlign: 'right' }}>{t('actions')}</th></tr></thead>
              <tbody>
                {list.map((p) => {
                  const low = p.stock !== null && p.stock <= 3;
                  return (
                    <tr key={p.id} style={{ opacity: p.active ? 1 : 0.65 }}>
                      <td>
                        <div className="text-bold">{p.name}</div>
                        <div className="text-xs text-muted truncate" style={{ maxWidth: 320 }}>{p.description || t('noDescription')}</div>
                      </td>
                      <td className="num"><b>{fmtMoney(p.price, p.currency, lang)}</b></td>
                      <td>{p.stock === null ? <span className="text-muted">∞ {t('unlimited')}</span> : <Badge tone={p.stock <= 0 ? 'bad' : low ? 'warn' : 'muted'}>{p.stock <= 0 ? t('outOfStock') : t('units', { n: p.stock })}</Badge>}</td>
                      <td>
                        {p.delivery?.mode === 'panel_account'
                          ? <Badge tone="good" icon="zap">{p.delivery.account?.custom_proxies ? t('deliveryPrivate') : p.delivery.account?.pool ? p.delivery.account.pool : t('deliveryPool')}</Badge>
                          : <span className="text-muted text-sm">{t('deliveryManual')}</span>}
                      </td>
                      <td><Switch checked={p.active} onChange={(v) => void toggleActive(p, v)} label={t('active')} /></td>
                      <td>
                        <div className="row gap-1" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <button className="btn btn-outline btn-sm" onClick={() => setEditing(p)}><Icon name="edit" size={13} />{t('edit')}</button>
                          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => void duplicate(p)} title={t('duplicate')} aria-label={t('duplicate')}><Icon name="copyPlus" size={14} /></button>
                          <button className="btn btn-ghost btn-icon btn-sm" onClick={() => void remove(p)} title={t('delete')} aria-label={t('delete')}><Icon name="trash" size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editing && <ProductModal product={editing === 'new' ? null : editing} pools={pools.data?.pools ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {confirmEl}
    </div>
  );
}

// ─── Formulaire produit ────────────────────────────────────────────────────────

/** 1 Go = 1 000 000 000 octets (unité du panel depuis la v2.4.65). */
const GB = 1_000_000_000;

interface Form {
  name: string; description: string; price: string; currency: string; unlimited: boolean; stock: string; active: boolean;
  mode: 'none' | 'panel_account';
  threads: string; trafficGb: string; bandwidth: string; expiresDays: string; country: string; ttl: string; allowedIps: string; tags: string; pool: string; custom: string;
}

function toForm(p: Product | null): Form {
  const a: DeliveryAccount = p?.delivery?.account ?? {};
  return {
    name: p?.name ?? '', description: p?.description ?? '', price: p ? String(p.price) : '', currency: p?.currency ?? 'EUR',
    unlimited: p ? p.stock === null : true, stock: p?.stock != null ? String(p.stock) : '10', active: p?.active ?? true,
    mode: p?.delivery?.mode ?? 'none',
    threads: a.threads_limit != null ? String(a.threads_limit) : '',
    trafficGb: a.traffic_limit_bytes ? String(Math.round((a.traffic_limit_bytes / GB) * 100) / 100) : '',
    bandwidth: a.bandwidth_limit != null ? String(a.bandwidth_limit) : '',
    expiresDays: a.expires_days != null ? String(a.expires_days) : '',
    country: a.country_filter ?? '', ttl: a.sticky_session_ttl != null ? String(a.sticky_session_ttl) : '',
    allowedIps: a.allowed_ips ?? '', tags: a.tags ?? '', pool: a.pool ?? '', custom: a.custom_proxies ?? '',
  };
}

const intOrUndef = (s: string) => (s.trim() === '' ? undefined : parseInt(s, 10));
const isInt = (s: string) => s.trim() === '' || /^\d+$/.test(s.trim());

function ProductModal({ product, pools, onClose, onSaved }: { product: Product | null; pools: PoolInfo[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { lang } = useAddon();
  const api = useApi();
  const [f, setF] = useState<Form>(() => toForm(product));
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const price = Number(f.price.replace(',', '.'));
  const errors: Partial<Record<keyof Form, string>> = {};
  if (!f.name.trim()) errors.name = t('err.required');
  if (f.name.length > 120) errors.name = t('err.tooLong');
  if (f.price.trim() === '' || !Number.isFinite(price) || price < 0 || price > 1_000_000 || Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) errors.price = t('err.price');
  if (!/^[A-Za-z]{3}$/.test(f.currency)) errors.currency = t('err.currency');
  if (!f.unlimited && (!/^\d+$/.test(f.stock.trim()))) errors.stock = t('err.int');
  if (f.mode === 'panel_account') {
    for (const k of ['threads', 'bandwidth', 'expiresDays', 'ttl'] as const) if (!isInt(f[k])) errors[k] = t('err.int');
    if (f.trafficGb.trim() !== '' && !(Number(f.trafficGb.replace(',', '.')) >= 0)) errors.trafficGb = t('err.number');
    if (f.country.trim() && !/^[A-Za-z]{2}(\s*,\s*[A-Za-z]{2})*$/.test(f.country.trim())) errors.country = t('err.country');
  }
  const invalid = Object.keys(errors).length > 0;
  const show = (k: keyof Form) => (tried ? errors[k] : undefined);

  const save = async () => {
    setTried(true);
    if (invalid) return;
    setBusy(true);
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      description: f.description.trim(),
      price: Math.round(price * 100) / 100,
      currency: f.currency.toUpperCase(),
      stock: f.unlimited ? null : parseInt(f.stock, 10),
      active: f.active,
      delivery: f.mode === 'panel_account'
        ? {
            mode: 'panel_account',
            account: {
              threads_limit: intOrUndef(f.threads),
              traffic_limit_bytes: f.trafficGb.trim() !== '' && Number(f.trafficGb.replace(',', '.')) > 0 ? Math.round(Number(f.trafficGb.replace(',', '.')) * GB) : undefined,
              country_filter: f.country.trim() || undefined,
              sticky_session_ttl: intOrUndef(f.ttl),
              bandwidth_limit: intOrUndef(f.bandwidth),
              expires_days: intOrUndef(f.expiresDays),
              allowed_ips: f.allowedIps.trim() || undefined,
              tags: f.tags.trim() || undefined,
              custom_proxies: f.custom.trim() || undefined,
              pool: f.custom.trim() ? undefined : f.pool.trim() || undefined,
            },
          }
        : { mode: 'none' },
    };
    try {
      if (product) await api.patch(`products/${product.id}`, body);
      else await api.post('products', body);
      toast.success(t('saved'));
      onSaved();
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={product ? t('editProduct') : t('addProduct')}
      onClose={onClose}
      busy={busy}
      size="lg"
      footer={
        <>
          <button className="btn btn-outline" onClick={onClose} disabled={busy}>{t('ui.cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || (tried && invalid)}>{busy ? '…' : product ? t('save') : t('create')}</button>
        </>
      }
    >
      <div className="stack">
        {/* Aperçu client */}
        <div className="section-box row gap-3" style={{ flexWrap: 'nowrap' }}>
          <div className="product-icon"><Icon name={f.mode === 'panel_account' ? 'zap' : 'package'} size={20} /></div>
          <div className="grow">
            <div className="label">{t('preview')}</div>
            <div className="text-bold">{f.name.trim() || t('previewName')}</div>
            <div className="text-xs text-muted truncate">{f.description.trim() || t('noDescription')}</div>
          </div>
          <div className="product-price">{Number.isFinite(price) && f.price !== '' ? fmtMoney(price, /^[A-Za-z]{3}$/.test(f.currency) ? f.currency.toUpperCase() : 'EUR', lang) : '—'}</div>
        </div>

        <section className="stack-sm">
          <h4 className="section-title">{t('sectionGeneral')}</h4>
          <Field label={t('name')} error={show('name')}><input className={`input ${show('name') ? 'invalid' : ''}`} value={f.name} maxLength={120} onChange={(e) => set('name', e.target.value)} autoFocus placeholder={t('namePlaceholder')} /></Field>
          <Field label={t('description')} hint={t('descriptionHint')}><textarea className="input" value={f.description} maxLength={2000} onChange={(e) => set('description', e.target.value)} /></Field>
          <div className="form-grid">
            <Field label={t('price')} error={show('price')}><input className={`input ${show('price') ? 'invalid' : ''}`} inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} placeholder="9.99" /></Field>
            <Field label={t('currency')} error={show('currency')} hint={t('currencyHint')}><input className={`input ${show('currency') ? 'invalid' : ''}`} value={f.currency} maxLength={3} onChange={(e) => set('currency', e.target.value.toUpperCase())} /></Field>
          </div>
          <div className="stack-sm">
            <div className="label">{t('stock')}</div>
            <div className="row">
              <Seg<'unlimited' | 'limited'> label={t('stock')} value={f.unlimited ? 'unlimited' : 'limited'} onChange={(v) => set('unlimited', v === 'unlimited')} options={[{ id: 'unlimited', label: t('unlimited') }, { id: 'limited', label: t('limitedStock') }]} />
              {!f.unlimited && <div style={{ width: 130 }}><input className={`input ${show('stock') ? 'invalid' : ''}`} inputMode="numeric" value={f.stock} onChange={(e) => set('stock', e.target.value)} aria-label={t('stock')} /></div>}
            </div>
            {show('stock') && <span className="error-text">{errors.stock}</span>}
            <span className="hint">{t('stockHint')}</span>
          </div>
          <label className="row gap-3" style={{ cursor: 'pointer' }}><Switch checked={f.active} onChange={(v) => set('active', v)} label={t('active')} /><span><b>{t('active')}</b><div className="text-xs text-muted">{t('activeHint')}</div></span></label>
        </section>

        <section className="stack-sm">
          <h4 className="section-title">{t('sectionDelivery')}</h4>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <button type="button" className={`choice ${f.mode === 'none' ? 'active' : ''}`} onClick={() => set('mode', 'none')}>
              <Icon name="package" size={18} /><span><b>{t('deliveryNone')}</b><div className="text-xs text-muted">{t('deliveryNoneHint')}</div></span>
            </button>
            <button type="button" className={`choice ${f.mode === 'panel_account' ? 'active' : ''}`} onClick={() => set('mode', 'panel_account')}>
              <Icon name="zap" size={18} /><span><b>{t('deliveryPanelAccount')}</b><div className="text-xs text-muted">{t('deliveryPanelHint')}</div></span>
            </button>
          </div>

          {f.mode === 'panel_account' && (
            <div className="section-box stack-sm">
              <Field label={t('dCategory')} hint={f.custom.trim() ? t('dCategoryOverriddenHint') : t('dCategoryHint')}>
                <select className="input" value={f.pool} onChange={(e) => set('pool', e.target.value)} disabled={!!f.custom.trim()}>
                  <option value="">{t('dCategoryShared')}</option>
                  {pools.map((p) => <option key={p.name} value={p.name}>{p.name}{p.antiVpnEnabled ? ` (${t('dCategoryAntiVpn')})` : ''}</option>)}
                  {f.pool && !pools.some((p) => p.name === f.pool) && <option value={f.pool}>{f.pool}</option>}
                </select>
              </Field>
              <div className="form-grid">
                <Field label={t('dThreads')} error={show('threads')} hint={t('emptyUnlimited')}><input className="input" inputMode="numeric" value={f.threads} onChange={(e) => set('threads', e.target.value)} placeholder="∞" /></Field>
                <Field label={t('dTraffic')} error={show('trafficGb')} hint={t('dTrafficHint')}><input className="input" inputMode="decimal" value={f.trafficGb} onChange={(e) => set('trafficGb', e.target.value)} placeholder="∞" /></Field>
                <Field label={t('dBandwidth')} error={show('bandwidth')} hint={t('emptyUnlimited')}><input className="input" inputMode="numeric" value={f.bandwidth} onChange={(e) => set('bandwidth', e.target.value)} placeholder="∞" /></Field>
                <Field label={t('dExpiresDays')} error={show('expiresDays')} hint={t('emptyNever')}><input className="input" inputMode="numeric" value={f.expiresDays} onChange={(e) => set('expiresDays', e.target.value)} placeholder="∞" /></Field>
                <Field label={t('dCountry')} error={show('country')} hint={t('dCountryHint')}><input className="input" value={f.country} onChange={(e) => set('country', e.target.value)} placeholder="FR,DE" /></Field>
                <Field label={t('dTtl')} error={show('ttl')} hint={t('dTtlHint')}><input className="input" inputMode="numeric" value={f.ttl} onChange={(e) => set('ttl', e.target.value)} placeholder="1800" /></Field>
              </div>
              <div className="form-grid">
                <Field label={t('dAllowedIps')} hint={t('dAllowedIpsHint')}><input className="input" value={f.allowedIps} onChange={(e) => set('allowedIps', e.target.value)} placeholder="*" /></Field>
                <Field label={t('dTags')}><input className="input" value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="residential,fr" /></Field>
              </div>
              <Field label={t('dCustomProxies')} hint={t('dCustomProxiesHint')}><textarea className="input mono" rows={3} value={f.custom} onChange={(e) => set('custom', e.target.value)} placeholder="socks5://user:pass@1.2.3.4:1080" /></Field>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

// ─── Commandes ─────────────────────────────────────────────────────────────────

const ORDER_PAGE = 15;
type StatusFilter = 'all' | OrderStatus;

function OrdersTab({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const { lang, token } = useAddon();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<Order | null>(null);
  const [exporting, setExporting] = useState(false);

  const path = `orders?all=true&limit=${ORDER_PAGE}&offset=${offset}${status !== 'all' ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const { data, loading, error, reload } = useFetch<{ orders: Order[]; total: number }>(path);
  const orders = data?.orders ?? [];
  const total = data?.total ?? 0;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const api = createApi(token, lang);
      const rows: (string | number)[][] = [[t('csv.id'), t('csv.date'), t('csv.customer'), t('csv.items'), t('csv.total'), t('csv.currency'), t('csv.status'), t('csv.payment')]];
      for (let off = 0; off < 5000; off += 200) {
        const r = await api.get<{ orders: Order[]; total: number }>(`orders?all=true&limit=200&offset=${off}${status !== 'all' ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
        for (const o of r.orders) rows.push([o.id, o.created_at, o.user_email || o.user_id, o.items.map((l) => `${l.quantity}x ${l.name}`).join(' | '), o.total, o.currency, o.status, o.payment_method ?? 'wallet']);
        if (off + 200 >= r.total) break;
      }
      downloadFile(`orders-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setOffset(0); }} placeholder={t('searchOrders')} />
        <Seg<StatusFilter>
          label={t('filter')}
          value={status}
          onChange={(v) => { setStatus(v); setOffset(0); }}
          options={[{ id: 'all', label: t('filter.all') }, { id: 'pending', label: t('status.pending.short') }, { id: 'paid', label: t('status.paid') }, { id: 'fulfilled', label: t('status.fulfilled') }, { id: 'cancelled', label: t('status.cancelled') }]}
        />
        <button className="btn btn-outline btn-sm" onClick={exportCsv} disabled={exporting || total === 0}><Icon name="download" size={14} />{t('exportCsv')}</button>
      </div>

      {error && !data ? <ErrorBox message={error} onRetry={reload} /> : loading && !data ? <PageSkeleton rows={5} /> : orders.length === 0 ? (
        <Card><Empty icon="receipt" title={q || status !== 'all' ? t('noResults') : t('noOrdersTitleAdmin')} text={q || status !== 'all' ? t('noResultsText') : t('noOrdersTextAdmin')} /></Card>
      ) : (
        <Card flush>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('order')}</th><th>{t('customer')}</th><th>{t('items')}</th><th className="num">{t('total')}</th><th>{t('payment')}</th><th>{t('status')}</th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => setOpen(o)}>
                    <td><b>{shortId(o.id)}</b><div className="text-xs text-muted">{fmtDateTime(o.created_at, lang)}</div></td>
                    <td><div className="truncate" style={{ maxWidth: 220 }}>{o.user_email || <span className="mono">{o.user_id.slice(0, 12)}…</span>}</div></td>
                    <td className="text-sm"><div className="truncate" style={{ maxWidth: 260 }}>{o.items.map((l) => `${l.quantity}× ${l.name}`).join(', ')}</div></td>
                    <td className="num"><b>{fmtMoney(o.total, o.currency, lang)}</b></td>
                    <td><PaymentBadge method={o.payment_method} /></td>
                    <td><StatusBadge status={o.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={total} limit={ORDER_PAGE} offset={offset} onChange={setOffset} />
        </Card>
      )}

      {open && <OrderDrawer order={open} onClose={() => setOpen(null)} onChanged={() => { reload(); onChanged(); }} />}
    </div>
  );
}

function OrderDrawer({ order: initial, onClose, onChanged }: { order: Order; onClose: () => void; onChanged: () => void }) {
  const t = useT();
  const { lang } = useAddon();
  const api = useApi();
  const [order, setOrder] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmEl] = useConfirm();
  const [refundNote, setRefundNote] = useState(false);

  const change = async (status: OrderStatus) => {
    const cancel = status === 'cancelled';
    const paid = order.status === 'paid' || order.status === 'fulfilled';
    const wallet = (order.payment_method ?? 'wallet') === 'wallet';
    const message = cancel
      ? paid
        ? wallet ? t('confirmCancelWallet', { v: fmtMoney(order.total, order.currency, lang) }) : t('confirmCancelExternal')
        : t('confirmCancelPending')
      : t('confirmFulfill');
    if (!(await confirm({ title: cancel ? (paid ? t('cancelRefund') : t('cancelOrder')) : t('markFulfilled'), message, confirmLabel: cancel ? (paid ? t('cancelRefund') : t('cancelOrder')) : t('markFulfilled'), tone: cancel ? 'danger' : 'primary' }))) return;
    setBusy(true);
    try {
      const r = await api.patch<{ order: Order; manualRefundRequired: boolean }>(`orders/${order.id}/status`, { status });
      setOrder(r.order);
      setRefundNote(r.manualRefundRequired);
      toast.success(t(`status.${status}`));
      onChanged();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal drawer title={<>{t('order')} {shortId(order.id)}</>} onClose={onClose} busy={busy}>
      <div className="stack">
        <div className="row-between"><StatusBadge status={order.status} /><PaymentBadge method={order.payment_method} /></div>
        <Timeline order={order} />
        {refundNote && <Notice tone="warn">{t('manualRefund')}</Notice>}
        <dl className="kv">
          <dt>{t('customer')}</dt><dd>{order.user_email || '—'}<div className="mono text-muted">{order.user_id}</div></dd>
          <dt>{t('date')}</dt><dd>{fmtDateTime(order.created_at, lang)}</dd>
          <dt>{t('updatedAt')}</dt><dd>{fmtDateTime(order.updated_at, lang)}</dd>
          <dt>{t('total')}</dt><dd><b>{fmtMoney(order.total, order.currency, lang)}</b></dd>
        </dl>
        <div>
          <h4 className="section-title">{t('items')}</h4>
          <div className="section-box stack-sm">
            {order.items.map((l, i) => <div key={i} className="row-between text-sm"><span>{l.quantity} × {l.name}</span><b>{fmtMoney(l.unit_price * l.quantity, order.currency, lang)}</b></div>)}
          </div>
        </div>
        {(order.deliveries?.length ?? 0) > 0 && <Credentials deliveries={order.deliveries!} filename={`proxies-${shortId(order.id).slice(1)}.txt`} />}
        <div className="row">
          {order.status === 'paid' && <button className="btn btn-success" onClick={() => void change('fulfilled')} disabled={busy}><Icon name="check" size={14} />{t('markFulfilled')}</button>}
          {order.status !== 'cancelled' && <button className="btn btn-danger" onClick={() => void change('cancelled')} disabled={busy}><Icon name="ban" size={14} />{order.status === 'pending' ? t('cancelOrder') : t('cancelRefund')}</button>}
        </div>
      </div>
      {confirmEl}
    </Modal>
  );
}

// ─── Paiements (lecture seule) ─────────────────────────────────────────────────

function PaymentsTab() {
  const t = useT();
  const wallet = useFetch<{ available: boolean; configured: boolean }>('wallet-status');
  const methods = useFetch<{ stripe: { enabled: boolean }; nowpayments: { enabled: boolean } }>('payments/methods');
  const row = (ok: boolean | undefined, name: string, okText: string, koText: string, icon: 'wallet' | 'card' | 'coins') => (
    <div className="row-between" style={{ padding: '0.7rem 0', borderBottom: '1px solid var(--border)' }}>
      <div className="row gap-3"><span className="avatar"><Icon name={icon} size={16} /></span><div><b>{name}</b><div className="text-xs text-muted">{ok ? okText : koText}</div></div></div>
      {ok === undefined ? <span className="spinner" /> : <Badge tone={ok ? 'good' : 'warn'}>{ok ? t('enabled') : t('disabled')}</Badge>}
    </div>
  );
  return (
    <div className="stack">
      <Notice tone="info">{t('paymentSettingsMovedHint')}</Notice>
      <Card title={t('paymentMethods')}>
        {row(wallet.data ? wallet.data.available && wallet.data.configured : undefined, t('pay.wallet'), t('walletOk'), t('walletNotConfigured'), 'wallet')}
        {row(methods.data?.stripe.enabled, t('pay.stripe'), t('stripeOk'), t('stripeOff'), 'card')}
        {row(methods.data?.nowpayments.enabled, t('pay.nowpayments'), t('cryptoOk'), t('cryptoOff'), 'coins')}
      </Card>
    </div>
  );
}

// Les réglages de passerelles de paiement (Stripe / NOWPayments) vivent dans le panel (Paramètres → Extensions → Boutique) :
// l'API GET/POST /api/payments/settings de cet addon reste la source de vérité, le panel l'appelle via /addon-proxy/orders/…
