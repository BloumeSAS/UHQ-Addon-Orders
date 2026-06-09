import { Request } from 'express';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';

/**
 * Helpers d'authentification — identiques à l'addon Wallet.
 * Le panel UHQ passe son JWT (non re-signé ici) via Authorization: Bearer
 * ou en query ?token=. On décode le payload pour récupérer sub / role / exp.
 */
export interface JwtPayload {
  sub: string;
  email?: string;
  role?: string;
  exp?: number;
}

export function decodeJwt(token: string): JwtPayload | null {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function extractToken(req: Request): string {
  const auth = req.headers['authorization'] ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return (req.query['token'] as string) ?? '';
}

export function authenticate(req: Request): JwtPayload {
  const token = extractToken(req);
  if (!token) throw new UnauthorizedException('Token manquant');

  const payload = decodeJwt(token);
  if (!payload?.sub) throw new UnauthorizedException('Token invalide');

  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new UnauthorizedException('Token expiré');
  }

  return payload;
}

export function requireAdmin(req: Request): JwtPayload {
  const payload = authenticate(req);
  if (payload.role !== 'ADMIN') throw new ForbiddenException('Accès admin requis');
  return payload;
}
