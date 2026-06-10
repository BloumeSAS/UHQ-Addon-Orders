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
  @IsOptional() @IsString() @MaxLength(2000) allowed_ips?: string;
  @IsOptional() @IsString() @MaxLength(200) tags?: string;
  /**
   * Liste privée d'upstreams (1/ligne). Si renseignée → le compte créé utilise
   * CETTE liste (proxies dédiés). Vide → le compte utilise le pool partagé.
   */
  @IsOptional() @IsString() @MaxLength(20000) custom_proxies?: string;
}

/**
 * Config de livraison d'un produit.
 *  - 'none'          : aucune livraison automatique (produit informatif).
 *  - 'panel_account' : crée un compte proxy sur le panel à chaque unité commandée.
 */
export class DeliveryConfigDto {
  @IsIn(['none', 'panel_account'])
  mode!: 'none' | 'panel_account';

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
  currency?: string;

  /** Omis ou null → stock illimité. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryConfigDto)
  delivery?: DeliveryConfigDto;
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) price?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) stock?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @ValidateNested() @Type(() => DeliveryConfigDto) delivery?: DeliveryConfigDto;
}

export class OrderItemDto {
  @IsString()
  product_id!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  quantity!: number;
}

export class PlaceOrderDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}

export class OrderStatusDto {
  @IsIn(['paid', 'fulfilled', 'cancelled'])
  status!: 'paid' | 'fulfilled' | 'cancelled';
}
