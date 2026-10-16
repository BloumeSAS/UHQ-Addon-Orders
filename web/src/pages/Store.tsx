import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useAddon } from '../context';
import { useT } from '../i18n';
import { useApi, useFetch } from '../lib/api';
import { fmtDateTime, fmtMoney } from '../lib/format';
import { Icon } from '../components/icons';
import { Credentials, Order, PayMethod, Product, shortId, StatusBadge, Timeline } from '../components/OrderMeta';
import { Badge, Card, Empty, ErrorBox, Modal, Notice, PageSkeleton, SearchInput, Seg, Tabs } from '../components/ui';

interface Balance { balance: number; currency: string; available: boolean }
interface Methods { wallet: boolean; stripe: { enabled: boolean }; nowpayments: { enabled: boolean } }

type Tab = 'shop' | 'orders';
type Sort = 'recent' | 'priceAsc' | 'priceDesc' | 'name';
type OrderFilter = 'all' | 'active' | 'cancelled';

/** Boutique cliente : catalogue, panier, paiement (Wallet / carte / crypto) et suivi des commandes avec identifiants livrés. */
export default function Store() {
  const { token, lang } = useAddon();
  const t = useT();
  const api = useApi();
  const [params, setParams] = useSearchParams();

  const products = useFetch<{ products: Product[] }>(token ? 'products' : null);
  const orders = useFetch<{ orders: Order[] }>(token ? 'orders' : null);
  const balance = useFetch<Balance>(token ? 'balance' : null);
  const methods = useFetch<Methods>(token ? 'payments/methods' : null);

  const [tab, setTab] = useState<Tab>('shop');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [payWith, setPayWith] = useState<PayMethod>('wallet');
  const [confirming, setConfirming] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [done, setDone] = useState<Order | null>(null);
  const [orderFilter, setOrderFilter] = useState<OrderFilter>('all');

  // Retour d'un paiement externe : la passerelle redirige le navigateur vers CETTE page avec ?payment=success|cancelled.
  // Le paiement est confirmé par webhook côté serveur, indépendamment : ce retour informe seulement l'acheteur.
  useEffect(() => {
    const payment = params.get('payment');
    if (!payment) return;
    if (payment === 'success') { toast.success(t('paymentReceived')); setTab('orders'); }
    else if (payment === 'cancelled') toast.info(t('paymentCancelled'));
    params.delete('payment');
    setParams(params, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Commandes en attente de paiement externe : actualisation automatique tant qu'il en reste.
  const hasPending = (orders.data?.orders ?? []).some((o) => o.status === 'pending');
  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => { orders.reload(); balance.reload(); products.reload(); }, 8000);
    return () => clearInterval(id);
  }, [hasPending]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = products.data?.products ?? [];
  const byId = useMemo(() => new Map(list.map((p) => [p.id, p])), [list]);
  const currency = balance.data?.currency ?? list[0]?.currency ?? 'EUR';

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let r = list.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q));
    r = [...r].sort((a, b) => sort === 'priceAsc' ? a.price - b.price : sort === 'priceDesc' ? b.price - a.price : sort === 'name' ? a.name.localeCompare(b.name) : 0);
    return r;
  }, [list, search, sort]);

  const lines = Object.entries(cart).map(([id, qty]) => ({ product: byId.get(id), qty })).filter((l): l is { product: Product; qty: number } => !!l.product);
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = Math.round(lines.reduce((s, l) => s + l.product.price * l.qty, 0) * 100) / 100;
  const walletDown = !!balance.data && !balance.data.available;
  const bal = balance.data?.available ? balance.data.balance : null;
  const missing = payWith === 'wallet' && bal !== null && total > bal ? Math.round((total - bal) * 100) / 100 : 0;
  const stripeOn = !!methods.data?.stripe.enabled;
  const cryptoOn = !!methods.data?.nowpayments.enabled;

  // Si le Wallet est indisponible mais qu'une autre méthode l'est, on la sélectionne d'office.
  useEffect(() => {
    if (walletDown && payWith === 'wallet') setPayWith(stripeOn ? 'stripe' : cryptoOn ? 'nowpayments' : 'wallet');
  }, [walletDown, stripeOn, cryptoOn]); // eslint-disable-line react-hooks/exhaustive-deps

  const setQty = (p: Product, qty: number) => {
    const max = p.stock === null ? 999 : p.stock;
    const n = Math.max(0, Math.min(max, qty));
    setCart((c) => {
      const next = { ...c };
      if (n <= 0) delete next[p.id]; else next[p.id] = n;
      return next;
    });
  };

  // Un produit retiré / épuisé entre-temps est retiré du panier.
  useEffect(() => {
    setCart((c) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [id, qty] of Object.entries(c)) {
        const p = byId.get(id);
        if (!p || (p.stock !== null && p.stock <= 0)) { changed = true; continue; }
        const q = p.stock === null ? qty : Math.min(qty, p.stock);
        if (q !== qty) changed = true;
        next[id] = q;
      }
      return changed ? next : c;
    });
  }, [byId]);

  const place = async () => {
    const items = lines.map((l) => ({ product_id: l.product.id, quantity: l.qty }));
    if (!items.length) return;
    setPlacing(true);
    try {
      if (payWith === 'wallet') {
        const r = await api.post<{ order: Order }>('orders', { items, paymentMethod: 'wallet' });
        setCart({});
        setConfirming(false);
        setDone(r.order);
        orders.reload(); balance.reload(); products.reload();
        return;
      }
      // Les passerelles refusent d'être affichées dans une iframe (anti-clickjacking) : on redirige le NAVIGATEUR ENTIER.
      const returnBase = window.location.href.split('?')[0];
      const r = await api.post<{ checkoutUrl?: string }>('orders', {
        items,
        paymentMethod: payWith,
        successUrl: `${returnBase}?payment=success`,
        cancelUrl: `${returnBase}?payment=cancelled`,
      });
      if (!r.checkoutUrl) throw new Error(t('paymentUrlMissing'));
      (window.top ?? window).location.href = r.checkoutUrl;
    } catch (e: any) {
      toast.error(e.message);
      products.reload();
    } finally {
      setPlacing(false);
    }
  };

  if (!token) return <div className="page"><Empty icon="key" title={t('noToken')} text={t('noTokenText')} /></div>;
  if ((products.loading && !products.data) || (orders.loading && !orders.data)) return <div className="page"><PageSkeleton /></div>;
  if (products.error && !products.data) return <div className="page"><ErrorBox message={products.error} onRetry={products.reload} /></div>;

  const allOrders = orders.data?.orders ?? [];
  const shownOrders = allOrders.filter((o) => orderFilter === 'all' ? true : orderFilter === 'cancelled' ? o.status === 'cancelled' : o.status !== 'cancelled');
  const pendingCount = allOrders.filter((o) => o.status === 'pending').length;

  return (
    <div className="page stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('store')}</h1>
          <p className="page-sub">{t('storeSub')}</p>
        </div>
        {balance.data?.available && (
          <div className="card card-sm row gap-3" style={{ flexWrap: 'nowrap' }}>
            <span className="avatar"><Icon name="wallet" size={16} /></span>
            <div>
              <div className="stat-label" style={{ marginBottom: 0 }}>{t('myBalance')}</div>
              <div className="text-bold" style={{ fontSize: '1.05rem' }}>{fmtMoney(balance.data.balance, balance.data.currency, lang)}</div>
            </div>
          </div>
        )}
      </div>

      {walletDown && <Notice tone="warn">{stripeOn || cryptoOn ? t('walletDownAlt') : t('walletRequired')}</Notice>}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'shop', label: t('catalog'), icon: 'store' },
          { id: 'orders', label: t('myOrders'), icon: 'receipt', count: pendingCount || undefined },
        ]}
      />

      {tab === 'shop' && (
        <div className="two-col">
          <div className="stack">
            {list.length > 0 && (
              <div className="row">
                <SearchInput value={search} onChange={setSearch} placeholder={t('searchProducts')} />
                <select className="input" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t('sortBy')}>
                  <option value="recent">{t('sort.recent')}</option>
                  <option value="priceAsc">{t('sort.priceAsc')}</option>
                  <option value="priceDesc">{t('sort.priceDesc')}</option>
                  <option value="name">{t('sort.name')}</option>
                </select>
              </div>
            )}

            {list.length === 0 ? (
              <Card><Empty icon="store" title={t('emptyShopTitle')} text={t('emptyShopText')} /></Card>
            ) : visible.length === 0 ? (
              <Card><Empty icon="search" title={t('noResults')} text={t('noResultsText')} action={<button className="btn btn-outline btn-sm" onClick={() => setSearch('')}>{t('resetFilters')}</button>} /></Card>
            ) : (
              <div className="product-grid">
                {visible.map((p) => {
                  const qty = cart[p.id] ?? 0;
                  const soldOut = p.stock !== null && p.stock <= 0;
                  const low = p.stock !== null && p.stock > 0 && p.stock <= 5;
                  return (
                    <article key={p.id} className={`card product ${qty > 0 ? 'in-cart' : ''}`}>
                      <div className="row-between" style={{ alignItems: 'flex-start' }}>
                        <div className="product-icon"><Icon name={p.delivery?.mode === 'panel_account' ? 'zap' : 'package'} size={20} /></div>
                        {soldOut ? <Badge tone="bad">{t('outOfStock')}</Badge> : low ? <Badge tone="warn">{t('lastUnits', { n: p.stock })}</Badge> : p.delivery?.mode === 'panel_account' ? <Badge tone="good" icon="zap">{t('instantDelivery')}</Badge> : null}
                      </div>
                      <div>
                        <h3 className="product-name">{p.name}</h3>
                        <p className="product-desc" style={{ marginTop: 4 }}>{p.description || t('noDescription')}</p>
                      </div>
                      <div className="row-between">
                        <span className="product-price">{fmtMoney(p.price, p.currency, lang)}</span>
                        {qty > 0 ? (
                          <div className="stepper" role="group" aria-label={p.name}>
                            <button onClick={() => setQty(p, qty - 1)} aria-label={`${t('decrease')} ${p.name}`}>−</button>
                            <span aria-live="polite">{qty}</span>
                            <button onClick={() => setQty(p, qty + 1)} disabled={p.stock !== null && qty >= p.stock} aria-label={`${t('increase')} ${p.name}`}>+</button>
                          </div>
                        ) : (
                          <button className="btn btn-primary" disabled={soldOut} onClick={() => setQty(p, 1)}><Icon name="plus" size={14} />{t('addToCart')}</button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {/* Panier */}
          <aside className="cart-panel">
            <Card title={<span className="row gap-2"><Icon name="cart" size={16} />{t('cart')}{count > 0 && <Badge tone="primary">{count}</Badge>}</span>}>
              {lines.length === 0 ? (
                <div className="text-sm text-muted" style={{ padding: '0.8rem 0' }}>{t('emptyCart')}<br />{t('emptyCartHint')}</div>
              ) : (
                <div className="stack-sm">
                  <div>
                    {lines.map(({ product: p, qty }) => (
                      <div key={p.id} className="cart-line">
                        <div className="grow">
                          <div className="text-bold truncate">{p.name}</div>
                          <div className="text-xs text-muted">{qty} × {fmtMoney(p.price, p.currency, lang)}</div>
                        </div>
                        <b className="num">{fmtMoney(p.price * qty, p.currency, lang)}</b>
                        <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setQty(p, 0)} aria-label={`${t('remove')} ${p.name}`}><Icon name="trash" size={14} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="row-between"><span className="text-muted">{t('total')}</span><b style={{ fontSize: '1.25rem' }}>{fmtMoney(total, currency, lang)}</b></div>

                  {(stripeOn || cryptoOn) && (
                    <div className="stack-sm" role="radiogroup" aria-label={t('payWith')}>
                      <div className="label">{t('payWith')}</div>
                      <button type="button" role="radio" aria-checked={payWith === 'wallet'} className={`pay-option ${payWith === 'wallet' ? 'active' : ''}`} disabled={walletDown} onClick={() => setPayWith('wallet')}>
                        <span className="pay-radio" /><Icon name="wallet" size={17} /><span className="grow"><b>{t('pay.wallet')}</b><div className="text-xs text-muted">{bal !== null ? t('available', { v: fmtMoney(bal, currency, lang) }) : t('unavailable')}</div></span>
                      </button>
                      {stripeOn && (
                        <button type="button" role="radio" aria-checked={payWith === 'stripe'} className={`pay-option ${payWith === 'stripe' ? 'active' : ''}`} onClick={() => setPayWith('stripe')}>
                          <span className="pay-radio" /><Icon name="card" size={17} /><span className="grow"><b>{t('pay.stripe')}</b><div className="text-xs text-muted">{t('redirectSecure')}</div></span>
                        </button>
                      )}
                      {cryptoOn && (
                        <button type="button" role="radio" aria-checked={payWith === 'nowpayments'} className={`pay-option ${payWith === 'nowpayments' ? 'active' : ''}`} onClick={() => setPayWith('nowpayments')}>
                          <span className="pay-radio" /><Icon name="coins" size={17} /><span className="grow"><b>{t('pay.nowpayments')}</b><div className="text-xs text-muted">{t('redirectSecure')}</div></span>
                        </button>
                      )}
                    </div>
                  )}

                  {payWith === 'wallet' && bal !== null && (
                    <div className="section-box text-sm">
                      <div className="row-between"><span className="text-muted">{t('myBalance')}</span><b>{fmtMoney(bal, currency, lang)}</b></div>
                      <div className="row-between mt-1"><span className="text-muted">{t('afterOrder')}</span><b className={missing ? 'text-red' : ''}>{fmtMoney(bal - total, currency, lang)}</b></div>
                    </div>
                  )}
                  {missing > 0 && <Notice tone="error">{t('missingFunds', { v: fmtMoney(missing, currency, lang) })}</Notice>}

                  <button className="btn btn-primary btn-lg btn-block" onClick={() => setConfirming(true)} disabled={placing || missing > 0 || (payWith === 'wallet' && walletDown)}>
                    {t('orderNow')} — {fmtMoney(total, currency, lang)}
                  </button>
                  <button className="btn btn-ghost btn-sm btn-block" onClick={() => setCart({})}>{t('clearCart')}</button>
                </div>
              )}
            </Card>
          </aside>
        </div>
      )}

      {tab === 'orders' && (
        <div className="stack">
          {allOrders.length > 0 && (
            <div className="row-between">
              <Seg<OrderFilter> label={t('filter')} value={orderFilter} onChange={setOrderFilter} options={[{ id: 'all', label: t('filter.all') }, { id: 'active', label: t('filter.active') }, { id: 'cancelled', label: t('filter.cancelled') }]} />
              <button className="btn btn-outline btn-sm" onClick={() => { orders.reload(); balance.reload(); }}><Icon name="refresh" size={14} />{t('ui.refresh')}</button>
            </div>
          )}
          {pendingCount > 0 && <Notice tone="info">{t('pendingNotice')}</Notice>}

          {allOrders.length === 0 ? (
            <Card>
              <Empty icon="receipt" title={t('noOrdersTitle')} text={t('noOrdersText')} action={<button className="btn btn-primary" onClick={() => setTab('shop')}><Icon name="store" size={15} />{t('browseShop')}</button>} />
            </Card>
          ) : shownOrders.length === 0 ? (
            <Card><Empty icon="search" title={t('noResults')} /></Card>
          ) : (
            shownOrders.map((o) => (
              <article key={o.id} className="card order-card">
                <div className="order-head">
                  <div>
                    <b>{shortId(o.id)}</b>
                    <span className="text-muted text-sm"> · {fmtDateTime(o.created_at, lang)}</span>
                  </div>
                  <div className="row"><StatusBadge status={o.status} /><b>{fmtMoney(o.total, o.currency, lang)}</b></div>
                </div>
                <div className="order-body stack-sm">
                  <ul style={{ listStyle: 'none' }}>
                    {o.items.map((l, i) => (
                      <li key={i} className="row-between text-sm" style={{ padding: '0.15rem 0' }}>
                        <span>{l.quantity} × {l.name}</span>
                        <span className="text-muted">{fmtMoney(l.unit_price * l.quantity, o.currency, lang)}</span>
                      </li>
                    ))}
                  </ul>
                  <Timeline order={o} />
                  {o.status === 'pending' && <Notice tone="info" icon="clock">{t('pendingOne')}</Notice>}
                  {o.status === 'cancelled' && <div className="text-sm text-muted">{t('cancelledNote')}</div>}
                  {(o.deliveries?.length ?? 0) > 0 && o.status !== 'cancelled' && <Credentials deliveries={o.deliveries!} filename={`proxies-${shortId(o.id).slice(1)}.txt`} />}
                </div>
              </article>
            ))
          )}
        </div>
      )}

      {confirming && (
        <Modal
          title={t('confirmOrder')}
          onClose={() => setConfirming(false)}
          busy={placing}
          footer={
            <>
              <button className="btn btn-outline" onClick={() => setConfirming(false)} disabled={placing}>{t('ui.cancel')}</button>
              <button className="btn btn-primary" onClick={place} disabled={placing}>{placing ? '…' : payWith === 'wallet' ? t('payNow', { v: fmtMoney(total, currency, lang) }) : t('goToPayment')}</button>
            </>
          }
        >
          <div className="stack-sm">
            {lines.map(({ product: p, qty }) => (
              <div key={p.id} className="row-between text-sm"><span>{qty} × {p.name}</span><b>{fmtMoney(p.price * qty, p.currency, lang)}</b></div>
            ))}
            <div className="row-between" style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem' }}><b>{t('total')}</b><b style={{ fontSize: '1.15rem' }}>{fmtMoney(total, currency, lang)}</b></div>
            <Notice tone="info">{payWith === 'wallet' ? t('confirmWalletText', { v: fmtMoney(total, currency, lang) }) : t('confirmExternalText')}</Notice>
            {lines.some((l) => l.product.delivery?.mode === 'panel_account') && <div className="text-xs text-muted">{t('autoDeliveryNote')}</div>}
          </div>
        </Modal>
      )}

      {done && (
        <Modal title={t('orderDoneTitle')} onClose={() => setDone(null)} footer={<><button className="btn btn-outline" onClick={() => { setDone(null); setTab('orders'); }}>{t('viewOrders')}</button><button className="btn btn-primary" onClick={() => setDone(null)}>{t('ui.close')}</button></>}>
          <div className="stack-sm">
            <Notice tone="success">{t('orderDoneText', { id: shortId(done.id), v: fmtMoney(done.total, done.currency, lang) })}</Notice>
            {(done.deliveries?.length ?? 0) > 0 ? <Credentials deliveries={done.deliveries!} filename={`proxies-${shortId(done.id).slice(1)}.txt`} /> : <div className="text-sm text-muted">{t('noAutoDelivery')}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
