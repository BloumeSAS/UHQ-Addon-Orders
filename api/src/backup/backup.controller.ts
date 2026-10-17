import {
  Controller, Get, Post, Body, Headers, Logger,
} from '@nestjs/common';
import { StoreService } from '../orders/store.service';
import { PanelAuthService } from '../orders/panel-auth.service';

/**
 * Backup Controller — intégration avec le système de backup du panel UHQ.
 *
 * Le panel appelle ces endpoints lors de ses sauvegardes/restaurations.
 * Auth : header X-Panel-Key contenant la clé API du panel.
 *
 * Déclaré dans uhq-manifest.json :
 *   "backup": {
 *     "exportEndpoint":  "/api/backup/export",
 *     "importEndpoint":  "/api/backup/import",
 *     "authHeader":      "X-Panel-Key"
 *   }
 */
@Controller('api/backup')
export class BackupController {
  private readonly logger = new Logger(BackupController.name);

  constructor(
    private readonly store: StoreService,
    private readonly auth: PanelAuthService,
  ) {}

  /** Clé du panel obligatoire (refusé si non configurée), comparaison à temps constant. */
  private checkAuth(key: string | undefined) {
    this.auth.requirePanelKey(key);
  }

  /** GET /api/backup/export — retourne tout le catalogue + les commandes. */
  @Get('export')
  export(@Headers('x-panel-key') key: string) {
    this.checkAuth(key);
    const data = {
      products:   Object.values(this.store.products),
      orders:     this.store.orders,
      // Les clés des passerelles de paiement ne sont volontairement PAS exportées : à ressaisir après une restauration.
      invoiceSettings: this.store.invoiceSettings,
      billingProfiles: this.store.allBillingProfiles(),
      paypalTxns: this.store.paypalTxnList(),
      exportedAt: new Date().toISOString(),
    };
    this.logger.log(`Backup export: ${data.products.length} produits, ${data.orders.length} commandes`);
    return data;
  }

  /** POST /api/backup/import — restaure le catalogue + les commandes. */
  @Post('import')
  import(
    @Headers('x-panel-key') key: string,
    @Body() body: { products?: any[]; orders?: any[]; invoiceSettings?: any; billingProfiles?: any; paypalTxns?: any },
  ) {
    this.checkAuth(key);

    const products: Record<string, any> = {};
    for (const p of Array.isArray(body?.products) ? body.products : []) if (p && typeof p.id === 'string') products[p.id] = p;

    this.store.restoreData({
      products,
      orders: Array.isArray(body?.orders) ? body.orders : [],
      invoiceSettings: body?.invoiceSettings && typeof body.invoiceSettings === 'object' ? body.invoiceSettings : undefined,
      billingProfiles: body?.billingProfiles && typeof body.billingProfiles === 'object' ? body.billingProfiles : undefined,
      paypalTxns: Array.isArray(body?.paypalTxns) ? body.paypalTxns.filter((x: unknown) => typeof x === 'string') : undefined,
    });

    this.logger.log(
      `Backup import: ${Object.keys(products).length} produits, ${(body.orders ?? []).length} commandes`,
    );

    return { success: true, restored: Object.keys(products).length };
  }
}
