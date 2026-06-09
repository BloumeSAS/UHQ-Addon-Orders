import {
  IsString, IsNumber, IsOptional, IsBoolean, IsInt, IsArray,
  IsIn, Min, Max, ValidateNested, ArrayNotEmpty, MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

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
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000) price?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) stock?: number;
  @IsOptional() @IsBoolean() active?: boolean;
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
