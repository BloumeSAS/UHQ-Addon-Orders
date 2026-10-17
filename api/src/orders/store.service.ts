import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export type ExpiresUnit = 'day' | 'month' | 'year';

/** Specs du compte proxy créé sur le panel à la livraison (toutes optionnelles). */
export interface DeliveryAccount {
  threads_limit?: number;
  traffic_limit_bytes?: number;
  country_filter?: string;
  sticky_session_ttl?: number;
  bandwidth_limit?: number;
  /** Durée de validité : valeur (0 / absent = jamais) exprimée dans `expires_unit` (défaut : jours). */
  expires_days?: number;
  expires_unit?: ExpiresUnit;
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
  /** 'manual' = la commande payée attend la validation d'un admin avant la création du compte. Défaut : 'auto'. */
  approval?: 'auto' | 'manual';
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
  /** Les comptes livrés peuvent être renouvelés automatiquement (solde Wallet) quand le client l'active. */
  renewal_enabled?: boolean;
  /** 'per_gb' : `price` = prix d'UN Go et le client choisit la quantité de Go (bornes ci-dessous). Défaut : prix fixe. */
  pricing?: 'fixed' | 'per_gb';
  /** Vente au Go : minimum / maximum de Go (max 0 = pas de plafond) et pas de la sélection. */
  per_gb?: { min_gb: number; max_gb: number; step_gb: number };
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  product_id: string;
  name: string;
  unit_price: number;
  quantity: number;
  /** Vente au Go : quantité de Go choisie (le prix de la ligne est déjà `unit_price` = prix du Go × Go). */
  gb?: number;
  /** Livraison + option de renouvellement FIGÉES à la commande (la livraison validée plus tard / les renouvellements les utilisent). */
  snapshot?: { delivery: DeliveryConfig; renewal_enabled: boolean };
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
  /** Date d'expiration du compte (absent = sans expiration). */
  expires_at?: string;
  /** Renouvellement automatique activé par le client (solde Wallet). */
  renew?: boolean;
  /** Configuration ET prix figés AU MOMENT DE L'ACHAT : un renouvellement n'utilise jamais la config actuelle du produit. */
  renewal?: RenewalState;
}

export interface RenewalState {
  unit_price: number;
  currency: string;
  product_name: string;
  account: DeliveryAccount;
  count: number;
  last_at?: string;
  failed_at?: string;
  last_error?: string;
}

/**
 * 'pending' : commande créée pour un paiement externe (Stripe/NOWPayments)
 * en attente de confirmation webhook — pas encore débitée, pas livrée.
 * N'existe jamais pour un paiement Wallet (débit synchrone à la commande).
 */
export type OrderStatus = 'pending' | 'review' | 'paid' | 'fulfilled' | 'cancelled';
export type PaymentMethod = 'wallet' | 'stripe' | 'nowpayments' | 'paypal';

/** Un encaissement rattaché à une commande (paiement initial ou renouvellement) — une facture / un reçu par encaissement. */
export interface PaymentEvent {
  id: string;
  kind: 'initial' | 'renewal';
  amount: number;
  currency: string;
  at: string;
  method: PaymentMethod;
  description: string;
  invoice_number?: string;
}

/** Paiement PayPal Amis & Famille : consignes affichées au client puis rapprochement par l'IPN. */
export interface PaypalInfo {
  email: string;
  note: string;
  txn_id?: string;
  payer_email?: string;
  payer_name?: string;
}

export interface OrderRecord {
  id: string;
  user_id: string;
  /** E-mail du client au moment de la commande (affichage admin). */
  user_email?: string;
  /** Encaissements (paiement initial + renouvellements). Absent des commandes d'avant la v1.4.0 : le paiement initial est alors implicite. */
  payments?: PaymentEvent[];
  /** Numéro de facture du paiement initial (si la facturation était activée). */
  invoice_number?: string;
  /** Le client a demandé le renouvellement automatique à la commande. */
  renew?: boolean;
  paypal?: PaypalInfo;
  /** 'topup' = recharge du solde Wallet payée par une passerelle externe (aucune livraison de compte). */
  kind?: 'shop' | 'topup';
  /** Total avant code promo (absent si aucun code). */
  subtotal?: number;
  /** Code promo appliqué : montant déduit et référence d'utilisation côté addon Codes promo. */
  promo?: { code: string; amount: number; ref: string };
  /** Recharge : montant payé, crédit final versé au Wallet, dont bonus (offre + code promo). */
  topup?: { paid: number; credit: number; base_credit: number; bonus: number };
  /** Alerte : PayPal a signalé un remboursement / une contestation de ce paiement (à vérifier par l'admin). */
  payment_alert?: string;
  approved_by?: string;
  approved_at?: string;
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
  /** PayPal « Amis & Famille » : le client envoie le montant exact à cet e-mail avec la note indiquée ; l'IPN valide. */
  paypalEnabled: boolean;
  paypalEmail: string;
  /** Une commande PayPal non payée est annulée (stock rendu) après ce délai, en heures. */
  paypalTimeoutHours: number;
}

export const EMPTY_PAYMENT_SETTINGS: PaymentSettings = {
  stripeEnabled: false,
  stripeSecretKey: '',
  stripePublishableKey: '',
  stripeWebhookSecret: '',
  nowpaymentsEnabled: false,
  nowpaymentsApiKey: '',
  nowpaymentsIpnSecret: '',
  paypalEnabled: false,
  paypalEmail: '',
  paypalTimeoutHours: 24,
};

