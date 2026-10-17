import { BadRequestException, Injectable } from '@nestjs/common';
import PDFDocument = require('pdfkit');
import { BillingProfile, InvoiceSettings, OrderRecord, PaymentEvent, PaymentMethod, StoreService } from '../store.service';

export type DocKind = 'invoice' | 'receipt';
type Lang = 'fr' | 'en';

const T: Record<Lang, Record<string, string>> = {
  fr: {
    invoice: 'FACTURE', receipt: 'REÇU DE PAIEMENT', number: 'N°', date: 'Date', order: 'Commande', billedTo: 'Facturé à', customer: 'Client',
    description: 'Désignation', qty: 'Qté', unit: 'Prix unitaire', total: 'Total', subtotal: 'Total HT', vat: 'TVA', grand: 'Total TTC', grandNoVat: 'Total',
    paid: 'Payé', paidOn: 'Payé le', by: 'par', ref: 'Référence', renewal: 'Renouvellement', terms: 'Conditions', vatNo: 'TVA', regNo: 'SIRET / RCS',
    page: 'Page', of: 'sur', nonFiscal: 'Ce reçu atteste du paiement reçu.', preview: 'APERÇU', sampleProduct: 'Produit exemple', sampleCustomer: 'client@exemple.com',
    'm.wallet': 'Solde Wallet', 'm.stripe': 'Carte bancaire', 'm.nowpayments': 'Cryptomonnaie', 'm.paypal': 'PayPal',
  },
  en: {
    invoice: 'INVOICE', receipt: 'PAYMENT RECEIPT', number: 'No.', date: 'Date', order: 'Order', billedTo: 'Billed to', customer: 'Customer',
    description: 'Description', qty: 'Qty', unit: 'Unit price', total: 'Total', subtotal: 'Subtotal', vat: 'VAT', grand: 'Total incl. VAT', grandNoVat: 'Total',
    paid: 'Paid', paidOn: 'Paid on', by: 'by', ref: 'Reference', renewal: 'Renewal', terms: 'Terms', vatNo: 'VAT', regNo: 'Reg. no.',
    page: 'Page', of: 'of', nonFiscal: 'This receipt confirms the payment received.', preview: 'PREVIEW', sampleProduct: 'Sample product', sampleCustomer: 'customer@example.com',
    'm.wallet': 'Wallet balance', 'm.stripe': 'Bank card', 'm.nowpayments': 'Cryptocurrency', 'm.paypal': 'PayPal',
  },
};

