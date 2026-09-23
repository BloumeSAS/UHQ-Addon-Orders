import {
  Injectable, Logger, BadRequestException, NotFoundException, ServiceUnavailableException,
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

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly store: StoreService,
    private readonly wallet: WalletClient,
    private readonly panel: PanelClient,
    private readonly payments: PaymentsService,
  ) {}

  /** Normalise une config de livraison entrante (défaut : aucune livraison). */
  private normalizeDelivery(input: any): DeliveryConfig {
    if (!input || input.mode !== 'panel_account') return { mode: 'none' };
    const a = input.account ?? {};
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
        custom_proxies: a.custom_proxies?.trim() || undefined,
        pool: a.pool?.trim() || undefined,
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

  // ─── Products ──────────────────────────────────────────────────────────────

  listProducts(includeInactive = false): ProductRecord[] {
    const all = Object.values(this.store.products)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return includeInactive ? all : all.filter((p) => p.active);
  }

  createProduct(dto: CreateProductDto): ProductRecord {
    const now = new Date().toISOString();
    const product: ProductRecord = {
      id:          randomUUID(),
      name:        dto.name.trim(),
      description: dto.description?.trim() || null,
      price:       parseFloat(dto.price.toFixed(2)),
      currency:    (dto.currency || 'EUR').toUpperCase(),
      stock:       dto.stock === undefined ? null : dto.stock,
      active:      dto.active ?? true,
      delivery:    this.normalizeDelivery(dto.delivery),
      created_at:  now,
      updated_at:  now,
    };
    this.store.setProduct(product);
    return product;
  }

  updateProduct(id: string, dto: UpdateProductDto): ProductRecord {
    const product = this.store.products[id];
    if (!product) throw new NotFoundException('Produit introuvable');

    if (dto.name !== undefined) product.name = dto.name.trim();
    if (dto.description !== undefined) product.description = dto.description.trim() || null;
    if (dto.price !== undefined) product.price = parseFloat(dto.price.toFixed(2));
    if (dto.currency !== undefined) product.currency = dto.currency.toUpperCase();
    if (dto.stock !== undefined) product.stock = dto.stock;
    if (dto.active !== undefined) product.active = dto.active;
    if (dto.delivery !== undefined) product.delivery = this.normalizeDelivery(dto.delivery);
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

  allOrders(): OrderRecord[] {
    return [...this.store.orders].sort((a, b) => b.created_at.localeCompare(a.created_at));
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

    const lines: OrderItem[] = [];
    let currency = 'EUR';
    let needsPanelDelivery = false;
    for (const item of items) {
      const product = this.store.products[item.product_id];
      if (!product || !product.active) {
        throw new BadRequestException(`Produit indisponible : ${item.product_id}`);
      }
      const qty = Math.floor(item.quantity);
      if (qty < 1) throw new BadRequestException('Quantité invalide');
      if (product.stock !== null && product.stock < qty) {
        throw new BadRequestException(`Stock insuffisant : ${product.name}`);
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
   * Point d'entrée unique du checkout : 3 méthodes de paiement.
   *  - 'wallet' (défaut, historique) : débit synchrone, livraison immédiate,
   *    commande créée directement 'paid'.
   *  - 'stripe' / 'nowpayments' : commande créée 'pending' (jamais débitée,
   *    jamais livrée) ; renvoie une URL de paiement externe vers laquelle
   *    rediriger l'acheteur. La confirmation arrive plus tard par webhook
   *    (confirmExternalPayment) — c'est LUI qui débite/livre, jamais ici.
   */
  async checkout(
    userId: string,
    items: OrderItemDto[],
    method: PaymentMethod = 'wallet',
    successUrl?: string,
    cancelUrl?: string,
  ): Promise<{ order: OrderRecord; checkoutUrl?: string }> {
    const { lines, total, currency } = this.resolveLines(items);
    const note = `Commande : ${lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')}`.slice(0, 180);

    if (method === 'wallet') {
      if (!(await this.wallet.isAvailable())) {
        throw new ServiceUnavailableException('Addon Wallet requis pour ce mode de paiement');
      }
      await this.wallet.debit(userId, total, note);

      let deliveries: DeliveredAccount[] = [];
      try {
        deliveries = await this.deliver(userId, lines);
      } catch (err: any) {
        this.logger.error(`Livraison échouée — remboursement de ${total} ${currency}: ${err?.message}`);
        try {
          await this.wallet.credit(userId, total, `Remboursement (échec livraison) — ${note}`);
        } catch (refundErr: any) {
          this.logger.error(`ÉCHEC du remboursement après livraison ratée: ${refundErr?.message}`);
        }
        throw new ServiceUnavailableException(
          `Paiement remboursé : la livraison a échoué (${err?.message ?? 'erreur inconnue'})`,
        );
      }
      this.decrementStock(lines);

      const order = this.buildOrder(userId, lines, total, currency, note, 'wallet', 'paid', deliveries);
      this.store.addOrder(order);
      return { order };
    }

    // Paiement externe : commande 'pending', pas de débit, pas de livraison —
    // tout ça se produit dans confirmExternalPayment() au retour du webhook.
    if (!successUrl || !cancelUrl) {
      throw new BadRequestException('successUrl/cancelUrl requis pour ce mode de paiement');
    }
    const order = this.buildOrder(userId, lines, total, currency, note, method, 'pending', []);

    const checkoutUrl = method === 'stripe'
      ? await this.payments.createStripeCheckout(order, successUrl, cancelUrl)
      : await this.payments.createNowPayment(order, successUrl, cancelUrl);

    this.store.addOrder(order); // ajouté après coup pour inclure payment_ref posé par payments.*
    return { order, checkoutUrl };
  }

  private buildOrder(
    userId: string, lines: OrderItem[], total: number, currency: string, note: string,
    method: PaymentMethod, status: OrderStatus, deliveries: DeliveredAccount[],
  ): OrderRecord {
    const now = new Date().toISOString();
    return {
      id: randomUUID(), user_id: userId, items: lines, total, currency, status, note,
      payment_method: method, deliveries, created_at: now, updated_at: now,
    };
  }

  private decrementStock(lines: OrderItem[]): void {
    for (const l of lines) {
      const product = this.store.products[l.product_id];
      if (product && product.stock !== null) {
        product.stock = Math.max(0, product.stock - l.quantity);
        product.updated_at = new Date().toISOString();
        this.store.setProduct(product);
      }
    }
  }

  /**
   * Appelé par les webhooks Stripe/NOWPayments quand le paiement est
   * confirmé : livre (aucune donnée bancaire n'a jamais transité par cet
   * addon — Stripe/NOWPayments gèrent le paiement lui-même) puis marque la
   * commande 'paid'. Idempotent : une commande déjà 'paid'/'fulfilled' est
   * ignorée (un webhook peut être renvoyé plusieurs fois par le fournisseur).
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
      // Paiement déjà encaissé par Stripe/NOWPayments (pas par nous) — on ne
      // peut pas "rembourser" depuis ici. Reste en pending, alerte via les
      // logs pour intervention manuelle admin (rembourser côté Stripe/NOWPayments).
      throw err;
    }
    this.decrementStock(order.items);
    order.status = 'paid';
    order.updated_at = new Date().toISOString();
    this.store.setOrder(order);
    return order;
  }

  /** Paiement externe annulé/échoué côté fournisseur — jamais débité, rien à rembourser. */
  async failExternalPayment(orderId: string): Promise<void> {
    const order = this.store.orders.find((o) => o.id === orderId);
    if (!order || order.status !== 'pending') return;
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
   * Crée les comptes proxy sur le panel pour les lignes dont le produit a une
   * livraison `panel_account` (une création par unité). Renvoie les comptes
   * livrés (identifiants complets host:port:user:pass).
   */
  private async deliver(userId: string, lines: OrderItem[]): Promise<DeliveredAccount[]> {
    const out: DeliveredAccount[] = [];
    let endpoint: { host: string; port: string } | null = null;

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
        });
      }
    }
    return out;
  }

  async updateStatus(id: string, status: OrderStatus): Promise<OrderRecord> {
    const order = this.store.orders.find((o) => o.id === id);
    if (!order) throw new NotFoundException('Commande introuvable');

    // Annulation d'une commande payée → remboursement + remise en stock
    // + révocation des comptes proxy livrés (sinon proxy gratuit). Ne
    // s'applique qu'aux commandes déjà 'paid'/'fulfilled' — le stock n'a
    // jamais été décrémenté ni rien livré pour une commande encore
    // 'pending' (paiement externe pas confirmé), donc rien à défaire ici
    // (cf. failExternalPayment pour ce cas).
    if (status === 'cancelled' && (order.status === 'paid' || order.status === 'fulfilled')) {
      if (order.payment_method === 'wallet') {
        if (await this.wallet.isAvailable()) {
          await this.wallet.credit(order.user_id, order.total, `Remboursement commande ${order.id.slice(0, 8)}`);
        }
      } else {
        // Paiement Stripe/NOWPayments : l'argent n'a jamais transité par
        // cet addon, un crédit Wallet ici serait un solde offert sans
        // rapport avec un vrai remboursement — à faire manuellement côté
        // tableau de bord Stripe / NOWPayments.
        this.logger.warn(
          `Commande ${order.id} (${order.payment_method}) annulée — remboursement à faire manuellement côté fournisseur, aucun crédit Wallet automatique.`,
        );
      }
      for (const l of order.items) {
        const product = this.store.products[l.product_id];
        if (product && product.stock !== null) {
          product.stock += l.quantity;
          product.updated_at = new Date().toISOString();
          this.store.setProduct(product);
        }
      }
      // Révocation best-effort des comptes livrés (échec non bloquant).
      for (const d of order.deliveries ?? []) {
        if (!d.panel_user_id) continue;
        try {
          await this.panel.blockSubUser(d.panel_user_id);
        } catch (err: any) {
          this.logger.warn(`Révocation du compte ${d.username} échouée: ${err?.message}`);
        }
      }
    }

    order.status = status;
    order.updated_at = new Date().toISOString();
    this.store.setOrder(order);
    return order;
  }
}
