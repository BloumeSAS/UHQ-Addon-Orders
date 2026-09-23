import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, raw } from 'express';
import { AppModule } from './app.module';
import * as path from 'path';
import * as fs from 'fs';

// Charge .env si présent
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const [k, ...rest] = line.trim().replace(/^#.*/, '').split('=');
    if (k && rest.length) process.env[k.trim()] ??= rest.join('=').trim();
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: { origin: '*', credentials: false },
    logger: ['error', 'warn', 'log'],
    bodyParser: false,
  });

  // Corps BRUT (pas de parsing JSON) sur les deux webhooks de paiement —
  // Stripe/NOWPayments vérifient une signature calculée sur les octets
  // exacts du corps reçu, un JSON reparsé/réencodé la casserait. Montées
  // AVANT le parseur JSON global ci-dessous (ordre des `app.use()`).
  app.use('/api/payments/stripe/webhook', raw({ type: 'application/json' }));
  app.use('/api/payments/nowpayments/webhook', raw({ type: 'application/json' }));
  app.use(json({ limit: '2mb' }));

  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );

  const port = parseInt(process.env.PORT ?? '3002', 10);
  await app.listen(port);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       UHQ Orders Addon — NestJS             ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  URL      : http://localhost:${port}`);
  console.log(`  Manifest : http://localhost:${port}/uhq-manifest.json`);
  console.log(`  Panel    : ${process.env.PANEL_URL ?? 'http://localhost:8000'}`);
  console.log(`  Wallet   : ${process.env.WALLET_URL ?? '(non configuré — addon Wallet requis)'}`);
  console.log('');
}

bootstrap();