/** Texte sûr pour la police Helvetica de PDFKit (WinAnsi) : espaces insécables fins et caractères de contrôle retirés. */
const clean = (v: unknown, max = 300) => String(v ?? '').replace(/[  ]/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class InvoiceService {
  constructor(private readonly store: StoreService) {}

  private money(v: number, currency: string, lang: Lang): string {
    try {
      return clean(new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { style: 'currency', currency }).format(v));
    } catch {
      return `${v.toFixed(2)} ${currency}`;
    }
  }

  private date(iso: string, lang: Lang): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  /** Encaissement concerné : un identifiant précis, sinon le paiement initial (implicite pour les commandes d'avant la v1.4.0). */
  paymentFor(order: OrderRecord, paymentId?: string): PaymentEvent | null {
    if (order.payments?.length) {
      return order.payments.find((p) => p.id === paymentId) ?? order.payments.find((p) => p.kind === 'initial') ?? order.payments[0];
    }
    if (order.status === 'pending' || order.status === 'cancelled') return null;
    return {
      id: 'initial', kind: 'initial', amount: order.total, currency: order.currency, at: order.created_at, method: order.payment_method,
      description: order.items.map((l) => `${l.quantity} × ${l.name}`).join(', '),
    };
  }

  async render(order: OrderRecord, payment: PaymentEvent, kind: DocKind, lang: Lang, billing: BillingProfile | undefined, preview = false): Promise<Buffer> {
    const st = this.store.invoiceSettings;
    const tr = T[lang];
    const accent = /^#[0-9a-fA-F]{6}$/.test(st.accent_color) ? st.accent_color : '#e5532d';
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `${kind}-${payment.invoice_number ?? order.id.slice(0, 8)}`, Producer: 'UHQ Orders' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

    const W = doc.page.width;
    const L = 48;
    const R = W - 48;

    // ── En-tête : logo / société à gauche, titre + numéro à droite ──
    let leftY = 48;
    const logo = this.logoBuffer(st.logo_data_url);
    if (logo) {
      try {
        doc.image(logo, L, leftY, { fit: [150, 56] });
        leftY += 62;
      } catch {
        /* logo illisible : on l'ignore */
      }
    }
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(logo ? 11 : 17).text(clean(st.company_name) || 'UHQ', L, leftY, { width: 290 });
    leftY = doc.y + 2;
    doc.font('Helvetica').fontSize(8.5).fillColor('#555555');
    const company = [st.legal_form, ...clean(st.address, 400).split(/\r?\n/), st.registration_id && `${tr.regNo} : ${clean(st.registration_id)}`, st.vat_number && `${tr.vatNo} : ${clean(st.vat_number)}`, st.email, st.phone, st.website]
      .filter(Boolean).map((x) => clean(x, 120));
    for (const line of company) { doc.text(line, L, leftY, { width: 290 }); leftY = doc.y; }

    const title = kind === 'invoice' ? (clean(st.invoice_title, 40) || tr.invoice) : tr.receipt;
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(22).text(title, 300, 48, { width: R - 300, align: 'right' });
    const number = kind === 'invoice' ? payment.invoice_number : `REC-${payment.id === 'initial' ? order.id.slice(0, 8).toUpperCase() : payment.id.slice(0, 8).toUpperCase()}`;
    doc.fillColor('#111111').font('Helvetica').fontSize(10);
    let rightY = doc.y + 2;
    const meta: [string, string][] = [[tr.number, clean(number) || '—'], [tr.date, this.date(payment.at, lang)], [tr.order, `#${order.id.slice(0, 8).toUpperCase()}`]];
    for (const [k, v] of meta) {
      doc.fillColor('#777777').text(`${k}`, 330, rightY, { width: 70 });
      doc.fillColor('#111111').font('Helvetica-Bold').text(v, 400, rightY, { width: R - 400, align: 'right' });
      doc.font('Helvetica');
      rightY += 15;
    }
    let y = Math.max(leftY, rightY) + 24;

    // ── Client ──
    doc.fillColor('#777777').font('Helvetica-Bold').fontSize(8).text(tr.billedTo.toUpperCase(), L, y);
    y += 13;
    doc.fillColor('#111111').font('Helvetica').fontSize(10);
    const cust = [billing?.name, billing?.company, ...clean(billing?.address ?? '', 300).split(/\r?\n/), billing?.vat_number && `${tr.vatNo} : ${clean(billing.vat_number)}`, order.user_email || (preview ? tr.sampleCustomer : '')]
      .filter(Boolean).map((x) => clean(x, 120));
    for (const line of cust) { doc.text(line, L, y, { width: 320 }); y = doc.y; }
    y += 18;

    // ── Lignes ──
    const vatRate = Math.max(0, Math.min(100, Number(st.vat_rate) || 0));
    const lines = payment.kind === 'renewal'
      ? [{ name: `${tr.renewal} — ${payment.description}`, qty: 1, unit: payment.amount }]
      : [
          ...order.items.map((l) => ({ name: l.name, qty: l.quantity, unit: l.unit_price })),
          // Code promo : ligne négative pour que le détail corresponde au total réellement encaissé.
          ...(order.promo && order.promo.amount > 0 ? [{ name: `${lang === 'fr' ? 'Code promo' : 'Promo code'} ${order.promo.code}`, qty: 1, unit: -order.promo.amount }] : []),
        ];
    const gross = (v: number) => (st.prices_include_vat ? v : v * (1 + vatRate / 100));
    const net = (v: number) => (st.prices_include_vat ? v / (1 + vatRate / 100) : v);

    const colQty = 330;
    const colUnit = 380;
    const colTotal = R - 80;
    doc.rect(L, y, R - L, 22).fill('#f3f3f3');
    doc.fillColor('#555555').font('Helvetica-Bold').fontSize(8.5);
    doc.text(tr.description.toUpperCase(), L + 8, y + 7, { width: 260 });
    doc.text(tr.qty.toUpperCase(), colQty, y + 7, { width: 40, align: 'right' });
    doc.text(`${tr.unit.toUpperCase()}${vatRate > 0 ? (lang === 'fr' ? ' HT' : ' (EX.)') : ''}`, colUnit, y + 7, { width: 90, align: 'right' });
    doc.text(tr.total.toUpperCase(), colTotal, y + 7, { width: 72, align: 'right' });
    y += 28;
    doc.font('Helvetica').fontSize(10).fillColor('#111111');
    let totalNet = 0;
    for (const ln of lines) {
      const unitNet = round2(vatRate > 0 ? net(ln.unit) : ln.unit);
      const lineNet = round2((vatRate > 0 ? net(ln.unit) : ln.unit) * ln.qty);
      totalNet += lineNet;
      const h = Math.max(18, doc.heightOfString(clean(ln.name, 200), { width: 260 }) + 6);
      if (y + h > doc.page.height - 150) { doc.addPage(); y = 60; }
      doc.text(clean(ln.name, 200), L + 8, y, { width: 260 });
      doc.text(String(ln.qty), colQty, y, { width: 40, align: 'right' });
      doc.text(this.money(unitNet, payment.currency, lang), colUnit, y, { width: 90, align: 'right' });
      doc.text(this.money(lineNet, payment.currency, lang), colTotal, y, { width: 72, align: 'right' });
      y += h;
      doc.moveTo(L, y - 2).lineTo(R, y - 2).strokeColor('#e6e6e6').lineWidth(0.5).stroke();
    }
    y += 10;

    // ── Totaux ──
    // Le total TTC est celui RÉELLEMENT encaissé (jamais recalculé) ; HT et TVA s'en déduisent.
    const grandTotal = round2(payment.amount);
    const vatAmount = vatRate > 0 ? round2(grandTotal - grandTotal / (1 + vatRate / 100)) : 0;
    const subtotal = round2(grandTotal - vatAmount);
    const tx = 340;
    const row = (label: string, value: string, bold = false, color = '#111111') => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(color);
      doc.text(label, tx, y, { width: 110 });
      doc.text(value, tx + 110, y, { width: R - tx - 110, align: 'right' });
      y += bold ? 20 : 16;
    };
    if (kind === 'invoice' && vatRate > 0) {
      row(tr.subtotal, this.money(subtotal, payment.currency, lang), false, '#555555');
      row(`${tr.vat} ${String(vatRate).replace('.', lang === 'fr' ? ',' : '.')} %`, this.money(vatAmount, payment.currency, lang), false, '#555555');
      doc.moveTo(tx, y - 2).lineTo(R, y - 2).strokeColor(accent).lineWidth(1).stroke();
      y += 4;
      row(tr.grand, this.money(grandTotal, payment.currency, lang), true, accent);
    } else {
      doc.moveTo(tx, y - 2).lineTo(R, y - 2).strokeColor(accent).lineWidth(1).stroke();
      y += 4;
      row(tr.grandNoVat, this.money(grandTotal, payment.currency, lang), true, accent);
      if (kind === 'invoice' && vatRate === 0 && st.vat_exemption_note) {
        doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#555555').text(clean(st.vat_exemption_note, 200), L, y, { width: R - L });
        y = doc.y + 4;
      }
    }
    void totalNet;

    // ── Paiement ──
    y += 14;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#777777').text(tr.paid.toUpperCase(), L, y);
    y += 12;
    const method = tr[`m.${payment.method as PaymentMethod}`] ?? payment.method;
    doc.font('Helvetica').fontSize(10).fillColor('#111111').text(`${tr.paidOn} ${this.date(payment.at, lang)} ${tr.by} ${method}`, L, y, { width: R - L });
    y = doc.y;
    const ref = order.paypal?.txn_id || order.payment_ref;
    if (ref) { doc.fillColor('#555555').fontSize(9).text(`${tr.ref} : ${clean(ref, 80)}`, L, y + 2, { width: R - L }); y = doc.y; }
    if (kind === 'invoice' && st.payment_terms) { doc.fillColor('#555555').fontSize(9).text(`${tr.terms} : ${clean(st.payment_terms, 200)}`, L, y + 2, { width: R - L }); y = doc.y; }
    if (kind === 'receipt') { doc.fillColor('#555555').fontSize(9).text(tr.nonFiscal, L, y + 2, { width: R - L }); y = doc.y; }

    // ── Pied de page + filigrane d'aperçu ──
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // Sans marge basse, écrire dans le pied de page déclencherait un saut vers une page blanche supplémentaire.
      doc.page.margins.bottom = 0;
      if (st.footer_text) doc.font('Helvetica').fontSize(8).fillColor('#888888').text(clean(st.footer_text, 400), L, doc.page.height - 74, { width: R - L, align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor('#999999').text(`${tr.page} ${i + 1} ${tr.of} ${range.count}`, L, doc.page.height - 40, { width: R - L, align: 'center', lineBreak: false });
      if (preview) {
        doc.save().rotate(-30, { origin: [W / 2, doc.page.height / 2] }).font('Helvetica-Bold').fontSize(90).fillColor('#000000').opacity(0.06)
          .text(tr.preview, 0, doc.page.height / 2 - 45, { width: W, align: 'center', lineBreak: false }).restore();
      }
    }
    doc.end();
    return done;
  }

  /** Réglages de facturation (aucun secret) ; `logo_data_url` est renvoyé tel quel (le panel l'affiche en aperçu). */
  getSettings(): InvoiceSettings {
    return this.store.invoiceSettings;
  }

  /** Valide et enregistre les réglages de facturation (admin). Toute valeur est bornée / nettoyée. */
  updateSettings(patch: Record<string, any>): InvoiceSettings {
    const cur = this.store.invoiceSettings;
    const str = (k: keyof InvoiceSettings, max: number) =>
      patch[k] === undefined ? (cur[k] as string) : clean(patch[k], max).trim();
    const num = (k: keyof InvoiceSettings, min: number, max: number, int = true) => {
      if (patch[k] === undefined) return cur[k] as number;
      const n = Number(patch[k]);
      if (!Number.isFinite(n) || n < min || n > max) throw new BadRequestException(`Valeur invalide : ${k}`);
      return int ? Math.floor(n) : Math.round(n * 100) / 100;
    };
    const bool = (k: keyof InvoiceSettings) => (patch[k] === undefined ? (cur[k] as boolean) : patch[k] === true);
    let logo = cur.logo_data_url;
    if (patch.logo_data_url !== undefined) {
      logo = String(patch.logo_data_url ?? '');
      if (logo && !this.logoBuffer(logo)) throw new BadRequestException('Logo invalide : PNG ou JPEG, 400 Ko maximum.');
    }
    const color = str('accent_color', 7);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new BadRequestException('Couleur invalide (format #RRGGBB).');
    const next: InvoiceSettings = {
      enabled: bool('enabled'),
      company_name: str('company_name', 120),
      legal_form: str('legal_form', 80),
      address: str('address', 400),
      registration_id: str('registration_id', 80),
      vat_number: str('vat_number', 40),
      email: str('email', 120),
      phone: str('phone', 40),
      website: str('website', 120),
      logo_data_url: logo,
      accent_color: color,
      invoice_title: str('invoice_title', 60),
      number_prefix: str('number_prefix', 12),
      number_include_year: bool('number_include_year'),
      number_padding: num('number_padding', 1, 10),
      next_number: num('next_number', 1, 999_999_999),
      vat_rate: num('vat_rate', 0, 100, false),
      prices_include_vat: bool('prices_include_vat'),
      vat_exemption_note: str('vat_exemption_note', 200),
      payment_terms: str('payment_terms', 200),
      footer_text: str('footer_text', 300),
    };
    if (next.enabled && !next.company_name) throw new BadRequestException('Renseignez le nom de l’entreprise avant d’activer la facturation.');
    this.store.setInvoiceSettings(next);
    return next;
  }

  /** Aperçu avec des données d'exemple (réglages en cours, sans commande réelle). */
  async preview(kind: DocKind, lang: Lang): Promise<Buffer> {
    const tr = T[lang];
    const now = new Date().toISOString();
    const order: OrderRecord = {
      id: '00000000-0000-4000-8000-000000000000', user_id: 'preview', user_email: tr.sampleCustomer,
      items: [{ product_id: 'p', name: tr.sampleProduct, unit_price: 12.9, quantity: 2 }], total: 25.8, currency: 'EUR', status: 'paid', note: null,
      payment_method: 'wallet', deliveries: [], created_at: now, updated_at: now,
    };
    const st = this.store.invoiceSettings;
    const payment: PaymentEvent = { id: 'initial', kind: 'initial', amount: 25.8, currency: 'EUR', at: now, method: 'wallet', description: tr.sampleProduct, invoice_number: this.sampleNumber(st) };
    return this.render(order, payment, kind, lang, undefined, true);
  }

  private sampleNumber(st: InvoiceSettings): string {
    const year = st.number_include_year ? `${new Date().getUTCFullYear()}-` : '';
    return `${st.number_prefix || ''}${year}${String(Math.max(1, st.next_number || 1)).padStart(Math.max(1, Math.min(10, st.number_padding || 5)), '0')}`;
  }

  private logoBuffer(dataUrl: string): Buffer | null {
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    return buf.length > 0 && buf.length <= 400_000 ? buf : null;
  }
}
