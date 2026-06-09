import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';

/**
 * Client HTTP vers l'addon Wallet.
 *
 * L'addon Orders ne stocke aucun solde : il délègue tout à l'addon Wallet.
 * Les mutations de solde (débit à la commande, remboursement à l'annulation)
 * passent par POST {WALLET_URL}/api/wallet/add, qui est réservé aux ADMIN —
 * d'où l'usage d'un token de service ADMIN (WALLET_SERVICE_TOKEN) pour les
 * appels serveur-à-serveur.
 *
 * Variables d'environnement :
 *   WALLET_URL            — base URL de l'addon Wallet (ex: https://wallet.dom.com)
 *   WALLET_SERVICE_TOKEN  — JWT d'un compte ADMIN du panel
 */
@Injectable()
export class WalletClient {
  private readonly logger = new Logger(WalletClient.name);
  private readonly baseUrl = (process.env.WALLET_URL ?? '').replace(/\/+$/, '');
  private readonly token = process.env.WALLET_SERVICE_TOKEN ?? '';

  /** Le token + l'URL sont-ils renseignés (paiement possible) ? */
  isConfigured(): boolean {
    return !!this.baseUrl && !!this.token;
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

  /** Lit le solde d'un utilisateur (le token de service ADMIN peut lire n'importe quel userId). */
  async getBalance(userId: string): Promise<{ balance: number; currency: string }> {
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
    const data = await this.call('POST', '/api/wallet/add', { userId, amount, note });
    return Number(data?.balance ?? 0);
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('WALLET_URL non configuré — addon Wallet requis');
    }
    if (!this.token) {
      throw new ServiceUnavailableException('WALLET_SERVICE_TOKEN non configuré — impossible de débiter le solde');
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
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
