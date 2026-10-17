import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export interface PromoResult {
  valid: boolean;
  reason?: string;
  code?: string;
  label?: string;
  effect?: number;
  kind?: string;
}

export interface PromoInput {
  code: string;
  user_id: string;
  user_email?: string;
  context: 'shop' | 'topup';
  amount?: number;
  items?: { product_id: string; unit_price: number; quantity: number }[];
  payment_method?: string;
  user_order_count?: number;
  ref?: string;
}

/**
 * Client HTTP de l'addon Codes promo (appels internes, X-Panel-Key). Tout est contrôlé côté serveur : le navigateur n'envoie
 * qu'un texte de code, jamais un montant de réduction.
 */
@Injectable()
export class PromoClient {
  private readonly logger = new Logger(PromoClient.name);
  private readonly baseUrl = (process.env.PROMO_URL ?? '').replace(/\/+$/, '');
  private readonly panelKey = process.env.PANEL_API_KEY ?? '';

  isConfigured(): boolean {
    return !!this.baseUrl;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const res = await fetch(`${this.baseUrl}/uhq-manifest.json`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return false;
      const m: any = await res.json().catch(() => ({}));
      return /promo/i.test(String(m?.name ?? ''));
    } catch {
      return false;
    }
  }

  private async call(path: string, body: unknown): Promise<any> {
    if (!this.baseUrl) throw new ServiceUnavailableException('PROMO_UNAVAILABLE');
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'X-Panel-Key': this.panelKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any)?.message ?? `HTTP ${res.status}`);
      return data;
    } catch (e: any) {
      this.logger.warn(`Addon Codes promo injoignable (${path}) : ${e?.message ?? e}`);
      throw new ServiceUnavailableException('PROMO_UNAVAILABLE');
    }
  }

  validate(input: PromoInput): Promise<PromoResult> {
    return this.call('/api/internal/validate', input);
  }

  consume(input: PromoInput & { ref: string }): Promise<PromoResult> {
    return this.call('/api/internal/consume', input);
  }

  /** Libération best-effort : un échec ne doit jamais bloquer l'annulation d'une commande. */
  async release(ref: string): Promise<void> {
    try {
      await this.call('/api/internal/release', { ref });
    } catch {
      /* journalisé par call() */
    }
  }
}
