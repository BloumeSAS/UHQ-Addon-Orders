import {
  Injectable, Logger, BadRequestException, NotFoundException, ServiceUnavailableException, OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StoreService, ProductRecord, OrderRecord, OrderItem, OrderStatus, PaymentMethod,
  DeliveryConfig, DeliveredAccount,
} from './store.service';
import { WalletClient } from './wallet.client';
import { PanelClient, CreateSubUserSpec } from './panel.client';
import { PaymentsService } from './payments/payments.service';
import { CreateProductDto, UpdateProductDto, OrderItemDto } from './dto/orders.dto';

/** Transitions de statut autorisées (jamais de retour en arrière : une commande annulée est définitive). */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['cancelled'],
  paid: ['fulfilled', 'cancelled'],
  fulfilled: ['cancelled'],
  cancelled: [],
};

export interface OrderQuery {
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly store: StoreService,
    private readonly wallet: WalletClient,
    private readonly panel: PanelClient,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * Réparation : avant la v1.3.1 les comptes livrés n'étaient rattachés à aucun utilisateur et n'apparaissaient donc PAS dans
   * « Mes proxies » de l'acheteur. Au démarrage (puis toutes les 15 min tant qu'il en reste), on les rattache à leur acheteur.
   * Silencieux si le panel est trop ancien pour accepter `owner_id` (nouvelle tentative plus tard).
   */
  onModuleInit() {
    const run = () => void this.repairOwners().catch((e) => this.logger.warn(`Réparation des propriétaires : ${e?.message ?? e}`));
    setTimeout(run, 20_000).unref();
    setInterval(run, 15 * 60_000).unref();
  }

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

  /** Normalise une config de livraison entrante (défaut : aucune livraison). */
  private normalizeDelivery(input: any): DeliveryConfig {
    if (!input || input.mode !== 'panel_account') return { mode: 'none' };
    const a = input.account ?? {};
    const custom = a.custom_proxies?.trim() || undefined;
    return {
      mode: 'panel_account',
      account: {
        threads_limit: a.threads_limit,
        traffic_limit_bytes: a.traffic_limit_bytes,
        country_filter: a.country_filter?.trim() || undefined,
        sticky_session_ttl: a.sticky_session_ttl,
        bandwidth_limit: a.bandwidth_limit,
        expires_days: a.expires_days,
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

  // ─── Products ──────────────────────────────────────────────────────────────

  listProducts(includeInactive = false): ProductRecord[] {
    const all = Object.values(this.store.products)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return includeInactive ? all : all.filter((p) => p.active);
  }

  /**
   * Vue publique d'un produit (clients) : JAMAIS la configuration de livraison détaillée — elle contient les listes de
   * proxies privés de l'administrateur (avec identifiants) et les réglages internes. Seul le mode (livraison auto ou non) est exposé.
   */
  toPublic(p: ProductRecord) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      currency: p.currency,
      stock: p.stock,
      active: p.active,
      delivery: { mode: p.delivery?.mode ?? 'none' },
    };
  }

  async createProduct(dto: CreateProductDto): Promise<ProductRecord> {
    const delivery = this.normalizeDelivery(dto.delivery);
    await this.assertPoolExists(delivery);
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

    if (dto.name !== undefined) product.name = dto.name.trim();
    if (dto.description !== undefined) product.description = dto.description.trim() || null;
    if (dto.price !== undefined) product.price = parseFloat(dto.price.toFixed(2));
    if (dto.currency !== undefined) product.currency = dto.currency.toUpperCase();
    if (dto.stock !== undefined) product.stock = dto.stock; // null = illimité
    if (dto.active !== undefined) product.active = dto.active;
    if (delivery) product.delivery = delivery;
    product.updated_at = new Date().toISOString();

    this.store.setProduct(product);
    return product;
  }

  deleteProduct(id: string): void {
    if (!this.store.products[id]) throw new NotFoundException('Produit introuvable');
    this.store.deleteProduct(id);
  }

  // ─── Orders ────────────────────────────────────────────────────────────────

  userOrders(userId: string): OrderRecord[] {
    return this.store.orders
      .filter((o) => o.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** Toutes les commandes (admin), filtrées par statut / recherche (client, produit, id) et paginées si `limit` est fourni. */
  queryOrders(query: OrderQuery): { orders: OrderRecord[]; total: number } {
    let list = [...this.store.orders].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (query.status && ['pending', 'paid', 'fulfilled', 'cancelled'].includes(query.status)) {
      list = list.filter((o) => o.status === query.status);
    }
    const q = (query.q ?? '').trim().toLowerCase();
    if (q) {
      list = list.filter((o) =>
        o.id.toLowerCase().includes(q) ||
        o.user_id.toLowerCase().includes(q) ||
        (o.user_email ?? '').toLowerCase().includes(q) ||
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

  /** Indicateurs de l'accueil admin et du widget (le widget ne télécharge plus toutes les commandes). */
  stats() {
    const orders = this.store.orders;
    const counted = orders.filter((o) => o.status === 'paid' || o.status === 'fulfilled');
    const products = Object.values(this.store.products);
    const month = new Date().toISOString().slice(0, 7);
    return {
      orders: orders.length,
      pending: orders.filter((o) => o.status === 'pending').length,
      toFulfill: orders.filter((o) => o.status === 'paid').length,
      revenue: parseFloat(counted.reduce((s, o) => s + o.total, 0).toFixed(2)),
      revenueMonth: parseFloat(counted.filter((o) => o.created_at.startsWith(month)).reduce((s, o) => s + o.total, 0).toFixed(2)),
      currency: orders[0]?.currency ?? products[0]?.currency ?? 'EUR',
      activeProducts: products.filter((p) => p.active).length,
      lowStock: products.filter((p) => p.active && p.stock !== null && p.stock <= 3).length,
    };
  }

  // ─── Wallet bridge ───────────────────────────────────────────────────────────

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
  private resolveLines(items: OrderItemDto[]): { lines: OrderItem[]; total: number; currency: string; needsPanelDelivery: boolean } {
    if (!items?.length) throw new BadRequestException('Panier vide');

    // Une même référence peut apparaître deux fois : on cumule les quantités (le stock est contrôlé sur le total).
    const merged = new Map<string, number>();
    for (const item of items) merged.set(item.product_id, (merged.get(item.product_id) ?? 0) + Math.floor(item.quantity));

    const lines: OrderItem[] = [];
    let currency = '';
    let needsPanelDelivery = false;
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
      if (product.delivery?.mode === 'panel_account') needsPanelDelivery = true;
      currency = product.currency;
      lines.push({ product_id: product.id, name: product.name, unit_price: product.price, quantity: qty });
    }

    const total = parseFloat(lines.reduce((s, l) => s + l.unit_price * l.quantity, 0).toFixed(2));
    if (total <= 0) throw new BadRequestException('Montant de commande invalide');

    if (needsPanelDelivery && !this.panel.isConfigured()) {
      throw new ServiceUnavailableException(
        'Livraison automatique indisponible (PANEL_URL / PANEL_API_KEY non configurés)',
      );
    }
    return { lines, total, currency, needsPanelDelivery };
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
   * Point d'entrée unique du checkout : 3 méthodes de paiement.
   *  - 'wallet' (défaut) : débit synchrone, livraison immédiate, commande créée directement 'paid'.
   *  - 'stripe' / 'nowpayments' : commande 'pending' (stock réservé, jamais débitée ni livrée) ; renvoie une URL de
   *    paiement externe. La confirmation arrive par webhook (confirmExternalPayment) qui livre.
   */
  async checkout(
    user: { id: string; email: string },
    items: OrderItemDto[],
    method: PaymentMethod = 'wallet',
    successUrl?: string,
    cancelUrl?: string,
  ): Promise<{ order: OrderRecord; checkoutUrl?: string }> {
    const { lines, total, currency } = this.resolveLines(items);
    const note = `Commande : ${lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')}`.slice(0, 180);

    if (method !== 'wallet') {
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

      let deliveries: DeliveredAccount[] = [];
      try {
        deliveries = await this.deliver(user.id, lines);
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

      const order = this.buildOrder(user, lines, total, currency, note, 'wallet', 'paid', deliveries);
      this.store.addOrder(order);
      return { order };
    }

    // Paiement externe : commande 'pending', pas de débit, pas de livraison (webhook).
    const order = this.buildOrder(user, lines, total, currency, note, method, 'pending', []);
    try {
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
    method: PaymentMethod, status: OrderStatus, deliveries: DeliveredAccount[],
  ): OrderRecord {
    const now = new Date().toISOString();
    return {
      id: randomUUID(), user_id: user.id, user_email: user.email || undefined, stock_reserved: true,
      items: lines, total, currency, status, note,
      payment_method: method, deliveries, created_at: now, updated_at: now,
    };
  }

  /**
   * Appelé par les webhooks Stripe/NOWPayments quand le paiement est confirmé : livre puis marque la commande 'paid'.
   * Idempotent : une commande déjà 'paid'/'fulfilled' est ignorée (un webhook peut être renvoyé plusieurs fois).
   */
  async confirmExternalPayment(orderId: string): Promise<OrderRecord | null> {
    const order = this.store.orders.find((o) => o.id === orderId);
    if (!order) {
      this.logger.warn(`Webhook pour une commande inconnue : ${orderId}`);
      return null;
    }
    if (order.status !== 'pending') return order; // déjà traité

    try {
      order.deliveries = await this.deliver(order.user_id, order.items);
    } catch (err: any) {
      this.logger.error(`Livraison échouée après paiement externe confirmé (commande ${order.id}) : ${err?.message}`);
      // Paiement déjà encaissé par Stripe/NOWPayments : reste 'pending' (le fournisseur réessaiera le webhook) ;
      // intervention manuelle (rembourser côté Stripe/NOWPayments) si l'échec persiste.
      throw err;
    }
    // Commandes d'avant la v1.3.0 : le stock n'était pas réservé à la création.
    if (order.stock_reserved !== true) this.reserveStock(order.items);
    order.stock_reserved = true;
    order.status = 'paid';
    order.updated_at = new Date().toISOString();
    this.store.setOrder(order);
    return order;
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

  /**
   * Crée les comptes proxy sur le panel pour les lignes dont le produit a une livraison `panel_account` (une création
   * par unité). Si une création échoue en cours de route, les comptes déjà créés sont BLOQUÉS (sinon ils resteraient
   * utilisables alors que la commande est remboursée) avant de relancer l'erreur.
   */
  private async deliver(userId: string, lines: OrderItem[]): Promise<DeliveredAccount[]> {
    const out: DeliveredAccount[] = [];
    let endpoint: { host: string; port: string } | null = null;

    try {
      for (const l of lines) {
        const product = this.store.products[l.product_id];
        const delivery = product?.delivery;
        if (!delivery || delivery.mode !== 'panel_account') continue;

        if (!endpoint) endpoint = await this.panel.getProxyEndpoint();
        const acc = delivery.account ?? {};
        const expiresAt =
          acc.expires_days && acc.expires_days > 0
            ? new Date(Date.now() + acc.expires_days * 86_400_000).toISOString()
            : undefined;

        for (let i = 0; i < l.quantity; i++) {
          const spec: CreateSubUserSpec = {
            label: `${product!.name} — order:${userId.slice(0, 8)}`,
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
            product_id: product!.id,
            product_name: product!.name,
            username: created.username,
            password: created.password,
            host,
            port,
            connection: `${host}:${port}:${created.username}:${created.password}`,
            panel_user_id: created.id || undefined,
            owner_linked: true,
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

  /**
   * Changement de statut (admin). Transitions contrôlées (jamais de retour depuis 'cancelled').
   * Annuler une commande payée : remboursement Wallet (BLOQUÉ si le Wallet est injoignable — plus de remboursement
   * silencieusement perdu), stock rendu, comptes livrés bloqués.
   */
  async updateStatus(id: string, status: OrderStatus): Promise<{ order: OrderRecord; manualRefundRequired: boolean }> {
    const order = this.store.orders.find((o) => o.id === id);
    if (!order) throw new NotFoundException('Commande introuvable');
    if (order.status === status) return { order, manualRefundRequired: false };
    if (!TRANSITIONS[order.status].includes(status)) {
      throw new BadRequestException(`Passage impossible : ${order.status} → ${status}`);
    }

    let manualRefundRequired = false;
    if (status === 'cancelled') {
      const wasPaid = order.status === 'paid' || order.status === 'fulfilled';

      if (wasPaid && order.payment_method === 'wallet') {
        // Rembourser AVANT de modifier quoi que ce soit : en cas d'échec, la commande reste intacte.
        if (!(await this.wallet.isAvailable())) {
          throw new ServiceUnavailableException('Wallet injoignable : annulation impossible pour le moment (le remboursement ne pourrait pas être crédité).');
        }
        await this.wallet.credit(order.user_id, order.total, `Remboursement commande ${order.id.slice(0, 8)}`);
      } else if (wasPaid) {
        // Stripe / NOWPayments : l'argent n'a jamais transité par cet addon — remboursement à faire chez le fournisseur.
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
}
