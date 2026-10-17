import { Injectable, Logger } from '@nestjs/common';

/**
 * Envoi d'un e-mail via le panel (POST /api/v1/mail/send, clé API du panel) : les modèles (texte, activation, en-tête / pied de page)
 * sont gérés dans Paramètres → SMTP & e-mails. `to` = e-mail d'un utilisateur du panel, ou « admins ». Silencieux en cas d'échec.
 */
@Injectable()
export class PanelMailClient {
  private readonly logger = new Logger(PanelMailClient.name);
  private readonly panelUrl = (process.env.PANEL_URL ?? 'http://localhost:8000').replace(/\/+$/, '');
  private readonly key = process.env.PANEL_API_KEY ?? '';

  send(template: string, to: string | undefined, vars: Record<string, string | number>): void {
    if (!this.key || !to) return;
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) safe[k] = String(v);
    void fetch(`${this.panelUrl}/api/v1/mail/send`, {
      method: 'POST',
      headers: { 'X-API-Key': this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template, to, vars: safe }),
      signal: AbortSignal.timeout(8000),
    }).catch((e) => this.logger.debug(`E-mail ${template} non envoyé : ${e?.message ?? e}`));
  }
}
