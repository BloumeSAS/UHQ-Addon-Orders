import {
  Injectable, Logger, BadRequestException, NotFoundException, ServiceUnavailableException, ForbiddenException, OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StoreService, ProductRecord, OrderRecord, OrderItem, OrderStatus, PaymentMethod,
  DeliveryConfig, DeliveredAccount, DeliveryAccount, ExpiresUnit, PaymentEvent,
} from './store.service';
import { WalletClient } from './wallet.client';
import { PanelClient, CreateSubUserSpec } from './panel.client';
import { PaymentsService } from './payments/payments.service';
import { CreateProductDto, UpdateProductDto, OrderItemDto } from './dto/orders.dto';

/**
 * Transitions de statut autorisées (jamais de retour en arrière : une commande annulée est définitive).
 * 'review' = payée, en attente de validation par un admin (aucun compte créé) ; 'review' → 'paid' = validation (livraison).
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['cancelled'],
  review: ['paid', 'cancelled'],
  paid: ['fulfilled', 'cancelled'],
  fulfilled: ['cancelled'],
  cancelled: [],
};

const PAID_STATES: OrderStatus[] = ['review', 'paid', 'fulfilled'];
const RENEWAL_GRACE_MS = 72 * 3600_000;
const DAY_MS = 86_400_000;

export interface OrderQuery {
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

/** Ajoute `value` jours / mois / années (UTC) ; les mois courts sont respectés (31 janvier + 1 mois = 28/29 février). */
export function addPeriod(from: Date, value: number, unit: ExpiresUnit): Date {
  if (unit === 'day') return new Date(from.getTime() + value * DAY_MS);
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (unit === 'year' ? value * 12 : value));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);
  private maintenanceRunning = false;
  /** Commandes en cours de livraison (confirmation de paiement / validation) : un second événement simultané est ignoré, jamais livré deux fois. */
  private readonly delivering = new Set<string>();

  constructor(
    private readonly store: StoreService,
    private readonly wallet: WalletClient,
    private readonly panel: PanelClient,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * Tâches de fond :
   *  - rattachement des comptes livrés avant la v1.3.1 à leur acheteur (« Mes proxies ») ;
   *  - renouvellements automatiques arrivés à échéance (solde Wallet) ;
   *  - annulation des commandes PayPal non payées dans le délai (stock rendu).
   */
  onModuleInit() {
    const owners = () => void this.repairOwners().catch((e) => this.logger.warn(`Réparation des propriétaires : ${e?.message ?? e}`));
    setTimeout(owners, 20_000).unref();
    setInterval(owners, 15 * 60_000).unref();
    const maintenance = () => void this.runMaintenance().catch((e) => this.logger.warn(`Maintenance : ${e?.message ?? e}`));
    setTimeout(maintenance, 60_000).unref();
    setInterval(maintenance, 30 * 60_000).unref();
  }

  async runMaintenance(): Promise<void> {
    if (this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      this.expirePaypalOrders();
      await this.runRenewals();
    } finally {
      this.maintenanceRunning = false;
    }
  }

  // ─── Réparation des propriétaires ────────────────────────────────────────────

  private async repairOwners(): Promise<void> {
    if (!this.panel.isConfigured()) return;
    let fixed = 0;
    for (const order of this.store.orders) {
      if (order.status !== 'paid' && order.status !== 'fulfilled') continue;
      let changed = false;
      for (const d of order.deliveries ?? []) {
        if (d.owner_linked || !d.panel_user_id) continue;
        try {
          await this.panel.setOwner(d.panel_user_id, order.user_id);
          d.owner_linked = true;
          changed = true;
          fixed += 1;
        } catch (err: any) {
          // Compte supprimé côté panel : plus rien à rattacher. Autre erreur : on réessaiera plus tard.
          if (/not found|introuvable/i.test(String(err?.message ?? ''))) { d.owner_linked = true; changed = true; }
          else this.logger.debug(`Rattachement du compte ${d.username} impossible pour l'instant : ${err?.message ?? err}`);
        }
      }
      if (changed) this.store.setOrder(order);
    }
    if (fixed > 0) this.logger.log(`${fixed} compte(s) livré(s) rattaché(s) à leur acheteur (visibles dans « Mes proxies »).`);
  }

  // ─── Produits ────────────────────────────────────────────────────────────────

  /** Normalise une config de livraison entrante (défaut : aucune livraison). */
  private normalizeDelivery(input: any): DeliveryConfig {
    if (!input || input.mode !== 'panel_account') return { mode: 'none' };
    const a = input.account ?? {};
    const custom = a.custom_proxies?.trim() || undefined;
    const unit: ExpiresUnit = a.expires_unit === 'month' || a.expires_unit === 'year' ? a.expires_unit : 'day';
    return {
      mode: 'panel_account',
      approval: input.approval === 'manual' ? 'manual' : 'auto',
      account: {
        threads_limit: a.threads_limit,
        traffic_limit_bytes: a.traffic_limit_bytes,
        country_filter: a.country_filter?.trim() || undefined,
        sticky_session_ttl: a.sticky_session_ttl,
        bandwidth_limit: a.bandwidth_limit,
        expires_days: a.expires_days,
        expires_unit: a.expires_days ? unit : undefined,
        allowed_ips: a.allowed_ips?.trim() || undefined,
        tags: a.tags?.trim() || undefined,
        custom_proxies: custom,
        // Une liste privée prime : la catégorie serait ignorée par le panel, on ne la conserve pas.
        pool: custom ? undefined : a.pool?.trim() || undefined,
      },
    };
  }

  /** Catégories (ProxyPool) déclarées sur le panel — pour le sélecteur de livraison. */
  async listPools() {
    if (!this.panel.isConfigured()) return [];
    try {
      return await this.panel.listPools();
    } catch (err: any) {
      this.logger.warn(`Impossible de lister les pools panel : ${err?.message}`);
      return [];
    }
  }

  /** Refuse une catégorie inexistante (sinon chaque commande échouerait à la livraison puis serait remboursée). */
  private async assertPoolExists(delivery: DeliveryConfig): Promise<void> {
    const pool = delivery.account?.pool;
    if (delivery.mode !== 'panel_account' || !pool) return;
    if (!this.panel.isConfigured()) return;
    let pools: { name: string }[];
    try {
      pools = await this.panel.listPools();
    } catch {
      return; // panel injoignable : on ne bloque pas l'enregistrement du produit
    }
    if (!pools.some((p) => p.name === pool)) {
      throw new BadRequestException(`Catégorie introuvable sur le panel : « ${pool} »`);
    }
  }

  /** Le renouvellement exige une livraison automatique avec une durée de validité (sinon il n'y a rien à renouveler). */
  private assertRenewalPossible(renewal: boolean | undefined, delivery: DeliveryConfig): void {
    if (!renewal) return;
    if (delivery.mode !== 'panel_account' || !(Number(delivery.account?.expires_days) > 0)) {
      throw new BadRequestException('Le renouvellement automatique nécessite une livraison « compte proxy » avec une durée de validité.');
    }
  }

  listProducts(includeInactive = false): ProductRecord[] {
    const all = Object.values(this.store.products)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return includeInactive ? all : all.filter((p) => p.active);
  }

  /**
   * Vue publique d'un produit (clients) : JAMAIS la configuration de livraison détaillée — elle contient les listes de
   * proxies privés de l'administrateur (avec identifiants) et les réglages internes. On n'expose que les caractéristiques
   * commerciales (`specs`) : 0 / absent = illimité.
   */
  toPublic(p: ProductRecord) {
    const a = p.delivery?.account;
    const auto = p.delivery?.mode === 'panel_account';
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      currency: p.currency,
      stock: p.stock,
      active: p.active,
      delivery: { mode: p.delivery?.mode ?? 'none' },
      renewal_enabled: !!p.renewal_enabled,
      specs: auto
        ? {
            threads_limit: a?.threads_limit ?? 0,
            traffic_limit_bytes: a?.traffic_limit_bytes ?? 0,
            bandwidth_limit: a?.bandwidth_limit ?? 0,
            expires_value: a?.expires_days ?? 0,
            expires_unit: a?.expires_unit ?? 'day',
            country_filter: a?.country_filter ?? '',
            sticky_session_ttl: a?.sticky_session_ttl ?? 0,
            manual_approval: p.delivery?.approval === 'manual',
          }
        : null,
    };
  }

  async createProduct(dto: CreateProductDto): Promise<ProductRecord> {
    const delivery = this.normalizeDelivery(dto.delivery);
    await this.assertPoolExists(delivery);
    this.assertRenewalPossible(dto.renewal_enabled, delivery);
    const now = new Date().toISOString();
    const product: ProductRecord = {
      id:          randomUUID(),
      name:        dto.name.trim(),
      description: dto.description?.trim() || null,
      price:       parseFloat(dto.price.toFixed(2)),
      currency:    (dto.currency || 'EUR').toUpperCase(),
      stock:       dto.stock === undefined || dto.stock === null ? null : dto.stock,
      active:      dto.active ?? true,
      delivery,
      renewal_enabled: !!dto.renewal_enabled,
      created_at:  now,
      updated_at:  now,
    };
    this.store.setProduct(product);
    return product;
  }

  async updateProduct(id: string, dto: UpdateProductDto): Promise<ProductRecord> {
    const product = this.store.products[id];
    if (!product) throw new NotFoundException('Produit introuvable');

    const delivery = dto.delivery !== undefined ? this.normalizeDelivery(dto.delivery) : undefined;
    if (delivery) await this.assertPoolExists(delivery);
    const renewal = dto.renewal_enabled !== undefined ? dto.renewal_enabled : product.renewal_enabled;
    this.assertRenewalPossible(renewal, delivery ?? product.delivery);

    if (dto.name !== undefined) product.name = dto.name.trim();
    if (dto.description !== undefined) product.description = dto.description.trim() || null;
    if (dto.price !== undefined) product.price = parseFloat(dto.price.toFixed(2));
    if (dto.currency !== undefined) product.currency = dto.currency.toUpperCase();
    if (dto.stock !== undefined) product.stock = dto.stock; // null = illimité
    if (dto.active !== undefined) product.active = dto.active;
    if (delivery) product.delivery = delivery;
    if (dto.renewal_enabled !== undefined) product.renewal_enabled = !!dto.renewal_enabled;
    // Une livraison sans durée de validité ne peut plus être renouvelée.
    if (product.renewal_enabled && !(product.delivery.mode === 'panel_account' && Number(product.delivery.account?.expires_days) > 0)) product.renewal_enabled = false;
    product.updated_at = new Date().toISOString();

    this.store.setProduct(product);
    return product;
  }

  deleteProduct(id: string): void {
    if (!this.store.products[id]) throw new NotFoundException('Produit introuvable');
    this.store.deleteProduct(id);
  }

  // ─── Commandes (lecture) ─────────────────────────────────────────────────────

  userOrders(userId: string): OrderRecord[] {
    return this.store.orders
      .filter((o) => o.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** Toutes les commandes (admin), filtrées par statut / recherche (client, produit, id) et paginées si `limit` est fourni. */
  queryOrders(query: OrderQuery): { orders: OrderRecord[]; total: number } {
    let list = [...this.store.orders].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (query.status && ['pending', 'review', 'paid', 'fulfilled', 'cancelled'].includes(query.status)) {
      list = list.filter((o) => o.status === query.status);
    }
    const q = (query.q ?? '').trim().toLowerCase();
    if (q) {
      list = list.filter((o) =>
        o.id.toLowerCase().includes(q) ||
        o.user_id.toLowerCase().includes(q) ||
        (o.user_email ?? '').toLowerCase().includes(q) ||
        (o.paypal?.note ?? '').toLowerCase().includes(q) ||
        (o.invoice_number ?? '').toLowerCase().includes(q) ||
        o.items.some((l) => l.name.toLowerCase().includes(q)),
      );
    }
    const total = list.length;
    if (query.limit) {
      const limit = Math.max(1, Math.min(200, Math.floor(query.limit)));
      const offset = Math.max(0, Math.floor(query.offset ?? 0));
      list = list.slice(offset, offset + limit);
    }
    return { orders: list, total };
  }

  /** Commandes payées en attente de validation d'un admin, vues par leur propriétaire (« Mes proxies » du panel) : AUCUNE information d'accès. */
  pendingApprovals(userId: string) {
    return this.store.orders
      .filter((o) => o.user_id === userId && o.status === 'review')
      .map((o) => ({
        order_id: o.id,
        created_at: o.created_at,
        items: o.items
          .filter((l) => (l.snapshot?.delivery ?? this.store.products[l.product_id]?.delivery)?.mode === 'panel_account')
          .map((l) => ({ name: l.name, quantity: l.quantity })),
      }))
      .filter((o) => o.items.length > 0);
  }

  /** Indicateurs de l'accueil admin et du widget (le widget ne télécharge plus toutes les commandes). */
  stats() {
    const orders = this.store.orders;
    const counted = orders.filter((o) => PAID_STATES.includes(o.status));
    const products = Object.values(this.store.products);
    const month = new Date().toISOString().slice(0, 7);
    // Chiffre d'affaires = encaissements réels (paiement initial + renouvellements).
    const events = counted.flatMap((o) => (o.payments?.length ? o.payments : [{ amount: o.total, at: o.created_at } as PaymentEvent]));
    return {
      orders: orders.length,
      pending: orders.filter((o) => o.status === 'pending').length,
      toApprove: orders.filter((o) => o.status === 'review').length,
      toFulfill: orders.filter((o) => o.status === 'paid').length,
      revenue: parseFloat(events.reduce((s, e) => s + e.amount, 0).toFixed(2)),
      revenueMonth: parseFloat(events.filter((e) => e.at.startsWith(month)).reduce((s, e) => s + e.amount, 0).toFixed(2)),
      currency: orders[0]?.currency ?? products[0]?.currency ?? 'EUR',
      activeProducts: products.filter((p) => p.active).length,
      lowStock: products.filter((p) => p.active && p.stock !== null && p.stock <= 3).length,
      renewals: orders.reduce((n, o) => n + (o.deliveries ?? []).filter((d) => d.renew && d.renewal).length, 0),
    };
  }

  // ─── Wallet ──────────────────────────────────────────────────────────────────

  async walletStatus(): Promise<{ available: boolean; configured: boolean }> {
    return {
      available:  await this.wallet.isAvailable(),
      configured: this.wallet.isConfigured(),
    };
  }

  async getUserBalance(userId: string): Promise<{ balance: number; currency: string; available: boolean }> {
    if (!(await this.wallet.isAvailable())) {
      return { balance: 0, currency: 'EUR', available: false };
    }
    const { balance, currency } = await this.wallet.getBalance(userId);
    return { balance, currency, available: true };
  }

  // ─── Checkout ────────────────────────────────────────────────────────────────

  /** Résout + valide les lignes du panier — partagé par toutes les méthodes de paiement. */
  private resolveLines(items: OrderItemDto[]): { lines: OrderItem[]; total: number; currency: string; needsPanelDelivery: boolean; needsApproval: boolean } {
    if (!items?.length) throw new BadRequestException('Panier vide');

    // Une même référence peut apparaître deux fois : on cumule les quantités (le stock est contrôlé sur le total).
    const merged = new Map<string, number>();
    for (const item of items) merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + Math.floor(item.quantity));

    const lines: OrderItem[] = [];
    let currency = '';
    let needsPanelDelivery = false;
    let needsApproval = false;
    for (const [productId, qty] of merged) {
      const product = this.store.products[productId];
      if (!product || !product.active) {
        throw new BadRequestException(`Produit indisponible : ${productId}`);
      }
      if (qty < 1) throw new BadRequestException('Quantité invalide');
      if (product.stock !== null && product.stock < qty) {
        throw new BadRequestException(`Stock insuffisant : ${product.name}`);
      }
      if (currency && product.currency !== currency) {
        throw new BadRequestException('Le panier mélange plusieurs devises : passez commande séparément.');
      }
      if (product.delivery?.mode === 'panel_account') {
        needsPanelDelivery = true;
        if (product.delivery.approval === 'manual') needsApproval = true;
      }
      currency = product.currency;
      lines.push({
        product_id: product.id, name: product.name, unit_price: product.price, quantity: qty,
        // Configuration FIGÉE à la commande : la livraison (même validée plus tard) et les renouvellements l'utilisent,
        // jamais la configuration que le produit aurait à ce moment-là.
        snapshot: { delivery: JSON.parse(JSON.stringify(product.delivery ?? { mode: 'none' })), renewal_enabled: !!product.renewal_enabled },
      });
    }

    const total = parseFloat(lines.reduce((s, l) => s + l.unit_price * l.quantity, 0).toFixed(2));
    if (total <= 0) throw new BadRequestException('Montant de commande invalide');

    if (needsPanelDelivery && !this.panel.isConfigured()) {
      throw new ServiceUnavailableException(
        'Livraison automatique indisponible (PANEL_URL / PANEL_API_KEY non configurés)',
      );
    }
    return { lines, total, currency, needsPanelDelivery, needsApproval };
  }

  /**
   * Réserve le stock IMMÉDIATEMENT (de façon synchrone, avant tout `await`) : deux commandes simultanées ne peuvent plus
   * acheter la même dernière unité (le contrôle et la décrémentation étaient séparés par des appels réseau).
   */
  private reserveStock(lines: OrderItem[]): void {
    for (const l of lines) {
      const product = this.store.products[l.product_id];
      if (product && product.stock !== null) {
        product.stock = Math.max(0, product.stock - l.quantity);
        product.updated_at = new Date().toISOString();
        this.store.setProduct(product);
      }
    }
  }

  private releaseStock(lines: OrderItem[]): void {
    for (const l of lines) {
      const product = this.store.products[l.product_id];
      if (product && product.stock !== null) {
        product.stock += l.quantity;
        product.updated_at = new Date().toISOString();
        this.store.setProduct(product);
      }
    }
  }

  /**
   * Point d'entrée unique du checkout : 4 méthodes de paiement.
   *  - 'wallet' : débit synchrone ; livraison immédiate (commande 'paid') ou, si un produit exige une validation manuelle,
   *    commande 'review' (payée, en attente d'un admin — aucun compte créé).
   *  - 'stripe' / 'nowpayments' / 'paypal' : commande 'pending' (stock réservé, jamais débitée ni livrée) ; la confirmation
   *    arrive par webhook / IPN (confirmExternalPayment) qui livre, ou met en 'review'.
   * `renew` : le client active le renouvellement automatique des produits qui le proposent.
   */
  async checkout(
    user: { id: string; email: string },
    items: OrderItemDto[],
    method: PaymentMethod = 'wallet',
    successUrl?: string,
    cancelUrl?: string,
    renew = false,
  ): Promise<{ order: OrderRecord; checkoutUrl?: string }> {
    const { lines, total, currency, needsApproval } = this.resolveLines(items);
    const note = `Commande : ${lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')}`.slice(0, 180);

    if (method === 'stripe' || method === 'nowpayments') {
      if (!successUrl || !cancelUrl) throw new BadRequestException('successUrl/cancelUrl requis pour ce mode de paiement');
      for (const u of [successUrl, cancelUrl]) {
        let parsed: URL;
        try {
          parsed = new URL(u);
        } catch {
          throw new BadRequestException('URL de retour invalide');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new BadRequestException('URL de retour invalide');
      }
    }
    if (method === 'wallet' && !(await this.wallet.isAvailable())) {
      throw new ServiceUnavailableException('Addon Wallet requis pour ce mode de paiement');
    }
    const paypalReceiver = method === 'paypal' ? this.payments.paypalReceiver() : '';

    // Le stock est (re)contrôlé ET réservé sans point d'attente entre les deux.
    for (const l of lines) {
      const p = this.store.products[l.product_id];
      if (!p || !p.active || (p.stock !== null && p.stock < l.quantity)) {
        throw new BadRequestException(`Stock insuffisant : ${l.name}`);
      }
    }
    this.reserveStock(lines);

    if (method === 'wallet') {
      try {
        await this.wallet.debit(user.id, total, note);
      } catch (err) {
        this.releaseStock(lines);
        throw err;
      }

      const order = this.buildOrder(user, lines, total, currency, note, 'wallet', needsApproval ? 'review' : 'paid', [], renew);
      if (!needsApproval) {
        try {
          order.deliveries = await this.deliver(order);
        } catch (err: any) {
          this.releaseStock(lines);
          this.logger.error(`Livraison échouée — remboursement de ${total} ${currency}: ${err?.message}`);
          try {
            await this.wallet.credit(user.id, total, `Remboursement (échec livraison) — ${note}`);
          } catch (refundErr: any) {
            this.logger.error(`ÉCHEC du remboursement après livraison ratée: ${refundErr?.message}`);
          }
          throw new ServiceUnavailableException(
            `Paiement remboursé : la livraison a échoué (${err?.message ?? 'erreur inconnue'})`,
          );
        }
      }
      this.recordPayment(order, 'initial', 'wallet', total, note);
      this.store.addOrder(order);
      return { order };
    }

    // Paiement externe : commande 'pending', pas de débit, pas de livraison (webhook / IPN).
    const order = this.buildOrder(user, lines, total, currency, note, method, 'pending', [], renew);
    try {
      if (method === 'paypal') {
        let ref = this.payments.newPaypalReference();
        while (this.store.orders.some((o) => o.paypal?.note === ref)) ref = this.payments.newPaypalReference();
        order.paypal = { email: paypalReceiver, note: ref };
        order.payment_ref = ref;
        this.store.addOrder(order);
        return { order };
      }
      const checkoutUrl = method === 'stripe'
        ? await this.payments.createStripeCheckout(order, successUrl!, cancelUrl!)
        : await this.payments.createNowPayment(order, successUrl!, cancelUrl!);
      this.store.addOrder(order); // ajouté après coup pour inclure payment_ref posé par payments.*
      return { order, checkoutUrl };
    } catch (err) {
      this.releaseStock(lines);
      throw err;
    }
  }

  private buildOrder(
    user: { id: string; email: string }, lines: OrderItem[], total: number, currency: string, note: string,
    method: PaymentMethod, status: OrderStatus, deliveries: DeliveredAccount[], renew: boolean,
  ): OrderRecord {
    const now = new Date().toISOString();
    return {
      id: randomUUID(), user_id: user.id, user_email: user.email || undefined, stock_reserved: true,
      items: lines, total, currency, status, note, renew,
      payment_method: method, deliveries, created_at: now, updated_at: now,
    };
  }

  /** Enregistre un encaissement et lui attribue un numéro de facture si la facturation est activée. */
  private recordPayment(order: OrderRecord, kind: 'initial' | 'renewal', method: PaymentMethod, amount: number, description: string): PaymentEvent {
    const ev: PaymentEvent = {
      id: kind === 'initial' ? 'initial' : randomUUID(), kind, amount, currency: order.currency, at: new Date().toISOString(), method, description,
    };
    if (this.store.invoiceSettings.enabled) ev.invoice_number = this.store.nextInvoiceNumber();
    order.payments = [...(order.payments ?? []), ev];
    if (kind === 'initial' && ev.invoice_number) order.invoice_number = ev.invoice_number;
    return ev;
  }

  /**
   * Appelé quand un paiement externe est confirmé (webhook Stripe/NOWPayments, IPN PayPal) : livre (ou met en validation
   * manuelle) puis marque la commande. Idempotent : une commande déjà traitée est ignorée (un webhook peut être renvoyé).
   */
  async confirmExternalPayment(orderId: string): Promise<OrderRecord | null> {
    const order = this.store.orders.find((o) => o.id === orderId);
    if (!order) {
      this.logger.warn(`Webhook pour une commande inconnue : ${orderId}`);
      return null;
    }
    if (order.status !== 'pending') return order; // déjà traité
    if (this.delivering.has(order.id)) return order; // un autre événement la traite en ce moment
    this.delivering.add(order.id);
    try {
      const needsApproval = this.orderNeedsApproval(order);
      if (!needsApproval) {
        try {
          order.deliveries = await this.deliver(order);
        } catch (err: any) {
          this.logger.error(`Livraison échouée après paiement externe confirmé (commande ${order.id}) : ${err?.message}`);
          // Paiement déjà encaissé par la passerelle : reste 'pending' (le fournisseur réessaiera) ;
          // intervention manuelle (remboursement chez le fournisseur) si l'échec persiste.
          throw err;
        }
      }
      // Commandes d'avant la v1.3.0 : le stock n'était pas réservé à la création.
      if (order.stock_reserved !== true) this.reserveStock(order.items);
      order.stock_reserved = true;
      order.status = needsApproval ? 'review' : 'paid';
      this.recordPayment(order, 'initial', order.payment_method, order.total, order.note ?? '');
      order.updated_at = new Date().toISOString();
      this.store.setOrder(order);
      return order;
    } finally {
      this.delivering.delete(order.id);
    }
  }

  private orderNeedsApproval(order: OrderRecord): boolean {
    return order.items.some((l) => {
      const d = l.snapshot?.delivery ?? this.store.products[l.product_id]?.delivery;
      return d?.mode === 'panel_account' && d.approval === 'manual';
    });
  }

  /** Paiement externe annulé/échoué côté fournisseur — jamais débité, rien à rembourser ; le stock réservé est rendu. */
  async failExternalPayment(orderId: string): Promise<void> {
    const order = this.store.orders.find((o) => o.id === orderId);
    if (!order || order.status !== 'pending') return;
    if (order.stock_reserved === true) this.releaseStock(order.items);
    order.stock_reserved = false;
    order.status = 'cancelled';
    order.updated_at = new Date().toISOString();
    this.store.setOrder(order);
  }

  findByPaymentRef(ref: string): OrderRecord | undefined {
    return this.store.orders.find((o) => o.payment_ref === ref);
  }

  findById(id: string): OrderRecord | undefined {
    return this.store.orders.find((o) => o.id === id);
  }

  // ─── PayPal « Amis & Famille » ───────────────────────────────────────────────

  /** Une commande PayPal non payée dans le délai configuré est annulée (stock rendu). */
  private expirePaypalOrders(): void {
    const hours = this.store.paymentSettings.paypalTimeoutHours || 24;
    const limit = Date.now() - hours * 3600_000;
    for (const o of this.store.orders) {
      if (o.payment_method !== 'paypal' || o.status !== 'pending') continue;
      if (new Date(o.created_at).getTime() > limit) continue;
      if (o.stock_reserved === true) this.releaseStock(o.items);
      o.stock_reserved = false;
      o.status = 'cancelled';
      o.updated_at = new Date().toISOString();
      this.store.setOrder(o);
      this.logger.log(`Commande PayPal ${o.id} annulée (non payée après ${hours} h).`);
    }
  }

  /**
   * Traite un IPN PayPal DÉJÀ VÉRIFIÉ par PayPal (voir PaymentsService.verifyPaypalIpn). Ne confirme que : paiement
   * « Completed », reçu sur NOTRE e-mail PayPal, bonne devise, montant ≥ au total, SANS protection vendeur (= Amis & Famille),
   * transaction jamais vue, et note correspondant à une commande en attente. Renvoie un court résultat pour les logs.
   */
  async handlePaypalIpn(f: Record<string, string>): Promise<string> {
    const s = this.store.paymentSettings;
    const status = String(f.payment_status ?? '');
    const txn = String(f.txn_id ?? '');

    // Remboursement / contestation d'un paiement déjà accepté : on signale la commande (décision humaine), on n'annule rien seul.
    if (['Reversed', 'Refunded', 'Canceled_Reversal'].includes(status) && f.parent_txn_id) {
      const hit = this.store.orders.find((o) => o.paypal?.txn_id === f.parent_txn_id);
      if (hit) {
        hit.payment_alert = status;
        hit.updated_at = new Date().toISOString();
        this.store.setOrder(hit);
        this.logger.warn(`PayPal : ${status} sur la commande ${hit.id} (transaction ${f.parent_txn_id}) — à vérifier.`);
        return 'alert';
      }
      return 'ignored';
    }

    const m = /UHQ-[A-Z0-9]{10}/i.exec(String(f.memo ?? ''));
    if (!m || !txn) return 'ignored';
    const note = m[0].toUpperCase();
    const order = this.store.orders.find((o) => o.payment_method === 'paypal' && o.paypal?.note === note);
    if (!order) return 'no-order';

    if (this.delivering.has(order.id)) return 'processing';
    if (order.status !== 'pending') {
      // Paiement arrivé après annulation (délai dépassé) : l'admin doit trancher.
      if (order.status === 'cancelled' && status === 'Completed' && !order.payment_alert) {
        order.payment_alert = 'late_payment';
        order.paypal = { ...order.paypal!, txn_id: txn, payer_email: f.payer_email };
        this.store.setOrder(order);
        this.logger.warn(`PayPal : paiement reçu pour la commande ${order.id} déjà annulée — à rembourser ou à recréer.`);
        return 'late';
      }
      return 'already';
    }
    if (status !== 'Completed') return `status:${status}`;

    const receiver = String(f.receiver_email || f.business || '').trim().toLowerCase();
    const problems: string[] = [];
    if (!s.paypalEnabled || receiver !== s.paypalEmail.trim().toLowerCase()) problems.push('receiver');
    if (String(f.mc_currency ?? '').toUpperCase() !== order.currency.toUpperCase()) problems.push('currency');
    if (!(parseFloat(String(f.mc_gross ?? '0')) + 1e-9 >= order.total)) problems.push('amount');
    // Un paiement « Biens et services » est éligible à la protection vendeur (et donc contestable) : refusé, seul Amis & Famille passe.
    if (f.protection_eligibility && f.protection_eligibility !== 'Ineligible') problems.push('goods_and_services');
    if (problems.length) {
      order.payment_alert = `rejected:${problems.join(',')}`;
      order.paypal = { ...order.paypal!, txn_id: txn, payer_email: f.payer_email };
      this.store.setOrder(order);
      this.logger.warn(`PayPal : paiement refusé pour la commande ${order.id} (${problems.join(', ')}).`);
      return `rejected:${problems.join(',')}`;
    }
    if (!this.store.claimPaypalTxn(txn)) return 'duplicate';

    order.paypal = {
      ...order.paypal!, txn_id: txn, payer_email: f.payer_email,
      payer_name: `${f.first_name ?? ''} ${f.last_name ?? ''}`.trim() || undefined,
    };
    order.payment_alert = undefined;
    try {
      await this.confirmExternalPayment(order.id);
    } catch (err) {
      this.store.unclaimPaypalTxn(txn); // la livraison a échoué : PayPal renverra l'IPN, il doit pouvoir être retraité
      throw err;
    }
    return 'confirmed';
  }

  // ─── Livraison ───────────────────────────────────────────────────────────────

  /**
   * Crée les comptes proxy sur le panel pour les lignes dont la livraison (FIGÉE à la commande) est `panel_account`
   * (une création par unité), rattachés à l'acheteur. Si une création échoue en cours de route, les comptes déjà créés
   * sont BLOQUÉS (sinon ils resteraient utilisables alors que la commande est remboursée) avant de relancer l'erreur.
   */
  private async deliver(order: OrderRecord): Promise<DeliveredAccount[]> {
    const out: DeliveredAccount[] = [];
    const userId = order.user_id;
    let endpoint: { host: string; port: string } | null = null;

    try {
      for (const l of order.items) {
        const product = this.store.products[l.product_id];
        const delivery = l.snapshot?.delivery ?? product?.delivery;
        if (!delivery || delivery.mode !== 'panel_account') continue;

        if (!endpoint) endpoint = await this.panel.getProxyEndpoint();
        const acc: DeliveryAccount = delivery.account ?? {};
        const value = Number(acc.expires_days) || 0;
        const unit: ExpiresUnit = acc.expires_unit ?? 'day';
        const expiresAt = value > 0 ? addPeriod(new Date(), value, unit).toISOString() : undefined;
        const renewable = (l.snapshot ? l.snapshot.renewal_enabled : !!product?.renewal_enabled) && value > 0;

        for (let i = 0; i < l.quantity; i++) {
          const spec: CreateSubUserSpec = {
            label: `${l.name} · #${order.id.slice(0, 6).toUpperCase()}`,
            threads_limit: acc.threads_limit,
            traffic_limit_bytes: acc.traffic_limit_bytes,
            country_filter: acc.country_filter,
            sticky_session_ttl: acc.sticky_session_ttl,
            bandwidth_limit: acc.bandwidth_limit,
            expires_at: expiresAt,
            allowed_ips: acc.allowed_ips ?? '*',
            tags: acc.tags,
            custom_proxies: acc.custom_proxies,
            pool: acc.pool,
            owner_id: userId,
          };
          const created = await this.panel.createSubUser(spec);
          const host = endpoint.host;
          const port = endpoint.port;
          out.push({
            product_id: l.product_id,
            product_name: l.name,
            username: created.username,
            password: created.password,
            host,
            port,
            connection: `${host}:${port}:${created.username}:${created.password}`,
            panel_user_id: created.id || undefined,
            owner_linked: true,
            expires_at: expiresAt,
            renew: renewable && !!order.renew,
            renewal: renewable
              ? { unit_price: l.unit_price, currency: order.currency, product_name: l.name, account: JSON.parse(JSON.stringify(acc)), count: 0 }
              : undefined,
          });
        }
      }
    } catch (err) {
      for (const d of out) {
        if (!d.panel_user_id) continue;
        try {
          await this.panel.blockSubUser(d.panel_user_id);
        } catch (revokeErr: any) {
          this.logger.warn(`Blocage du compte ${d.username} (livraison partielle) échoué : ${revokeErr?.message}`);
        }
      }
      throw err;
    }
    return out;
  }

  // ─── Validation manuelle ─────────────────────────────────────────────────────

  /** Un admin valide une commande 'review' : les comptes sont créés puis la commande passe 'paid'. */
  async approve(id: string, adminEmail: string): Promise<OrderRecord> {
    const order = this.store.orders.find((o) => o.id === id);
    if (!order) throw new NotFoundException('Commande introuvable');
    if (order.status !== 'review') throw new BadRequestException('Seule une commande « à valider » peut être validée.');
    if (this.delivering.has(order.id)) throw new BadRequestException('Validation déjà en cours pour cette commande.');
    this.delivering.add(order.id);
    try {
      try {
        order.deliveries = await this.deliver(order);
      } catch (err: any) {
        throw new ServiceUnavailableException(`Validation impossible : la création des comptes a échoué (${err?.message ?? 'erreur inconnue'}). La commande reste « à valider ».`);
      }
      order.status = 'paid';
      order.approved_by = adminEmail;
      order.approved_at = new Date().toISOString();
      order.updated_at = order.approved_at;
      this.store.setOrder(order);
      return order;
    } finally {
      this.delivering.delete(order.id);
    }
  }

  // ─── Renouvellement automatique (solde Wallet) ───────────────────────────────

  /** Le client active / désactive le renouvellement automatique d'un compte livré (le sien uniquement). */
  setRenew(userId: string, orderId: string, index: number, enabled: boolean): OrderRecord {
    const order = this.store.orders.find((o) => o.id === orderId);
    if (!order || order.user_id !== userId) throw new NotFoundException('Commande introuvable');
    const d = order.deliveries?.[index];
    if (!d || !d.renewal) throw new BadRequestException('Ce compte n’est pas renouvelable.');
    d.renew = enabled;
    if (enabled && d.renewal.last_error === 'gave_up') { d.renewal.last_error = undefined; d.renewal.failed_at = undefined; }
    order.updated_at = new Date().toISOString();
    this.store.setOrder(order);
    return order;
  }

  /**
   * Renouvelle les comptes arrivés à échéance dont le client a activé le renouvellement : débit du Wallet au PRIX d'origine,
   * puis le panel ajoute la bande passante ACHETÉE au premier paiement (jamais la configuration actuelle du produit) et repousse
   * l'expiration d'une période. Fonds insuffisants : nouvelle tentative à chaque passage pendant 72 h, puis abandon.
   */
  private async runRenewals(): Promise<void> {
    const now = Date.now();
    for (const order of this.store.orders) {
      if (order.status !== 'paid' && order.status !== 'fulfilled') continue;
      let changed = false;
      for (const d of order.deliveries ?? []) {
        const r = d.renewal;
        if (!d.renew || !r || !d.expires_at || !d.panel_user_id) continue;
        const exp = Date.parse(d.expires_at);
        if (!Number.isFinite(exp) || exp > now) continue;
        if (now - exp > RENEWAL_GRACE_MS) {
          d.renew = false;
          r.last_error = 'gave_up';
          changed = true;
          continue;
        }
        changed = (await this.renewOne(order, d)) || changed;
      }
      if (changed) this.store.setOrder(order);
    }
  }

  private async renewOne(order: OrderRecord, d: DeliveredAccount): Promise<boolean> {
    const r = d.renewal!;
    const fail = (code: string) => { r.failed_at = new Date().toISOString(); r.last_error = code; return true; };
    if (!(await this.wallet.isAvailable())) return fail('wallet_down');

    try {
      await this.wallet.debit(order.user_id, r.unit_price, `Renouvellement — ${r.product_name}`);
    } catch {
      return fail('insufficient');
    }

    try {
      const value = Number(r.account.expires_days) || 0;
      const unit: ExpiresUnit = r.account.expires_unit ?? 'day';
      const base = new Date(Math.max(Date.parse(d.expires_at!), Date.now()));
      const next = addPeriod(base, value, unit);
      const patch: { expires_at: string; traffic_limit_bytes?: number } = { expires_at: next.toISOString() };
      const add = Number(r.account.traffic_limit_bytes) || 0;
      if (add > 0) {
        const cur = await this.panel.getSubUser(d.panel_user_id!);
        // Quota illimité côté panel (l'admin l'a levé) : rien à ajouter.
        if (cur.traffic_limit && cur.traffic_limit > 0) patch.traffic_limit_bytes = cur.traffic_limit + add;
      }
      await this.panel.updateSubUser(d.panel_user_id!, patch);
      d.expires_at = patch.expires_at;
    } catch (err: any) {
      // Le panel a refusé : on rend l'argent immédiatement, la prochaine passe réessaiera.
      this.logger.warn(`Renouvellement du compte ${d.username} échoué côté panel : ${err?.message ?? err} — remboursement.`);
      try {
        await this.wallet.credit(order.user_id, r.unit_price, `Remboursement (renouvellement échoué) — ${r.product_name}`);
      } catch (refundErr: any) {
        this.logger.error(`ÉCHEC du remboursement d'un renouvellement : ${refundErr?.message}`);
      }
      return fail('panel');
    }

    r.count += 1;
    r.last_at = new Date().toISOString();
    r.failed_at = undefined;
    r.last_error = undefined;
    this.recordPayment(order, 'renewal', 'wallet', r.unit_price, r.product_name);
    this.logger.log(`Compte ${d.username} renouvelé (${r.unit_price} ${r.currency}) jusqu'au ${d.expires_at}.`);
    return true;
  }

  // ─── Statut (admin) ──────────────────────────────────────────────────────────

  /**
   * Changement de statut (admin). Transitions contrôlées (jamais de retour depuis 'cancelled') ; 'review' → 'paid' = validation.
   * Annuler une commande payée (ou à valider) : remboursement Wallet (BLOQUÉ si le Wallet est injoignable — plus de remboursement
   * silencieusement perdu), stock rendu, comptes livrés bloqués.
   */
  async updateStatus(id: string, status: OrderStatus, adminEmail = 'admin'): Promise<{ order: OrderRecord; manualRefundRequired: boolean }> {
    const order = this.store.orders.find((o) => o.id === id);
    if (!order) throw new NotFoundException('Commande introuvable');
    if (order.status === status) return { order, manualRefundRequired: false };
    if (!TRANSITIONS[order.status].includes(status)) {
      throw new BadRequestException(`Passage impossible : ${order.status} → ${status}`);
    }
    if (order.status === 'review' && status === 'paid') return { order: await this.approve(id, adminEmail), manualRefundRequired: false };

    let manualRefundRequired = false;
    if (status === 'cancelled') {
      const wasPaid = PAID_STATES.includes(order.status);

      if (wasPaid && order.payment_method === 'wallet') {
        // Rembourser AVANT de modifier quoi que ce soit : en cas d'échec, la commande reste intacte.
        if (!(await this.wallet.isAvailable())) {
          throw new ServiceUnavailableException('Wallet injoignable : annulation impossible pour le moment (le remboursement ne pourrait pas être crédité).');
        }
        // Le paiement initial seulement : les renouvellements ont déjà été débités (et sont remboursés à part par l'admin si besoin).
        await this.wallet.credit(order.user_id, order.total, `Remboursement commande ${order.id.slice(0, 8)}`);
      } else if (wasPaid) {
        // Stripe / NOWPayments / PayPal : l'argent n'a jamais transité par cet addon — remboursement à faire chez le fournisseur.
        manualRefundRequired = true;
        this.logger.warn(
          `Commande ${order.id} (${order.payment_method}) annulée — remboursement à faire manuellement côté fournisseur.`,
        );
      }

      // Stock rendu : commandes payées (toujours réservées) et commandes pending réservées depuis la v1.3.0.
      if (wasPaid || order.stock_reserved === true) this.releaseStock(order.items);
      order.stock_reserved = false;

      if (wasPaid) {
        for (const d of order.deliveries ?? []) {
          d.renew = false; // plus aucun renouvellement sur une commande annulée
          if (!d.panel_user_id) continue;
          try {
            await this.panel.blockSubUser(d.panel_user_id);
          } catch (err: any) {
            this.logger.warn(`Révocation du compte ${d.username} échouée: ${err?.message}`);
          }
        }
      }
    }

    order.status = status;
    order.updated_at = new Date().toISOString();
    this.store.setOrder(order);
    return { order, manualRefundRequired };
  }

  // ─── Documents (factures / reçus) ────────────────────────────────────────────

  /** Commande lisible par `user` (propriétaire ou admin) ; sinon 404 (on ne révèle pas l'existence). */
  orderFor(user: { id: string; role: string }, orderId: string): OrderRecord {
    const order = this.store.orders.find((o) => o.id === orderId);
    if (!order) throw new NotFoundException('Commande introuvable');
    if (order.user_id !== user.id && user.role !== 'ADMIN') throw new NotFoundException('Commande introuvable');
    return order;
  }

  /** Garantit un numéro de facture à l'encaissement demandé (commandes payées avant l'activation de la facturation). */
  ensureInvoiceNumber(order: OrderRecord, payment: PaymentEvent): void {
    if (!this.store.invoiceSettings.enabled) throw new ForbiddenException('La facturation n’est pas activée.');
    if (payment.invoice_number) return;
    payment.invoice_number = this.store.nextInvoiceNumber();
    if (payment.kind === 'initial') order.invoice_number = payment.invoice_number;
    if (order.payments?.length) this.store.setOrder(order);
    else {
      // Commande ancienne (paiement implicite) : on matérialise l'encaissement pour que le numéro soit conservé.
      order.payments = [payment];
      this.store.setOrder(order);
    }
  }
}
