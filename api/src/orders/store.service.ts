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
  /** Nom de la catégorie (ProxyPool) à utiliser ; vide = pool global. Ignoré si custom_proxies renseigné. */
  pool?: string;
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
  /** true = le compte est rattaché à l'acheteur (visible dans « Mes proxies »). Absent des livraisons d'avant la v1.3.1. */
  owner_linked?: boolean;
}

/**
 * 'pending' : commande créée pour un paiement externe (Stripe/NOWPayments)
 * en attente de confirmation webhook — pas encore débitée, pas livrée.
 * N'existe jamais pour un paiement Wallet (débit synchrone à la commande).
 */
export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'cancelled';
export type PaymentMethod = 'wallet' | 'stripe' | 'nowpayments';

export interface OrderRecord {
  id: string;
  user_id: string;
  /** E-mail du client au moment de la commande (affichage admin). */
  user_email?: string;
  /** true = le stock est déjà réservé pour cette commande (absent des commandes d'avant la v1.3.0). */
  stock_reserved?: boolean;
  items: OrderItem[];
  total: number;
  currency: string;
  status: OrderStatus;
  note: string | null;
  payment_method: PaymentMethod;
  /** Session Stripe / id de paiement NOWPayments — pour réconcilier le webhook. */
  payment_ref?: string;
  /** Comptes proxy livrés (vide si aucun produit livrable). */
  deliveries: DeliveredAccount[];
  created_at: string;
  updated_at: string;
}

/**
 * Clés API des passerelles de paiement externes — mêmes conventions que les
 * secrets du panel (SettingsService) : jamais renvoyées en clair côté API
 * (masquées ••••), une valeur vide/masquée en écriture n'écrase jamais un
 * secret déjà enregistré.
 */
export interface PaymentSettings {
  stripeEnabled: boolean;
  stripeSecretKey: string;
  stripePublishableKey: string;
  stripeWebhookSecret: string;
  nowpaymentsEnabled: boolean;
  nowpaymentsApiKey: string;
  nowpaymentsIpnSecret: string;
}

export const EMPTY_PAYMENT_SETTINGS: PaymentSettings = {
  stripeEnabled: false,
  stripeSecretKey: '',
  stripePublishableKey: '',
  stripeWebhookSecret: '',
  nowpaymentsEnabled: false,
  nowpaymentsApiKey: '',
  nowpaymentsIpnSecret: '',
};

interface StoreData {
  products: Record<string, ProductRecord>;
  orders: OrderRecord[];
  paymentSettings: PaymentSettings;
}

/**
 * Service de persistance JSON — zéro dépendance native.
 * Écriture atomique via fichier temporaire.
 */
@Injectable()
export class StoreService implements OnModuleInit {
  private readonly logger = new Logger(StoreService.name);
  private readonly dbPath: string;
  private data: StoreData = { products: {}, orders: [], paymentSettings: { ...EMPTY_PAYMENT_SETTINGS } };
  private readOnly = false;

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
        this.data = {
          products: parsed.products ?? {},
          orders: parsed.orders ?? [],
          paymentSettings: { ...EMPTY_PAYMENT_SETTINGS, ...(parsed.paymentSettings ?? {}) },
        };
        this.logger.log(`Données chargées depuis ${this.dbPath}`);
      } else {
        this.persist();
        this.logger.log(`Nouveau fichier créé : ${this.dbPath}`);
      }
    } catch (err) {
      // Fichier illisible : ne JAMAIS repartir à vide puis l'écraser à la prochaine écriture (perte du catalogue,
      // des commandes et des clés de paiement). On le met de côté pour une récupération manuelle.
      const aside = `${this.dbPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.dbPath, aside);
        this.logger.error(`${this.dbPath} illisible — conservé sous ${aside} ; démarrage avec des données vides.`);
      } catch {
        this.logger.error(`${this.dbPath} illisible et impossible à mettre de côté — écritures désactivées pour ne rien écraser.`);
        this.readOnly = true;
      }
    }
  }

  // ─── Getters ─────────────────────────────────────────────────────────────────

  get products(): Record<string, ProductRecord> {
    return this.data.products;
  }

  get orders(): OrderRecord[] {
    return this.data.orders;
  }

  get paymentSettings(): PaymentSettings {
    return this.data.paymentSettings;
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

  setPaymentSettings(settings: PaymentSettings): void {
    this.data.paymentSettings = settings;
    this.persist();
  }

  /** Restaure toutes les données depuis un backup. */
  restoreData(snapshot: {
    products: Record<string, ProductRecord>;
    orders: OrderRecord[];
    paymentSettings?: PaymentSettings;
  }): void {
    this.data.products = snapshot.products;
    this.data.orders = snapshot.orders;
    if (snapshot.paymentSettings) this.data.paymentSettings = { ...EMPTY_PAYMENT_SETTINGS, ...snapshot.paymentSettings };
    this.persist();
  }

  // ─── Persistance ─────────────────────────────────────────────────────────────

  private persist(): void {
    if (this.readOnly) return;
    const tmp = this.dbPath + '.tmp';
    try {
      // 0600 : le fichier contient les clés des passerelles de paiement.
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.dbPath);
    } catch (err) {
      this.logger.error('Erreur de persistance :', err);
    }
  }
}
