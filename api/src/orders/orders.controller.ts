import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, Headers, HttpCode,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments/payments.service';
import { PanelAuthService } from './panel-auth.service';
import {
  CreateProductDto, UpdateProductDto, PlaceOrderDto, OrderStatusDto, UpdatePaymentSettingsDto,
} from './dto/orders.dto';

@Controller('api')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly auth: PanelAuthService,
  ) {}

  // ─── Wallet status ───────────────────────────────────────────────────────────

  /** GET /api/wallet-status — l'addon Wallet est-il joignable / configuré ? */
  @Get('wallet-status')
  async walletStatus(@Req() req: Request) {
    await this.auth.authenticate(req);
    return this.orders.walletStatus();
  }

  /** GET /api/balance — solde de l'utilisateur courant (proxy vers Wallet) */
  @Get('balance')
  async balance(@Req() req: Request) {
    const user = await this.auth.authenticate(req);
    return this.orders.getUserBalance(user.id);
  }

  /** GET /api/pools — catégories (ProxyPool) déclarées sur le panel (ADMIN). */
  @Get('pools')
  async listPools(@Req() req: Request) {
    await this.auth.requireAdmin(req);
    return { pools: await this.orders.listPools() };
  }

  // ─── Products ──────────────────────────────────────────────────────────────

  /** GET /api/products — catalogue (actifs ; admin : ?all=true inclut inactifs) */
  @Get('products')
  async listProducts(@Req() req: Request, @Query('all') all?: string) {
    const user = await this.auth.authenticate(req);
    const isAdmin = user.role === 'ADMIN';
    const list = this.orders.listProducts(isAdmin && all === 'true');
    // Les clients ne reçoivent jamais la configuration de livraison (listes de proxies privés, réglages internes).
    return { products: isAdmin ? list : list.map((p) => this.orders.toPublic(p)) };
  }

  /** POST /api/products — créer un produit (ADMIN) */
  @Post('products')
  @HttpCode(200)
  async createProduct(@Req() req: Request, @Body() dto: CreateProductDto) {
    await this.auth.requireAdmin(req);
    return { product: await this.orders.createProduct(dto) };
  }

  /** PATCH /api/products/:id — modifier un produit (ADMIN) */
  @Patch('products/:id')
  async updateProduct(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    await this.auth.requireAdmin(req);
    return { product: await this.orders.updateProduct(id, dto) };
  }

  /** DELETE /api/products/:id — supprimer un produit (ADMIN) */
  @Delete('products/:id')
  async deleteProduct(@Req() req: Request, @Param('id') id: string) {
    await this.auth.requireAdmin(req);
    this.orders.deleteProduct(id);
    return { success: true };
  }

  // ─── Orders ────────────────────────────────────────────────────────────────

  /**
   * GET /api/orders — commandes de l'utilisateur. Admin : `?all=true` → toutes, avec `status`, `q` (client, produit, id),
   * `limit` / `offset` (réponse `{ orders, total }` ; sans `limit`, toutes les commandes).
   */
  @Get('orders')
  async listOrders(
    @Req() req: Request,
    @Query('all') all?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const user = await this.auth.authenticate(req);
    if (user.role === 'ADMIN' && all === 'true') {
      return this.orders.queryOrders({
        status,
        q: typeof q === 'string' ? q.slice(0, 100) : undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
    }
    const orders = this.orders.userOrders(user.id);
    return { orders, total: orders.length };
  }

  /** GET /api/stats — indicateurs de la boutique (ADMIN). */
  @Get('stats')
  async stats(@Req() req: Request) {
    await this.auth.requireAdmin(req);
    return this.orders.stats();
  }

  /**
   * POST /api/orders — passer commande.
   * paymentMethod: 'wallet' (défaut) débite immédiatement et livre ; 'stripe'
   * / 'nowpayments' créent une commande 'pending' et renvoient `checkoutUrl`
   * vers laquelle le front doit rediriger l'acheteur (paiement confirmé plus
   * tard par webhook — voir /api/payments/*).
   */
  @Post('orders')
  @HttpCode(200)
  async placeOrder(@Req() req: Request, @Body() dto: PlaceOrderDto) {
    const user = await this.auth.authenticate(req);
    const { order, checkoutUrl } = await this.orders.checkout(
      { id: user.id, email: user.email }, dto.items, dto.paymentMethod ?? 'wallet', dto.successUrl, dto.cancelUrl,
    );
    return { success: true, order, checkoutUrl };
  }

  /** PATCH /api/orders/:id/status — changer le statut (ADMIN) ; annulation = remboursement */
  @Patch('orders/:id/status')
  async updateStatus(@Req() req: Request, @Param('id') id: string, @Body() dto: OrderStatusDto) {
    await this.auth.requireAdmin(req);
    const { order, manualRefundRequired } = await this.orders.updateStatus(id, dto.status);
    return { success: true, order, manualRefundRequired };
  }

  // ─── Paiement : méthodes disponibles + réglages (ADMIN) ─────────────────────

  /** GET /api/payments/methods — quelles passerelles sont actives (jamais de secret exposé). */
  @Get('payments/methods')
  async paymentMethods(@Req() req: Request) {
    await this.auth.authenticate(req);
    return this.payments.availableMethods();
  }

  /** GET /api/payments/settings — réglages passerelles (secrets masqués, ADMIN). */
  @Get('payments/settings')
  async getPaymentSettings(@Req() req: Request) {
    await this.auth.requireAdmin(req);
    return this.payments.getSettingsMasked();
  }

  /** PUT /api/payments/settings — met à jour les réglages (ADMIN). */
  @Post('payments/settings')
  @HttpCode(200)
  async updatePaymentSettings(@Req() req: Request, @Body() dto: UpdatePaymentSettingsDto) {
    await this.auth.requireAdmin(req);
    return this.payments.updateSettings(dto);
  }

  /**
   * GET /api/payments/settings/reveal?key=... — valeur en clair d'un secret.
   * N'est appelée que par le panel (server-to-server, port interne non exposé
   * publiquement), après confirmation du mot de passe admin côté panel.
   */
  @Get('payments/settings/reveal')
  async revealPaymentSecret(@Req() req: Request, @Query('key') key: string) {
    await this.auth.requireAdmin(req);
    return { value: this.payments.revealSecret(key) };
  }

  // ─── Webhooks (publics — appelés par Stripe / NOWPayments, pas par le panel) ─

  /**
   * POST /api/payments/stripe/webhook — corps BRUT (Buffer), voir main.ts :
   * `express.raw()` est monté sur cette route précise AVANT le body-parser
   * JSON global, requis par `stripe.webhooks.constructEvent`.
   */
  @Post('payments/stripe/webhook')
  @HttpCode(200)
  async stripeWebhook(@Req() req: Request, @Res() res: Response, @Headers('stripe-signature') sig?: string) {
    try {
      const event = this.payments.verifyStripeWebhook(req.body as Buffer, sig);
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as any;
        const orderId = session.metadata?.order_id;
        if (orderId) await this.orders.confirmExternalPayment(orderId);
      } else if (event.type === 'checkout.session.expired') {
        const session = event.data.object as any;
        const orderId = session.metadata?.order_id;
        if (orderId) await this.orders.failExternalPayment(orderId);
      }
      res.json({ received: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? 'Webhook invalide' });
    }
  }

  /**
   * POST /api/payments/nowpayments/webhook (IPN) — corps BRUT requis pour la
   * vérification HMAC (voir main.ts, même raison que Stripe ci-dessus).
   */
  @Post('payments/nowpayments/webhook')
  @HttpCode(200)
  async nowpaymentsWebhook(@Req() req: Request, @Res() res: Response, @Headers('x-nowpayments-sig') sig?: string) {
    try {
      const payload = this.payments.verifyNowPaymentsIpn(req.body as Buffer, sig);
      // NOWPayments réémet ici l'`order_id` qu'on lui a fourni à la création
      // de l'invoice (= notre propre OrderRecord.id) — PAS leur propre id de
      // paiement (celui-là est stocké en `payment_ref` côté nous, pour
      // référence uniquement, pas pour ce lookup).
      const order = this.orders.findById(String(payload.order_id ?? ''));
      if (order) {
        const status = String(payload.payment_status ?? '').toLowerCase();
        if (['finished', 'confirmed'].includes(status)) {
          await this.orders.confirmExternalPayment(order.id);
        } else if (['failed', 'expired', 'refunded'].includes(status)) {
          await this.orders.failExternalPayment(order.id);
        }
      }
      res.json({ received: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? 'IPN invalide' });
    }
  }
}
