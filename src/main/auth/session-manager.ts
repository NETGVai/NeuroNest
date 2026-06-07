import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import * as jwt from 'jsonwebtoken';

export interface TokenPayload {
  userId: string;
  credentialId: string;
  iat: number;
  exp: number;
}

const AUTH_SECRET_PATH = path.join(homedir(), '.neuronest', 'auth-secret');
const TOKEN_EXPIRY_SECONDS = 900; // 15 minutes

export class AuthSessionManager {
  private secretPath: string;

  constructor(secretPath?: string) {
    this.secretPath = secretPath ?? AUTH_SECRET_PATH;
  }

  /**
   * Ensure the HMAC-SHA256 secret exists at ~/.neuronest/auth-secret.
   * If missing, generates a 256-bit cryptographically random secret
   * and writes it with permissions 0600.
   */
  async ensureSecret(): Promise<string> {
    try {
      const secret = fs.readFileSync(this.secretPath, 'utf-8');
      if (secret.length > 0) {
        return secret;
      }
    } catch {
      // File doesn't exist or is unreadable — generate a new one
    }

    const dir = path.dirname(this.secretPath);
    fs.mkdirSync(dir, { recursive: true });

    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(this.secretPath, secret, { mode: 0o600 });
    return secret;
  }

  /**
   * Generate a JWT with 15-minute expiry containing userId and credentialId.
   * Signed with HMAC-SHA256 using the stored secret.
   */
  createToken(payload: { userId: string; credentialId: string }, secret: string): string {
    const now = Math.floor(Date.now() / 1000);
    const tokenPayload = {
      userId: payload.userId,
      credentialId: payload.credentialId,
      iat: now,
      exp: now + TOKEN_EXPIRY_SECONDS,
    };

    return jwt.sign(tokenPayload, secret, { algorithm: 'HS256' });
  }

  /**
   * Validate JWT signature and expiry.
   * Returns TokenPayload if valid, null otherwise.
   */
  validateToken(token: string, secret: string): TokenPayload | null {
    try {
      const decoded = jwt.verify(token, secret, {
        algorithms: ['HS256'],
      }) as Record<string, unknown>;

      if (
        typeof decoded['userId'] === 'string' &&
        typeof decoded['credentialId'] === 'string' &&
        typeof decoded['iat'] === 'number' &&
        typeof decoded['exp'] === 'number'
      ) {
        return {
          userId: decoded['userId'] as string,
          credentialId: decoded['credentialId'] as string,
          iat: decoded['iat'] as number,
          exp: decoded['exp'] as number,
        };
      }

      return null;
    } catch {
      return null;
    }
  }
}
