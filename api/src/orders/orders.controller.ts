import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, Headers, HttpCode, NotFoundException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments/payments.service';
import { PanelAuthService } from './panel-auth.service';
import { InvoiceService } from './invoice/invoice.service';
import { StoreService } from './store.service';
import {
  CreateProductDto, UpdateProductDto, PlaceOrderDto, OrderStatusDto, UpdatePaymentSettingsDto, RenewDto, BillingProfileDto,
} from './dto/orders.dto';

@Controller('api')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly auth: PanelAuthService,
    private readonly invoices: InvoiceService,
    private readonly store: StoreService,
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
      { id: user.id, email: user.email }, dto.items, dto.paymentMethod ?? 'wallet', dto.successUrl, dto.cancelUrl, dto.renew === true,
    );
    return { success: true, order, checkoutUrl };
  }

  /** PATCH /api/orders/:id/status — changer le statut (ADMIN) ; annulation = remboursement */
  @Patch('orders/:id/status')
  async updateStatus(@Req() req: Request, @Param('id') id: string, @Body() dto: OrderStatusDto) {
    const admin = await this.auth.requireAdmin(req);
    const { order, manualRefundRequired } = await this.orders.updateStatus(id, dto.status, admin.email || admin.id);
    return { success: true, order, manualRefundRequired };
  }

  /** POST /api/orders/:id/approve — valide une commande « à valider » : les comptes sont créés puis livrés (ADMIN). */
  @Post('orders/:id/approve')
  @HttpCode(200)
  async approve(@Req() req: Request, @Param('id') id: string) {
    const admin = await this.auth.requireAdmin(req);
    return { success: true, order: await this.orders.approve(id, admin.email || admin.id) };
  }

  /** GET /api/pending-approvals — commandes payées de l'utilisateur en attente de validation (sans aucun accès). */
  @Get('pending-approvals')
  async pendingApprovals(@Req() req: Request) {
    const user = await this.auth.authenticate(req);
    return { pending: this.orders.pendingApprovals(user.id) };
  }

  /** POST /api/orders/:id/renew — active / coupe le renouvellement automatique d'un compte livré (propriétaire). */
  @Post('orders/:id/renew')
  @HttpCode(200)
  async renew(@Req() req: Request, @Param('id') id: string, @Body() dto: RenewDto) {
    const user = await this.auth.authenticate(req);
    return { success: true, order: this.orders.setRenew(user.id, id, dto.index, dto.enabled) };
  }

  // ─── Factures / reçus ──────────────────────────────────────────────────────

  /** GET /api/invoice/status — la facturation est-elle activée ? (tout utilisateur connecté) */
  @Get('invoice/status')
  async invoiceStatus(@Req() req: Request) {
    await this.auth.authenticate(req);
    return { enabled: this.store.invoiceSettings.enabled };
  }

  /** GET /api/invoice/settings — réglages de facturation (ADMIN). */
  @Get('invoice/settings')
  async getInvoiceSettings(@Req() req: Request) {
    await this.auth.requireAdmin(req);
    return this.invoices.getSettings();
  }

  /** POST /api/invoice/settings — enregistre les réglages de facturation (ADMIN). */
  @Post('invoice/settings')
  @HttpCode(200)
  async setInvoiceSettings(@Req() req: Request, @Body() body: Record<string, any>) {
    await this.auth.requireAdmin(req);
    return this.invoices.updateSettings(body ?? {});
  }

  /** GET /api/invoice/preview?kind=invoice|receipt&lang=fr|en — PDF d'exemple avec les réglages enregistrés (ADMIN). */
  @Get('invoice/preview')
  async invoicePreview(@Req() req: Request, @Res() res: Response, @Query('kind') kind?: string, @Query('lang') lang?: string) {
    await this.auth.requireAdmin(req);
    const buf = await this.invoices.preview(kind === 'receipt' ? 'receipt' : 'invoice', lang === 'en' ? 'en' : 'fr');
    this.sendPdf(res, buf, 'preview.pdf');
  }

  /** GET /api/billing-profile — coordonnées de facturation du client. */
  @Get('billing-profile')
  async getBilling(@Req() req: Request) {
    const user = await this.auth.authenticate(req);
    return { profile: this.store.billingProfile(user.id) ?? { name: '', company: '', address: '', vat_number: '' } };
  }

  /** POST /api/billing-profile — enregistre les coordonnées de facturation du client. */
  @Post('billing-profile')
  @HttpCode(200)
  async setBilling(@Req() req: Request, @Body() dto: BillingProfileDto) {
    const user = await this.auth.authenticate(req);
    const profile = {
      name: (dto.name ?? '').trim(), company: (dto.company ?? '').trim(),
      address: (dto.address ?? '').trim(), vat_number: (dto.vat_number ?? '').trim(),
    };
    this.store.setBillingProfile(user.id, profile);
    return { profile };
  }

  /**
   * GET /api/orders/:id/document?kind=invoice|receipt&payment=<id>&lang=fr|en — PDF d'un encaissement (propriétaire ou admin).
   * Une commande non payée n'a ni reçu ni facture.
   */
  @Get('orders/:id/document')
  async document(
    @Req() req: Request, @Res() res: Response, @Param('id') id: string,
    @Query('kind') kind?: string, @Query('payment') paymentId?: string, @Query('lang') lang?: string,
  ) {
    const user = await this.auth.authenticate(req);
    const order = this.orders.orderFor(user, id);
    const payment = this.invoices.paymentFor(order, paymentId);
    if (!payment) throw new NotFoundException('Aucun paiement pour cette commande');
    const docKind = kind === 'receipt' ? 'receipt' : 'invoice';
    if (docKind === 'invoice') this.orders.ensureInvoiceNumber(order, payment);
    const buf = await this.invoices.render(order, payment, docKind, lang === 'en' ? 'en' : 'fr', this.store.billingProfile(order.user_id));
    this.sendPdf(res, buf, `${docKind === 'invoice' ? (payment.invoice_number ?? 'facture') : 'recu-' + order.id.slice(0, 8)}.pdf`);
  }

  private sendPdf(res: Response, buf: Buffer, name: string): void {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\w.\-]/g, '_')}"`);
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
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
   * POST /api/payments/paypal/ipn — IPN PayPal (public, corps BRUT). Rien n'est cru avant que PayPal ait répondu VERIFIED
   * au renvoi du corps ; ensuite OrdersService.handlePaypalIpn contrôle destinataire, devise, montant, F&F et doublon.
   */
  @Post('payments/paypal/ipn')
  @HttpCode(200)
  async paypalIpn(@Req() req: Request, @Res() res: Response) {
    try {
      const fields = await this.payments.verifyPaypalIpn(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      const result = await this.orders.handlePaypalIpn(fields);
      res.json({ received: true, result });
    } catch (err: any) {
      res.status(typeof err?.getStatus === 'function' ? err.getStatus() : 500).json({ error: err?.message ?? 'IPN invalide' });
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
