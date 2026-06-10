import {
  Injectable, Logger, BadRequestException, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  StoreService, ProductRecord, OrderRecord, OrderItem, OrderStatus,
  DeliveryConfig, DeliveredAccount,
} from './store.service';
import { WalletClient } from './wallet.client';
import { PanelClient, CreateSubUserSpec } from './panel.client';
import { CreateProductDto, UpdateProductDto, OrderItemDto } from './dto/orders.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly store: StoreService,
    private readonly wallet: WalletClient,
    private readonly panel: PanelClient,
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
      },
    };
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

  async placeOrder(userId: string, items: OrderItemDto[]): Promise<OrderRecord> {
    if (!items?.length) throw new BadRequestException('Panier vide');

    if (!(await this.wallet.isAvailable())) {
      throw new ServiceUnavailableException('Addon Wallet requis pour passer commande');
    }

    // Résolution des lignes + vérification disponibilité/stock
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
      lines.push({
        product_id: product.id,
        name:       product.name,
        unit_price: product.price,
        quantity:   qty,
      });
    }

    const total = parseFloat(lines.reduce((s, l) => s + l.unit_price * l.quantity, 0).toFixed(2));
    if (total <= 0) throw new BadRequestException('Montant de commande invalide');

    // Pré-vérification AVANT paiement : si une livraison de compte est requise,
    // le panel doit être joignable — sinon on refuse sans débiter.
    if (needsPanelDelivery && !this.panel.isConfigured()) {
      throw new ServiceUnavailableException(
        'Livraison automatique indisponible (PANEL_URL / PANEL_API_KEY non configurés)',
      );
    }

    const note = `Commande : ${lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')}`.slice(0, 180);

    // Débit du solde (lève une erreur si solde insuffisant)
    await this.wallet.debit(userId, total, note);

    // À partir d'ici le solde est débité : toute erreur de livraison doit
    // rembourser (rollback) pour ne jamais facturer sans livrer.
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

    // Décrémente le stock une fois paiement ET livraison validés
    for (const l of lines) {
      const product = this.store.products[l.product_id];
      if (product && product.stock !== null) {
        product.stock = Math.max(0, product.stock - l.quantity);
        product.updated_at = new Date().toISOString();
        this.store.setProduct(product);
      }
    }

    const now = new Date().toISOString();
    const order: OrderRecord = {
      id:         randomUUID(),
      user_id:    userId,
      items:      lines,
      total,
      currency,
      status:     'paid',
      note,
      deliveries,
      created_at: now,
      updated_at: now,
    };
    this.store.addOrder(order);
    return order;
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
    // + révocation des comptes proxy livrés (sinon proxy gratuit).
    if (status === 'cancelled' && order.status !== 'cancelled') {
      if (await this.wallet.isAvailable()) {
        await this.wallet.credit(order.user_id, order.total, `Remboursement commande ${order.id.slice(0, 8)}`);
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
