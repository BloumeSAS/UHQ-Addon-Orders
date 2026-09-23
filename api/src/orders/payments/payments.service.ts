import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { StoreService, PaymentSettings, OrderRecord } from '../store.service';

const SECRET_MASK = '••••••••';

/**
 * Passerelles de paiement externes (Stripe : carte ; NOWPayments : crypto) —
 * alternative au débit direct du solde Wallet. Une commande payée par l'une
 * de ces passerelles reste `pending` (pas débitée, pas livrée) tant que le
 * webhook correspondant n'a pas confirmé le paiement — voir
 * OrdersService.confirmExternalPayment / failExternalPayment.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private readonly store: StoreService) {}

  // ─── Settings (admin) ────────────────────────────────────────────────────────

  getSettingsMasked(): PaymentSettings {
    const s = this.store.paymentSettings;
    return {
      ...s,
      stripeSecretKey: s.stripeSecretKey ? SECRET_MASK : '',
      stripeWebhookSecret: s.stripeWebhookSecret ? SECRET_MASK : '',
      nowpaymentsApiKey: s.nowpaymentsApiKey ? SECRET_MASK : '',
      nowpaymentsIpnSecret: s.nowpaymentsIpnSecret ? SECRET_MASK : '',
    };
  }

  /** Publishable key Stripe uniquement — sûr à exposer à tout utilisateur authentifié (pas un secret). */
  async availableMethods(): Promise<{
    wallet: boolean;
    stripe: { enabled: boolean; publishableKey: string };
    nowpayments: { enabled: boolean };
  }> {
    const s = this.store.paymentSettings;
    return {
      wallet: true,
      stripe: {
        enabled: s.stripeEnabled && !!s.stripeSecretKey,
        publishableKey: s.stripeEnabled ? s.stripePublishableKey : '',
      },
      nowpayments: { enabled: s.nowpaymentsEnabled && !!s.nowpaymentsApiKey },
    };
  }

  updateSettings(patch: Partial<PaymentSettings>): PaymentSettings {
    const current = this.store.paymentSettings;
    const next: PaymentSettings = { ...current };

    // Ne jamais écraser un secret déjà enregistré par une valeur vide ou le
    // masque renvoyé par getSettingsMasked() — même garde que le panel
    // (SettingsService) pour scraperProxy/groqApiKey etc.
    const secretKeys: (keyof PaymentSettings)[] = [
      'stripeSecretKey', 'stripeWebhookSecret', 'nowpaymentsApiKey', 'nowpaymentsIpnSecret',
    ];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (secretKeys.includes(key as keyof PaymentSettings)) {
        const v = value as string;
        if (!v || v === SECRET_MASK) continue;
      }
      (next as any)[key] = value;
    }
    this.store.setPaymentSettings(next);
    return this.getSettingsMasked();
  }

  // ─── Stripe ──────────────────────────────────────────────────────────────────

  private stripeClient(): Stripe {
    const key = this.store.paymentSettings.stripeSecretKey;
    if (!this.store.paymentSettings.stripeEnabled || !key) {
      throw new ServiceUnavailableException('Paiement par carte (Stripe) non configuré');
    }
    return new Stripe(key);
  }

  /** Crée une Checkout Session Stripe pour le montant total de la commande. */
  async createStripeCheckout(order: OrderRecord, successUrl: string, cancelUrl: string): Promise<string> {
    const stripe = this.stripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: order.items.map((l) => ({
        price_data: {
          currency: order.currency.toLowerCase(),
          product_data: { name: l.name },
          // Stripe attend le plus petit sous-multiple (centimes) — 2 décimales max déjà garanties en amont.
          unit_amount: Math.round(l.unit_price * 100),
        },
        quantity: l.quantity,
      })),
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { order_id: order.id },
    });
    if (!session.url) throw new ServiceUnavailableException('Stripe n\'a pas renvoyé d\'URL de paiement');
    // payment_ref = session.id, utilisé pour réconcilier le webhook.
    order.payment_ref = session.id;
    return session.url;
  }

  /** Vérifie la signature du webhook Stripe et renvoie l'event si valide. */
  verifyStripeWebhook(rawBody: Buffer, signature: string | undefined): Stripe.Event {
    const secret = this.store.paymentSettings.stripeWebhookSecret;
    if (!secret) throw new BadRequestException('Webhook secret Stripe non configuré');
    if (!signature) throw new BadRequestException('Signature Stripe manquante');
    const stripe = this.stripeClient();
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err: any) {
      this.logger.warn(`Signature webhook Stripe invalide : ${err?.message}`);
      throw new BadRequestException('Signature webhook invalide');
    }
  }

  // ─── NOWPayments (crypto) ────────────────────────────────────────────────────

  /** Crée un paiement NOWPayments — renvoie l'URL de la page de paiement hébergée. */
  async createNowPayment(order: OrderRecord, successUrl: string, cancelUrl: string): Promise<string> {
    const s = this.store.paymentSettings;
    if (!s.nowpaymentsEnabled || !s.nowpaymentsApiKey) {
      throw new ServiceUnavailableException('Paiement crypto (NOWPayments) non configuré');
    }
    const res = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': s.nowpaymentsApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: order.total,
        price_currency: order.currency.toLowerCase(),
        order_id: order.id,
        order_description: `Commande ${order.id.slice(0, 8)}`,
        success_url: successUrl,
        cancel_url: cancelUrl,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`NOWPayments invoice échoué (${res.status}) : ${body}`);
      throw new ServiceUnavailableException('Impossible de créer le paiement crypto');
    }
    const json: any = await res.json();
    order.payment_ref = String(json.id);
    return json.invoice_url;
  }

  /** Vérifie la signature HMAC-SHA512 d'un callback IPN NOWPayments (voir leur doc). */
  verifyNowPaymentsIpn(rawBody: Buffer, signature: string | undefined): any {
    const secret = this.store.paymentSettings.nowpaymentsIpnSecret;
    if (!secret) throw new BadRequestException('Clé IPN NOWPayments non configurée');
    if (!signature) throw new BadRequestException('Signature NOWPayments manquante');

    const crypto = require('crypto');
    // NOWPayments signe le JSON avec les clés triées par ordre alphabétique.
    const parsed = JSON.parse(rawBody.toString('utf8'));
    const sorted = Object.keys(parsed).sort().reduce((acc: any, k) => { acc[k] = parsed[k]; return acc; }, {});
    const expected = crypto.createHmac('sha512', secret).update(JSON.stringify(sorted)).digest('hex');
    if (expected !== signature) {
      this.logger.warn('Signature IPN NOWPayments invalide');
      throw new BadRequestException('Signature invalide');
    }
    return parsed;
  }
}
