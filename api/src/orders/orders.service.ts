import {
  Injectable, BadRequestException, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StoreService, ProductRecord, OrderRecord, OrderItem, OrderStatus } from './store.service';
import { WalletClient } from './wallet.client';
import { CreateProductDto, UpdateProductDto, OrderItemDto } from './dto/orders.dto';

@Injectable()
export class OrdersService {
  constructor(
    private readonly store: StoreService,
    private readonly wallet: WalletClient,
  ) {}

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

    const note = `Commande : ${lines.map((l) => `${l.quantity}× ${l.name}`).join(', ')}`.slice(0, 180);

    // Débit du solde (lève une erreur si solde insuffisant)
    await this.wallet.debit(userId, total, note);

    // Décrémente le stock une fois le paiement validé
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
      created_at: now,
      updated_at: now,
    };
    this.store.addOrder(order);
    return order;
  }

  async updateStatus(id: string, status: OrderStatus): Promise<OrderRecord> {
    const order = this.store.orders.find((o) => o.id === id);
    if (!order) throw new NotFoundException('Commande introuvable');

    // Annulation d'une commande payée → remboursement + remise en stock
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
    }

    order.status = status;
    order.updated_at = new Date().toISOString();
    this.store.setOrder(order);
    return order;
  }
}
