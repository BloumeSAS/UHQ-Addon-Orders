import {
  IsString, IsNumber, IsOptional, IsBoolean, IsInt, IsArray,
  IsIn, Min, Max, ValidateNested, ArrayNotEmpty, MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Spécifications du compte proxy créé sur le panel à la livraison.
 * Toutes optionnelles : ce qui n'est pas renseigné prend les défauts du panel.
 */
export class DeliveryAccountDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) threads_limit?: number;
  /** Limite de trafic en octets (0/omis = illimité). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) traffic_limit_bytes?: number;
  @IsOptional() @IsString() @MaxLength(200) country_filter?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) sticky_session_ttl?: number;
  /** Bande passante max (ko/s), 0/omis = illimité. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) bandwidth_limit?: number;
  /** Durée de validité en jours à partir de l'achat (0/omis = sans expiration). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(3650) expires_days?: number;
  /** Unité de `expires_days` : jours (défaut), mois ou années. */
  @IsOptional() @IsIn(['day', 'month', 'year']) expires_unit?: 'day' | 'month' | 'year';
  @IsOptional() @IsString() @MaxLength(2000) allowed_ips?: string;
  @IsOptional() @IsString() @MaxLength(200) tags?: string;
  /**
   * Liste privée d'upstreams (1/ligne). Si renseignée → le compte créé utilise
   * CETTE liste (proxies dédiés). Vide → le compte utilise le pool partagé.
   */
  @IsOptional() @IsString() @MaxLength(20000) custom_proxies?: string;
  /** Catégorie (ProxyPool) du panel où piocher ; vide = pool global. Ignoré si `custom_proxies` est renseigné. */
  @IsOptional() @IsString() @MaxLength(64) pool?: string;
}

/**
 * Config de livraison d'un produit.
 *  - 'none'          : aucune livraison automatique (produit informatif).
 *  - 'panel_account' : crée un compte proxy sur le panel à chaque unité commandée.
 */
export class DeliveryConfigDto {
  @IsIn(['none', 'panel_account'])
  mode!: 'none' | 'panel_account';

  /** 'manual' = la commande payée attend la validation d'un admin avant la création du compte. */
  @IsOptional()
  @IsIn(['auto', 'manual'])
  approval?: 'auto' | 'manual';

  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryAccountDto)
  account?: DeliveryAccountDto;
}

export class CreateProductDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  price!: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  /** Omis ou null → stock illimité. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  stock?: number | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryConfigDto)
  delivery?: DeliveryConfigDto;

  /** Les comptes livrés peuvent être renouvelés automatiquement (solde Wallet). */
  @IsOptional()
  @IsBoolean()
  renewal_enabled?: boolean;

  /** 'per_gb' : le prix est celui d'un Go et le client choisit la quantité (livraison « compte proxy » requise). */
  @IsOptional() @IsIn(['fixed', 'per_gb']) pricing?: 'fixed' | 'per_gb';
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100_000) min_gb?: number;
  /** 0 = pas de plafond. */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) max_gb?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100_000) step_gb?: number;
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) price?: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  /** `null` = repasser en stock illimité ; omis = inchangé. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000_000) stock?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @ValidateNested() @Type(() => DeliveryConfigDto) delivery?: DeliveryConfigDto;
  @IsOptional() @IsBoolean() renewal_enabled?: boolean;
  @IsOptional() @IsIn(['fixed', 'per_gb']) pricing?: 'fixed' | 'per_gb';
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100_000) min_gb?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) max_gb?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100_000) step_gb?: number;
}

export class OrderItemDto {
  @IsString()
  product_id!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  quantity!: number;

  /** Vente au Go : quantité de Go souhaitée (obligatoire pour un produit « au Go »). */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(1_000_000) gb?: number;
}

export class PlaceOrderDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  /** Défaut 'wallet' (comportement historique — débit synchrone du solde). */
  @IsOptional()
  @IsIn(['wallet', 'stripe', 'nowpayments', 'paypal'])
  paymentMethod?: 'wallet' | 'stripe' | 'nowpayments' | 'paypal';

  /** Le client active le renouvellement automatique (solde Wallet) des produits qui le proposent. */
  @IsOptional() @IsBoolean() renew?: boolean;

  /** Code promo de réduction (addon Codes promo) — contrôlé et appliqué côté serveur. */
  @IsOptional() @IsString() @MaxLength(60) promo_code?: string;

  /** Requis pour stripe/nowpayments — URL de retour après paiement. */
  @IsOptional() @IsString() @MaxLength(2000) successUrl?: string;
  @IsOptional() @IsString() @MaxLength(2000) cancelUrl?: string;
}

export class OrderStatusDto {
  @IsIn(['pending', 'review', 'paid', 'fulfilled', 'cancelled'])
  status!: 'pending' | 'review' | 'paid' | 'fulfilled' | 'cancelled';
}

export class UpdatePaymentSettingsDto {
  @IsOptional() @IsBoolean() stripeEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(500) stripeSecretKey?: string;
  @IsOptional() @IsString() @MaxLength(500) stripePublishableKey?: string;
  @IsOptional() @IsString() @MaxLength(500) stripeWebhookSecret?: string;
  @IsOptional() @IsBoolean() nowpaymentsEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(500) nowpaymentsApiKey?: string;
  @IsOptional() @IsString() @MaxLength(500) nowpaymentsIpnSecret?: string;
  @IsOptional() @IsBoolean() paypalEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(254) paypalEmail?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(168) paypalTimeoutHours?: number;
}

export class RenewDto {
  @IsInt() @Min(0) @Max(100_000) index!: number;
  @IsBoolean() enabled!: boolean;
}

export class BillingProfileDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(120) company?: string;
  @IsOptional() @IsString() @MaxLength(400) address?: string;
  @IsOptional() @IsString() @MaxLength(40) vat_number?: string;
}

/** Devis : total d'un panier avec un code promo, sans rien créer. */
export class QuoteDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @IsOptional() @IsIn(['wallet', 'stripe', 'nowpayments', 'paypal']) paymentMethod?: 'wallet' | 'stripe' | 'nowpayments' | 'paypal';
  @IsOptional() @IsString() @MaxLength(60) promo_code?: string;
}

/** Recharge du solde payée via les passerelles d'Orders (appelée par l'addon Wallet — X-Panel-Key). */
export class TopupDto {
  @IsString() @MaxLength(120) user_id!: string;
  @IsOptional() @IsString() @MaxLength(254) user_email?: string;
  /** Montant payé par le client. */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.5) @Max(1_000_000) amount!: number;
  /** Crédit versé avant code promo (montant + bonus de palier calculé par le Wallet). */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.5) @Max(10_000_000) base_credit!: number;
  @IsOptional() @IsString() @MaxLength(60) promo_code?: string;
  @IsIn(['stripe', 'nowpayments', 'paypal']) paymentMethod!: 'stripe' | 'nowpayments' | 'paypal';
  @IsOptional() @IsString() @MaxLength(2000) successUrl?: string;
  @IsOptional() @IsString() @MaxLength(2000) cancelUrl?: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
}