/** Facturation PDF (reçus et factures) — réglée par l'admin dans Paramètres → Extensions du panel. */
export interface InvoiceSettings {
  enabled: boolean;
  company_name: string;
  legal_form: string;
  address: string;
  registration_id: string;
  vat_number: string;
  email: string;
  phone: string;
  website: string;
  /** Logo en data URL (PNG/JPEG, ≤ 300 Ko) — jamais téléchargé depuis une URL externe. */
  logo_data_url: string;
  accent_color: string;
  invoice_title: string;
  number_prefix: string;
  number_include_year: boolean;
  number_padding: number;
  next_number: number;
  /** Taux de TVA (%) ; 0 = pas de TVA (la mention d'exonération est alors imprimée). */
  vat_rate: number;
  prices_include_vat: boolean;
  vat_exemption_note: string;
  payment_terms: string;
  footer_text: string;
}

export const EMPTY_INVOICE_SETTINGS: InvoiceSettings = {
  enabled: false,
  company_name: '',
  legal_form: '',
  address: '',
  registration_id: '',
  vat_number: '',
  email: '',
  phone: '',
  website: '',
  logo_data_url: '',
  accent_color: '#e5532d',
  invoice_title: '',
  number_prefix: 'FAC-',
  number_include_year: true,
  number_padding: 5,
  next_number: 1,
  vat_rate: 0,
  prices_include_vat: true,
  vat_exemption_note: 'TVA non applicable, art. 293 B du CGI',
  payment_terms: 'Payé',
  footer_text: '',
};

/** Coordonnées de facturation d'un client (facultatives) — saisies par lui, utilisées sur ses factures. */
export interface BillingProfile {
  name: string;
  company: string;
  address: string;
  vat_number: string;
}

interface StoreData {
  products: Record<string, ProductRecord>;
  orders: OrderRecord[];
  paymentSettings: PaymentSettings;
  invoiceSettings: InvoiceSettings;
  billingProfiles: Record<string, BillingProfile>;
  /** Identifiants de transactions PayPal déjà traités (un IPN peut être renvoyé plusieurs fois). */
  paypalTxns: string[];
}

/**
 * Service de persistance JSON — zéro dépendance native.
 * Écriture atomique via fichier temporaire.
 */
@Injectable()
export class StoreService implements OnModuleInit {
  private readonly logger = new Logger(StoreService.name);
  private readonly dbPath: string;
  private data: StoreData = {
    products: {}, orders: [], paymentSettings: { ...EMPTY_PAYMENT_SETTINGS },
    invoiceSettings: { ...EMPTY_INVOICE_SETTINGS }, billingProfiles: {}, paypalTxns: [],
  };
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
          invoiceSettings: { ...EMPTY_INVOICE_SETTINGS, ...(parsed.invoiceSettings ?? {}) },
          billingProfiles: parsed.billingProfiles && typeof parsed.billingProfiles === 'object' ? parsed.billingProfiles : {},
          paypalTxns: Array.isArray(parsed.paypalTxns) ? parsed.paypalTxns : [],
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

  get invoiceSettings(): InvoiceSettings {
    return this.data.invoiceSettings;
  }

  billingProfile(userId: string): BillingProfile | undefined {
    return this.data.billingProfiles[userId];
  }

  allBillingProfiles(): Record<string, BillingProfile> {
    return this.data.billingProfiles;
  }

  paypalTxnList(): string[] {
    return this.data.paypalTxns;
  }

  setBillingProfile(userId: string, profile: BillingProfile): void {
    this.data.billingProfiles[userId] = profile;
    this.persist();
  }

  setInvoiceSettings(settings: InvoiceSettings): void {
    this.data.invoiceSettings = settings;
    this.persist();
  }

  /** Numéro de facture suivant (compteur persistant, jamais réutilisé). */
  nextInvoiceNumber(): string {
    const st = this.data.invoiceSettings;
    const n = Math.max(1, Math.floor(st.next_number || 1));
    st.next_number = n + 1;
    this.persist();
    const year = st.number_include_year ? `${new Date().getUTCFullYear()}-` : '';
    return `${st.number_prefix || ''}${year}${String(n).padStart(Math.max(1, Math.min(10, st.number_padding || 5)), '0')}`;
  }

  /** true si la transaction PayPal est nouvelle (et la mémorise) ; false si déjà traitée. */
  claimPaypalTxn(txnId: string): boolean {
    if (this.data.paypalTxns.includes(txnId)) return false;
    this.data.paypalTxns.push(txnId);
    if (this.data.paypalTxns.length > 20_000) this.data.paypalTxns = this.data.paypalTxns.slice(-20_000);
    this.persist();
    return true;
  }

  /** Libère une transaction PayPal mémorisée (livraison échouée : l'IPN renvoyé doit pouvoir être retraité). */
  unclaimPaypalTxn(txnId: string): void {
    this.data.paypalTxns = this.data.paypalTxns.filter((t) => t !== txnId);
    this.persist();
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
    invoiceSettings?: InvoiceSettings;
    billingProfiles?: Record<string, BillingProfile>;
    paypalTxns?: string[];
  }): void {
    this.data.products = snapshot.products;
    this.data.orders = snapshot.orders;
    if (snapshot.paymentSettings) this.data.paymentSettings = { ...EMPTY_PAYMENT_SETTINGS, ...snapshot.paymentSettings };
    if (snapshot.invoiceSettings) this.data.invoiceSettings = { ...EMPTY_INVOICE_SETTINGS, ...snapshot.invoiceSettings };
    if (snapshot.billingProfiles) this.data.billingProfiles = snapshot.billingProfiles;
    if (snapshot.paypalTxns) this.data.paypalTxns = snapshot.paypalTxns;
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
