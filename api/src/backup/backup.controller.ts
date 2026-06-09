import {
  Controller, Get, Post, Body, Headers, ForbiddenException, Logger,
} from '@nestjs/common';
import { StoreService } from '../orders/store.service';

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

  constructor(private readonly store: StoreService) {}

  private checkAuth(key: string | undefined) {
    const expected = process.env.PANEL_API_KEY;
    if (!expected) {
      this.logger.warn('PANEL_API_KEY non configuré — backup non protégé');
      return; // permissif si non configuré (dev)
    }
    if (key !== expected) throw new ForbiddenException('Clé API invalide');
  }

  /** GET /api/backup/export — retourne tout le catalogue + les commandes. */
  @Get('export')
  export(@Headers('x-panel-key') key: string) {
    this.checkAuth(key);
    const data = {
      products:   Object.values(this.store.products),
      orders:     this.store.orders,
      exportedAt: new Date().toISOString(),
    };
    this.logger.log(`Backup export: ${data.products.length} produits, ${data.orders.length} commandes`);
    return data;
  }

  /** POST /api/backup/import — restaure le catalogue + les commandes. */
  @Post('import')
  import(
    @Headers('x-panel-key') key: string,
    @Body() body: { products?: any[]; orders?: any[] },
  ) {
    this.checkAuth(key);

    const products: Record<string, any> = {};
    for (const p of body.products ?? []) products[p.id] = p;

    this.store.restoreData({
      products,
      orders: body.orders ?? [],
    });

    this.logger.log(
      `Backup import: ${Object.keys(products).length} produits, ${(body.orders ?? []).length} commandes`,
    );

    return { success: true, restored: Object.keys(products).length };
  }
}
