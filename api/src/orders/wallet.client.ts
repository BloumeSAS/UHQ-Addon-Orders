import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';

/**
 * Client HTTP vers l'addon Wallet.
 *
 * L'addon Orders ne stocke aucun solde : il délègue tout à l'addon Wallet.
 * Les mutations de solde (débit à la commande, remboursement à l'annulation)
 * passent par POST {WALLET_URL}/api/wallet/internal/add, protégé par la même
 * clé PANEL_API_KEY que le système de backup — aucun token admin requis.
 *
 * Variables d'environnement :
 *   WALLET_URL     — base URL de l'addon Wallet (ex: https://wallet.dom.com)
 *   PANEL_API_KEY  — clé API du panel (déjà utilisée pour le backup des addons)
 */
@Injectable()
export class WalletClient {
  private readonly logger = new Logger(WalletClient.name);
  private readonly baseUrl = (process.env.WALLET_URL ?? '').replace(/\/+$/, '');
  private readonly panelKey = process.env.PANEL_API_KEY ?? '';

  /** L'URL du Wallet est-elle configurée (paiement potentiellement possible) ? */
  isConfigured(): boolean {
    return !!this.baseUrl;
  }

  /** L'addon Wallet est-il joignable et bien un Wallet ? */
  async isAvailable(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const res = await fetch(`${this.baseUrl}/uhq-manifest.json`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const manifest: any = await res.json().catch(() => ({}));
      return String(manifest?.name ?? '').toLowerCase() === 'wallet';
    } catch {
      return false;
    }
  }

  /** Lit le solde d'un utilisateur. */
  async getBalance(userId: string): Promise<{ balance: number; currency: string }> {
    // La lecture du solde est accessible à l'utilisateur lui-même (via son propre JWT).
    // Ici on appelle l'endpoint interne pour rester cohérent avec le pattern service.
    const data = await this.call('GET', `/api/wallet/balance?userId=${encodeURIComponent(userId)}`);
    return { balance: Number(data?.balance ?? 0), currency: String(data?.currency ?? 'EUR') };
  }

  /** Débite (montant positif → retiré du solde). Lève une erreur si solde insuffisant. */
  async debit(userId: string, amount: number, note: string): Promise<number> {
    return this.add(userId, -Math.abs(amount), note);
  }

  /** Crédite (remboursement). */
  async credit(userId: string, amount: number, note: string): Promise<number> {
    return this.add(userId, Math.abs(amount), note);
  }

  private async add(userId: string, amount: number, note: string): Promise<number> {
    const data = await this.call('POST', '/api/wallet/internal/add', { userId, amount, note });
    return Number(data?.balance ?? 0);
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('WALLET_URL non configuré — addon Wallet requis');
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-Panel-Key': this.panelKey,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
    } catch (err: any) {
      this.logger.error(`Wallet injoignable (${method} ${path}): ${err?.message}`);
      throw new ServiceUnavailableException('Addon Wallet injoignable');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data as any)?.message ?? (data as any)?.error ?? `Wallet HTTP ${res.status}`;
      throw new BadRequestException(Array.isArray(msg) ? msg.join(', ') : String(msg));
    }
    return data;
  }
}
