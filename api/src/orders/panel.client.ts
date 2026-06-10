import { Injectable, Logger, ServiceUnavailableException, BadRequestException } from '@nestjs/common';

/**
 * Client HTTP vers le panel UHQ (API legacy `/api/v1`).
 *
 * Sert à la LIVRAISON automatique : après paiement, Orders crée un compte
 * proxy (UserProxy) sur le panel via POST /api/v1/sub-user/create, puis lit le
 * point d'entrée public (host:port) pour livrer des identifiants complets.
 *
 * Auth : header X-API-Key = PANEL_API_KEY (la clé `apiKey` maître du panel,
 * déjà partagée pour le backup). La clé maître a un accès total à `/api/v1`.
 *
 * Variables d'environnement :
 *   PANEL_URL      — base URL du panel (ex: https://panel.dom.com)
 *   PANEL_API_KEY  — clé API du panel
 */
export interface CreateSubUserSpec {
  label: string;
  threads_limit?: number;
  traffic_limit_bytes?: number;
  country_filter?: string;
  sticky_session_ttl?: number;
  bandwidth_limit?: number;
  expires_at?: string; // ISO date
  allowed_ips?: string;
  tags?: string;
  custom_proxies?: string;
}

export interface CreatedSubUser {
  id: string;
  username: string;
  password: string;
}

@Injectable()
export class PanelClient {
  private readonly logger = new Logger(PanelClient.name);
  private readonly baseUrl = (process.env.PANEL_URL ?? '').replace(/\/+$/, '');
  private readonly apiKey = process.env.PANEL_API_KEY ?? '';
  /** Cache du host:port public (rarement modifié). */
  private endpointCache: { host: string; port: string } | null = null;

  /** Le panel est-il configuré pour la livraison (URL + clé) ? */
  isConfigured(): boolean {
    return !!this.baseUrl && !!this.apiKey;
  }

  /** Lit le point d'entrée public du proxy (host:port), avec cache. */
  async getProxyEndpoint(): Promise<{ host: string; port: string }> {
    if (this.endpointCache) return this.endpointCache;
    const data = await this.call('GET', '/api/v1/sub-user/endpoint');
    const host = String(data?.data?.host ?? '').trim();
    const port = String(data?.data?.port ?? '').trim();
    this.endpointCache = { host, port };
    return this.endpointCache;
  }

  /** Bloque (révoque) un compte proxy sur le panel — best-effort. */
  async blockSubUser(id: string): Promise<void> {
    if (!id) return;
    await this.call('POST', '/api/v1/sub-user/set-blocked', { id, is_blocked: true });
  }

  /** Crée un compte proxy sur le panel et renvoie ses identifiants. */
  async createSubUser(spec: CreateSubUserSpec): Promise<CreatedSubUser> {
    const data = await this.call('POST', '/api/v1/sub-user/create', spec);
    const d = data?.data ?? {};
    if (!d.username || !d.password) {
      throw new BadRequestException('Réponse panel invalide à la création du compte');
    }
    return { id: String(d.id ?? ''), username: String(d.username), password: String(d.password) };
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('PANEL_URL non configuré — livraison impossible');
    }
    if (!this.apiKey) {
      throw new ServiceUnavailableException('PANEL_API_KEY non configuré — livraison impossible');
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: any) {
      this.logger.error(`Panel injoignable (${method} ${path}): ${err?.message}`);
      throw new ServiceUnavailableException('Panel injoignable pour la livraison');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data as any)?.message ?? (data as any)?.error ?? `Panel HTTP ${res.status}`;
      throw new BadRequestException(Array.isArray(msg) ? msg.join(', ') : String(msg));
    }
    return data;
  }
}
