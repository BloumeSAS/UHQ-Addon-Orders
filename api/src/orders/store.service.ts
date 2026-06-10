import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/** Specs du compte proxy créé sur le panel à la livraison (toutes optionnelles). */
export interface DeliveryAccount {
  threads_limit?: number;
  traffic_limit_bytes?: number;
  country_filter?: string;
  sticky_session_ttl?: number;
  bandwidth_limit?: number;
  expires_days?: number;
  allowed_ips?: string;
  tags?: string;
  /** Liste privée d'upstreams ; vide = pool partagé. */
  custom_proxies?: string;
}

/** Config de livraison d'un produit. */
export interface DeliveryConfig {
  mode: 'none' | 'panel_account';
  account?: DeliveryAccount;
}

export interface ProductRecord {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  /** null = stock illimité */
  stock: number | null;
  active: boolean;
  /** Livraison automatique (défaut : { mode: 'none' }). */
  delivery: DeliveryConfig;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  product_id: string;
  name: string;
  unit_price: number;
  quantity: number;
}

/** Compte proxy livré à l'acheteur après paiement. */
export interface DeliveredAccount {
  product_id: string;
  product_name: string;
  username: string;
  password: string;
  host: string;
  port: string;
  /** Ligne prête à l'emploi : host:port:username:password */
  connection: string;
  /** id du UserProxy créé côté panel (pour traçabilité). */
  panel_user_id?: string;
}

export type OrderStatus = 'paid' | 'fulfilled' | 'cancelled';

export interface OrderRecord {
  id: string;
  user_id: string;
  items: OrderItem[];
  total: number;
  currency: string;
  status: OrderStatus;
  note: string | null;
  /** Comptes proxy livrés (vide si aucun produit livrable). */
  deliveries: DeliveredAccount[];
  created_at: string;
  updated_at: string;
}

interface StoreData {
  products: Record<string, ProductRecord>;
  orders: OrderRecord[];
}

/**
 * Service de persistance JSON — zéro dépendance native.
 * Écriture atomique via fichier temporaire.
 */
@Injectable()
export class StoreService implements OnModuleInit {
  private readonly logger = new Logger(StoreService.name);
  private readonly dbPath: string;
  private data: StoreData = { products: {}, orders: [] };

  constructor() {
    // Racine de l'addon = deux niveaux au-dessus de api/
    // dist/orders/ → dist/ → api/ → orders/ → orders-data.json
    const defaultDb = path.resolve(__dirname, '..', '..', '..', 'orders-data.json');
    this.dbPath = path.resolve(process.env.DB_PATH ?? defaultDb);
  }

  onModuleInit() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
        this.data = { products: parsed.products ?? {}, orders: parsed.orders ?? [] };
        this.logger.log(`Données chargées depuis ${this.dbPath}`);
      } else {
        this.persist();
        this.logger.log(`Nouveau fichier créé : ${this.dbPath}`);
      }
    } catch (err) {
      this.logger.warn(`Impossible de lire ${this.dbPath} — démarrage avec données vides`);
    }
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  get products(): Record<string, ProductRecord> {
    return this.data.products;
  }

  get orders(): OrderRecord[] {
    return this.data.orders;
  }

  // ─── Mutations ────────────────────────────────────────────────────────────────

  setProduct(record: ProductRecord): void {
    this.data.products[record.id] = record;
    this.persist();
  }

  deleteProduct(id: string): void {
    delete this.data.products[id];
    this.persist();
  }

  addOrder(order: OrderRecord): void {
    this.data.orders.push(order);
    // Garde uniquement les 10 000 dernières commandes en mémoire
    if (this.data.orders.length > 10_000) {
      this.data.orders = this.data.orders.slice(-10_000);
    }
    this.persist();
  }

  setOrder(order: OrderRecord): void {
    const idx = this.data.orders.findIndex((o) => o.id === order.id);
    if (idx >= 0) this.data.orders[idx] = order;
    this.persist();
  }

  /** Restaure toutes les données depuis un backup. */
  restoreData(snapshot: { products: Record<string, ProductRecord>; orders: OrderRecord[] }): void {
    this.data.products = snapshot.products;
    this.data.orders = snapshot.orders;
    this.persist();
  }

  // ─── Persistance ─────────────────────────────────────────────────────────────

  private persist(): void {
    const tmp = this.dbPath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.dbPath);
    } catch (err) {
      this.logger.error('Erreur de persistance :', err);
    }
  }
}
