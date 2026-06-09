import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, HttpCode,
} from '@nestjs/common';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import { authenticate, requireAdmin } from './auth';
import {
  CreateProductDto, UpdateProductDto, PlaceOrderDto, OrderStatusDto,
} from './dto/orders.dto';

@Controller('api')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // ─── Wallet status ───────────────────────────────────────────────────────────

  /** GET /api/wallet-status — l'addon Wallet est-il joignable / configuré ? */
  @Get('wallet-status')
  async walletStatus(@Req() req: Request) {
    authenticate(req);
    return this.orders.walletStatus();
  }

  /** GET /api/balance — solde de l'utilisateur courant (proxy vers Wallet) */
  @Get('balance')
  async balance(@Req() req: Request) {
    const { sub } = authenticate(req);
    return this.orders.getUserBalance(sub);
  }

  // ─── Products ──────────────────────────────────────────────────────────────

  /** GET /api/products — catalogue (actifs ; admin : ?all=true inclut inactifs) */
  @Get('products')
  listProducts(@Req() req: Request, @Query('all') all?: string) {
    const payload = authenticate(req);
    const includeInactive = payload.role === 'ADMIN' && all === 'true';
    return { products: this.orders.listProducts(includeInactive) };
  }

  /** POST /api/products — créer un produit (ADMIN) */
  @Post('products')
  @HttpCode(200)
  createProduct(@Req() req: Request, @Body() dto: CreateProductDto) {
    requireAdmin(req);
    return { product: this.orders.createProduct(dto) };
  }

  /** PATCH /api/products/:id — modifier un produit (ADMIN) */
  @Patch('products/:id')
  updateProduct(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    requireAdmin(req);
    return { product: this.orders.updateProduct(id, dto) };
  }

  /** DELETE /api/products/:id — supprimer un produit (ADMIN) */
  @Delete('products/:id')
  deleteProduct(@Req() req: Request, @Param('id') id: string) {
    requireAdmin(req);
    this.orders.deleteProduct(id);
    return { success: true };
  }

  // ─── Orders ────────────────────────────────────────────────────────────────

  /** GET /api/orders — commandes de l'utilisateur (admin : ?all=true → toutes) */
  @Get('orders')
  listOrders(@Req() req: Request, @Query('all') all?: string) {
    const payload = authenticate(req);
    const seeAll = payload.role === 'ADMIN' && all === 'true';
    return { orders: seeAll ? this.orders.allOrders() : this.orders.userOrders(payload.sub) };
  }

  /** POST /api/orders — passer commande, payée avec le solde Wallet */
  @Post('orders')
  @HttpCode(200)
  async placeOrder(@Req() req: Request, @Body() dto: PlaceOrderDto) {
    const { sub } = authenticate(req);
    const order = await this.orders.placeOrder(sub, dto.items);
    return { success: true, order };
  }

  /** PATCH /api/orders/:id/status — changer le statut (ADMIN) ; annulation = remboursement */
  @Patch('orders/:id/status')
  async updateStatus(@Req() req: Request, @Param('id') id: string, @Body() dto: OrderStatusDto) {
    requireAdmin(req);
    const order = await this.orders.updateStatus(id, dto.status);
    return { success: true, order };
  }
}
