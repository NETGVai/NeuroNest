import * as https from 'node:https';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { CertInfo } from './certificate-manager';
import { AuthSessionManager } from './session-manager';
import { CredentialStore } from './credential-store';

export interface AuthServerStatus {
  running: boolean;
  address: string;
  port: number;
}

interface SessionData {
  csrfToken: string;
  createdAt: number;
  userId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  appId?: string;
  deviceId?: string;
  currentChallenge?: string;
}

export interface AuthServerDeps {
  credentialStore?: CredentialStore;
  authSessionManager?: AuthSessionManager;
  onUnavailable?: (error: Error) => void;
  /** Override primary port (default 443) — useful for testing */
  primaryPort?: number;
  /** Override fallback port (default 8443) — useful for testing */
  fallbackPort?: number;
}

const RP_ID = 'neuronest.cc';
const RP_NAME = 'NeuroNest';
const AUTH_DOMAIN = 'auth.neuronest.cc';
const HSTS_HEADER = 'max-age=63072000; includeSubDomains';
const DEFAULT_PRIMARY_PORT = 443;
const DEFAULT_FALLBACK_PORT = 8443;
const SESSION_COOKIE_NAME = 'nn_session';
const SESSION_MAX_AGE = 900; // 15 minutes

export class AuthServer {
  private server: https.Server | null = null;
  private sessions: Map<string, SessionData> = new Map();
  private connections: Set<net.Socket> = new Set();
  private currentPort = 0;
  private running = false;
  private deps: AuthServerDeps;
  private primaryPort: number;
  private fallbackPort: number;

  /** Exposed for route handlers */
  readonly rpId = RP_ID;
  get expectedOrigin(): string {
    if (this.currentPort === 443 || this.currentPort === 0) {
      return `https://${AUTH_DOMAIN}`;
    }
    return `https://${AUTH_DOMAIN}:${this.currentPort}`;
  }

  constructor(deps?: AuthServerDeps) {
    this.deps = deps ?? {};
    this.primaryPort = deps?.primaryPort ?? DEFAULT_PRIMARY_PORT;
    this.fallbackPort = deps?.fallbackPort ?? DEFAULT_FALLBACK_PORT;
  }

  /**
   * Start the HTTPS server with the provided cert/key.
   * Tries port 443 first, falls back to 8443.
   */
  async start(certInfo: CertInfo): Promise<{ port: number }> {
    if (this.running) {
      return { port: this.currentPort };
    }

    const cert = fs.readFileSync(certInfo.certPath, 'utf-8');
    const key = fs.readFileSync(certInfo.keyPath, 'utf-8');

    const tlsOptions: https.ServerOptions = {
      cert,
      key,
      minVersion: 'TLSv1.2',
    };

    this.server = https.createServer(tlsOptions, (req, res) => {
      this.handleRequest(req, res);
    });

    // Track connections for graceful shutdown
    this.server.on('connection', (socket: net.Socket) => {
      this.connections.add(socket);
      socket.on('close', () => {
        this.connections.delete(socket);
      });
    });

    try {
      await this.listen(this.server, this.primaryPort);
      this.currentPort = this.primaryPort;
    } catch {
      try {
        await this.listen(this.server, this.fallbackPort);
        this.currentPort = this.fallbackPort;
      } catch (_err) {
        this.server = null;
        const error = new Error(
          `Auth server failed to bind to both port ${this.primaryPort} and ${this.fallbackPort}`
        );
        console.error(`[AuthServer] ${error.message}`);
        this.deps.onUnavailable?.(error);
        throw error;
      }
    }

    this.running = true;
    console.log(`[AuthServer] Listening on 127.0.0.1:${this.currentPort}`);
    return { port: this.currentPort };
  }

  /**
   * Gracefully close all connections and stop the server.
   */
  async stop(): Promise<void> {
    if (!this.server) {
      this.running = false;
      return;
    }

    // Destroy all tracked connections
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    this.server = null;
    this.running = false;
    this.sessions.clear();
    this.currentPort = 0;
    console.log('[AuthServer] Server stopped');
  }

  /**
   * Current server status.
   */
  getStatus(): AuthServerStatus {
    return {
      running: this.running,
      address: this.running ? '127.0.0.1' : '',
      port: this.currentPort,
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private listen(server: https.Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * Central request handler — applies HSTS, session cookies, CSRF, and routes.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // HSTS on every response
    res.setHeader('Strict-Transport-Security', HSTS_HEADER);

    const url = new URL(req.url ?? '/', `https://127.0.0.1:${this.currentPort}`);
    const method = (req.method ?? 'GET').toUpperCase();

    // Ensure session
    const { sessionId, isNew } = this.ensureSession(req);
    if (isNew) {
      this.setSessionCookie(res, sessionId);
    }

    const session = this.sessions.get(sessionId)!;

    // CSRF validation for POST /api/* routes
    if (method === 'POST' && url.pathname.startsWith('/api/')) {
      const csrfHeader = req.headers['x-csrf-token'] as string | undefined;
      if (!csrfHeader || csrfHeader !== session.csrfToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'csrf_invalid' }));
        return;
      }
    }

    // Route dispatch
    this.route(method, url.pathname, req, res, session, url);
  }

  /**
   * Ensure a session exists for the request. Returns sessionId and whether it's new.
   */
  private ensureSession(req: http.IncomingMessage): { sessionId: string; isNew: boolean } {
    const cookies = this.parseCookies(req.headers.cookie ?? '');
    const existing = cookies[SESSION_COOKIE_NAME];

    if (existing && this.sessions.has(existing)) {
      return { sessionId: existing, isNew: false };
    }

    // Create new session
    const sessionId = crypto.randomUUID();
    const csrfToken = crypto.randomBytes(32).toString('hex');
    this.sessions.set(sessionId, { csrfToken, createdAt: Date.now() });
    return { sessionId, isNew: true };
  }

  private setSessionCookie(res: http.ServerResponse, sessionId: string): void {
    const cookie = `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`;
    res.setHeader('Set-Cookie', cookie);
  }

  private parseCookies(header: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const pair of header.split(';')) {
      const [rawKey, ...rest] = pair.split('=');
      const key = rawKey?.trim();
      const value = rest.join('=').trim();
      if (key) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Read the full request body as a string.
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  /**
   * Route dispatcher with WebAuthn ceremony endpoints.
   */
  private route(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: SessionData,
    url: URL,
  ): void {
    if (method === 'GET' && pathname === '/register') {
      try {
        const userInfo = AuthServer.decryptParams(url.searchParams.get('data') ?? '');
        this.serveRegisterPage(res, session.csrfToken, userInfo);
      } catch {
        this.serveErrorPage(res, 400, 'Invalid Request', 'The registration link is invalid or has been tampered with. Please try again from the <a href="https://neuronest.cc" target="_blank" style="color:#8888aa;text-decoration:underline;">NeuroNest</a> app.');
      }
      return;
    }

    if (method === 'GET' && pathname === '/login') {
      try {
        const userInfo = AuthServer.decryptParams(url.searchParams.get('data') ?? '');
        this.serveLoginPage(res, session.csrfToken, userInfo);
      } catch {
        this.serveErrorPage(res, 400, 'Invalid Request', 'The login link is invalid or has been tampered with. Please try again from the <a href="https://neuronest.cc" target="_blank" style="color:#8888aa;text-decoration:underline;">NeuroNest</a> app.');
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/register-start') {
      this.handleRegisterStart(req, res, session);
      return;
    }

    if (method === 'POST' && pathname === '/api/register-finish') {
      this.handleRegisterFinish(req, res, session);
      return;
    }

    if (method === 'POST' && pathname === '/api/login-start') {
      this.handleLoginStart(req, res, session);
      return;
    }

    if (method === 'POST' && pathname === '/api/login-finish') {
      this.handleLoginFinish(req, res, session);
      return;
    }

    // 404 for unknown routes
    this.serveErrorPage(res, 404, 'Page Not Found', 'This page doesn\u2019t exist. <a href="https://neuronest.cc" target="_blank" style="color:#8888aa;text-decoration:underline;">NeuroNest</a> passkey authentication is handled automatically \u2014 please use the <a href="https://neuronest.cc" target="_blank" style="color:#8888aa;text-decoration:underline;">NeuroNest</a> app to register or sign in.');
  }

  // ── WebAuthn ceremony handlers ────────────────────────────────────

  /**
   * POST /api/register-start
   * Generate PublicKeyCredentialCreationOptions via @simplewebauthn/server
   */
  private async handleRegisterStart(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: SessionData,
  ): Promise<void> {
    try {
      const body = JSON.parse(await this.readBody(req));
      const firstName = body.firstName as string;
      const lastName = body.lastName as string;
      const email = body.email as string;
      if (!email) {
        this.jsonResponse(res, 400, { error: 'missing_email' });
        return;
      }

      const userId = email;
      session.userId = userId;
      session.firstName = firstName;
      session.lastName = lastName;
      session.email = email;
      session.appId = body.appId as string;
      session.deviceId = body.deviceId as string;

      // Get existing credentials for this user to exclude
      const existingCredentials = this.deps.credentialStore
        ? this.deps.credentialStore.getCredentialsByUserId(userId, RP_ID)
        : [];

      const { generateRegistrationOptions } = await import('@simplewebauthn/server');

      const displayName = [firstName, lastName].filter(Boolean).join(' ') || email;

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: email,
        userDisplayName: displayName,
        attestationType: 'none',
        excludeCredentials: existingCredentials.map((cred) => ({
          id: cred.credentialId,
          transports: cred.transports
            ? (JSON.parse(cred.transports) as ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[])
            : undefined,
        })),
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
      });

      // Store challenge for verification
      session.currentChallenge = options.challenge;
      if (this.deps.credentialStore) {
        this.deps.credentialStore.storeChallenge(userId, options.challenge);
      }

      this.jsonResponse(res, 200, options);
    } catch (err) {
      console.error('[AuthServer] register-start error:', err);
      this.jsonResponse(res, 500, { error: 'internal_error' });
    }
  }

  /**
   * POST /api/register-finish
   * Verify attestation, store credential, generate JWT, redirect via deep link
   */
  private async handleRegisterFinish(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: SessionData,
  ): Promise<void> {
    try {
      const body = JSON.parse(await this.readBody(req));
      const expectedChallenge = session.currentChallenge;

      if (!expectedChallenge) {
        this.jsonResponse(res, 400, { error: 'no_challenge' });
        return;
      }

      const { verifyRegistrationResponse } = await import('@simplewebauthn/server');

      const verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: this.expectedOrigin,
        expectedRPID: RP_ID,
      });

      if (!verification.verified || !verification.registrationInfo) {
        this.jsonResponse(res, 400, { error: 'verification_failed' });
        return;
      }

      const { credential } = verification.registrationInfo;
      const userId = session.userId ?? 'unknown';

      // Store credential in the credential store
      if (this.deps.credentialStore) {
        this.deps.credentialStore.saveCredential({
          id: crypto.randomUUID(),
          userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: credential.counter,
          deviceName: null,
          transports: credential.transports ? JSON.stringify(credential.transports) : null,
          rpId: RP_ID,
          createdAt: new Date().toISOString(),
        });

        // Save user profile
        this.deps.credentialStore.saveUserProfile({
          email: session.email ?? userId,
          firstName: session.firstName ?? '',
          lastName: session.lastName ?? '',
          appId: session.appId ?? '',
          deviceId: session.deviceId ?? '',
          createdAt: new Date().toISOString(),
        });
      }

      // Clear challenge
      session.currentChallenge = undefined;

      // Generate JWT and return redirect URL
      const redirectUrl = await this.generateAuthRedirect(userId, credential.id);
      this.jsonResponse(res, 200, { verified: true, redirectUrl });
    } catch (err) {
      console.error('[AuthServer] register-finish error:', err);
      this.jsonResponse(res, 400, { error: 'verification_failed' });
    }
  }

  /**
   * POST /api/login-start
   * Generate PublicKeyCredentialRequestOptions, filter credentials by RP ID
   */
  private async handleLoginStart(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: SessionData,
  ): Promise<void> {
    try {
      const body = JSON.parse(await this.readBody(req));
      const email = body.email as string | undefined;
      const userId = email;

      session.userId = userId;

      // Get credentials scoped to this RP ID
      let allowCredentials: { id: string; transports?: ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[] }[] | undefined;

      if (userId && this.deps.credentialStore) {
        const credentials = this.deps.credentialStore.getCredentialsByUserId(userId, RP_ID);
        console.log(`[AuthServer] login-start: found ${credentials.length} credentials for ${userId} with rpId=${RP_ID}`);
        allowCredentials = credentials.map((cred) => ({
          id: cred.credentialId,
          transports: cred.transports
            ? (JSON.parse(cred.transports) as ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[])
            : undefined,
        }));
      }

      const { generateAuthenticationOptions } = await import('@simplewebauthn/server');

      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials,
        userVerification: 'preferred',
      });

      // Store challenge for verification
      session.currentChallenge = options.challenge;
      if (userId && this.deps.credentialStore) {
        this.deps.credentialStore.storeChallenge(userId, options.challenge);
      }

      this.jsonResponse(res, 200, options);
    } catch (err) {
      console.error('[AuthServer] login-start error:', err);
      this.jsonResponse(res, 500, { error: 'internal_error' });
    }
  }

  /**
   * POST /api/login-finish
   * Verify assertion, update counter, generate JWT, redirect via deep link
   */
  private async handleLoginFinish(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: SessionData,
  ): Promise<void> {
    try {
      const body = JSON.parse(await this.readBody(req));
      const expectedChallenge = session.currentChallenge;

      if (!expectedChallenge) {
        this.jsonResponse(res, 400, { error: 'no_challenge' });
        return;
      }

      // Look up the credential by its ID from the response
      const credentialId = body.id as string;
      if (!credentialId || !this.deps.credentialStore) {
        this.jsonResponse(res, 400, { error: 'credential_not_found' });
        return;
      }

      // Find the credential in the store — search by RP ID
      const rpCredentials = this.deps.credentialStore.getCredentialsByRpId(RP_ID);
      const storedCred = rpCredentials.find((c) => c.credentialId === credentialId);

      if (!storedCred) {
        this.jsonResponse(res, 400, { error: 'credential_not_found' });
        return;
      }

      const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');

      const verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: this.expectedOrigin,
        expectedRPID: RP_ID,
        credential: {
          id: storedCred.credentialId,
          publicKey: new Uint8Array(Buffer.from(storedCred.publicKey, 'base64url')),
          counter: storedCred.counter,
          transports: storedCred.transports
            ? (JSON.parse(storedCred.transports) as ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[])
            : undefined,
        },
      });

      if (!verification.verified) {
        this.jsonResponse(res, 400, { error: 'verification_failed' });
        return;
      }

      // Update counter
      this.deps.credentialStore.updateCounter(
        credentialId,
        verification.authenticationInfo.newCounter,
      );

      // Clear challenge
      session.currentChallenge = undefined;

      // Generate JWT and return redirect URL
      const userId = storedCred.userId;
      const redirectUrl = await this.generateAuthRedirect(userId, credentialId);
      this.jsonResponse(res, 200, { verified: true, redirectUrl });
    } catch (err) {
      console.error('[AuthServer] login-finish error:', err);
      this.jsonResponse(res, 400, { error: 'verification_failed' });
    }
  }

  // ── JWT / redirect helpers ────────────────────────────────────────

  /**
   * Generate a JWT and build the deep link redirect URL.
   */
  private async generateAuthRedirect(userId: string, credentialId: string): Promise<string> {
    if (!this.deps.authSessionManager) {
      throw new Error('AuthSessionManager not configured');
    }

    const secret = await this.deps.authSessionManager.ensureSecret();
    const token = this.deps.authSessionManager.createToken({ userId, credentialId }, secret);
    return `neuronest://auth?token=${token}`;
  }

  // ── HTML page serving ─────────────────────────────────────────────

  /**
   * Serve a styled error page (404, 400, etc.).
   */
  private serveErrorPage(res: http.ServerResponse, status: number, title: string, message: string): void {
    const html = buildErrorHtml(status, title, message);
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * Serve the registration HTML page with WebAuthn browser-side JavaScript.
   */
  private serveRegisterPage(res: http.ServerResponse, csrfToken: string, userInfo: Record<string, string>): void {
    const html = buildRegisterHtml(csrfToken, RP_ID, this.expectedOrigin, userInfo);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * Serve the login HTML page with WebAuthn browser-side JavaScript.
   */
  private serveLoginPage(res: http.ServerResponse, csrfToken: string, userInfo: Record<string, string>): void {
    const html = buildLoginHtml(csrfToken, RP_ID, this.expectedOrigin, userInfo);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  // ── Accessors for testing ──────────────────────────────────────────

  /**
   * Decrypt the base64url-encoded `data` query parameter.
   * Key: SHA-256 hash of 'certs.neuronest.cc'
   * Format: iv (12 bytes) + ciphertext + authTag (16 bytes)
   */
  static decryptParams(data: string): Record<string, string> {
    const key = crypto.createHash('sha256').update('certs.neuronest.cc').digest();
    const combined = Buffer.from(data, 'base64url');
    const iv = combined.subarray(0, 12);
    const authTag = combined.subarray(combined.length - 16);
    const ciphertext = combined.subarray(12, combined.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  }

  /** Exposed for tests: get the CSRF token for a given session ID */
  getSessionCsrfToken(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.csrfToken;
  }

  /** Exposed for tests: get all active session IDs */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}

// ── HTML page builders ────────────────────────────────────────────

function buildRegisterHtml(csrfToken: string, rpId: string, origin: string, userInfo: Record<string, string>): string {
  const firstName = userInfo.firstName || '';
  const lastName = userInfo.lastName || '';
  const email = userInfo.email || '';
  const safeFirstName = firstName.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeLastName = lastName.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeEmail = email.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="csrf-token" content="${csrfToken}">
  <meta name="rp-id" content="${rpId}">
  <meta name="expected-origin" content="${origin}">
  <title>NeuroNest – Register Passkey</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; background: linear-gradient(135deg, #0f0c29 0%, #1a1a3e 40%, #24243e 100%); color: #e0e0e0; display: flex; align-items: center; justify-content: center; }
    .container { text-align: center; max-width: 520px; padding: 40px 32px; }
    .badge { display: inline-block; background: rgba(0,122,255,0.15); color: #5ac8fa; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; padding: 6px 16px; border-radius: 20px; margin-bottom: 24px; border: 1px solid rgba(90,200,250,0.2); }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 8px; }
    .subtitle { font-size: 15px; color: #8888aa; margin-bottom: 32px; line-height: 1.5; }
    .user-info { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; text-align: left; }
    .user-info .label { font-size: 11px; color: #6666aa; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .user-info .value { font-size: 15px; color: #fff; margin-bottom: 12px; }
    .user-info .value:last-child { margin-bottom: 0; }
    #status { padding: 16px 20px; border-radius: 12px; font-size: 14px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); margin-bottom: 32px; min-height: 52px; display: flex; align-items: center; justify-content: center; gap: 10px; }
    #status.error { background: rgba(255,59,48,0.1); border-color: rgba(255,59,48,0.3); color: #ff6b6b; }
    #status.success { background: rgba(52,199,89,0.1); border-color: rgba(52,199,89,0.3); color: #5cdb7f; }
    .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.15); border-top-color: #5ac8fa; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .info-section { text-align: left; margin-top: 16px; }
    .info-section h3 { font-size: 12px; color: #6666aa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    .info-item { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; font-size: 13px; color: #9999bb; line-height: 1.4; }
    .info-item span:first-child { font-size: 16px; flex-shrink: 0; }
    .footer { margin-top: 32px; font-size: 11px; color: #444466; }
    .footer a { color: #5566aa; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">Passkey Registration</div>
    <div class="icon">\ud83d\udd11</div>
    <h1>Create Your Passkey</h1>
    <p class="subtitle">Setting up passwordless authentication for <a href="https://neuronest.cc" target="_blank" style="color:#5ac8fa;text-decoration:none;">NeuroNest</a> using your device's biometric or security key.</p>
    <div class="user-info">
      <div class="label">Name</div>
      <div class="value">${safeFirstName} ${safeLastName}</div>
      <div class="label">Email</div>
      <div class="value">${safeEmail}</div>
    </div>
    <div id="status"><div class="spinner"></div> Initializing registration...</div>
    <div class="info-section">
      <h3>About Passkeys</h3>
      <div class="info-item"><span>\ud83d\udee1\ufe0f</span><span>Passkeys use your device's biometrics (Touch ID, Face ID) or security key — no passwords to remember or steal.</span></div>
      <div class="info-item"><span>\ud83d\udd12</span><span>Your private key never leaves your device. Only a cryptographic proof is sent during authentication.</span></div>
      <div class="info-item"><span>\u26a1</span><span>Sign in instantly with a single touch. Phishing-resistant by design.</span></div>
    </div>
    <div class="footer">Powered by <a href="https://neuronest.cc" target="_blank" style="color:#5566aa;text-decoration:none;">NeuroNest</a> \u00b7 WebAuthn FIDO2</div>
  </div>
  <script>
    (function() {
      var csrfToken = document.querySelector('meta[name="csrf-token"]').content;
      var statusEl = document.getElementById('status');
      var firstName = ${JSON.stringify(firstName)};
      var lastName = ${JSON.stringify(lastName)};
      var email = ${JSON.stringify(email)};
      var appId = ${JSON.stringify(userInfo.appId || '')};
      var deviceId = ${JSON.stringify(userInfo.deviceId || '')};

      function base64urlToBuffer(base64url) {
        var base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
      }

      function bufferToBase64url(buffer) {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      }

      function showCountdownOverlay(seconds) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,12,41,0.35);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';
        var canvas = document.createElement('canvas');
        canvas.width = 360; canvas.height = 360;
        canvas.style.cssText = 'margin-bottom:24px;';
        overlay.appendChild(canvas);
        var msg = document.createElement('div');
        msg.style.cssText = 'color:#fff;font-size:18px;font-weight:600;text-align:center;text-shadow:0 2px 8px rgba(0,0,0,0.5);';
        msg.textContent = 'Click "Open NeuroNest" in the browser popup';
        overlay.appendChild(msg);
        var sub = document.createElement('div');
        sub.style.cssText = 'color:rgba(255,255,255,0.6);font-size:14px;margin-top:8px;text-align:center;text-shadow:0 1px 4px rgba(0,0,0,0.5);';
        sub.textContent = 'This tab will close automatically';
        overlay.appendChild(sub);
        document.body.appendChild(overlay);
        var ctx = canvas.getContext('2d');
        var total = seconds;
        var start = Date.now();
        function draw() {
          var elapsed = (Date.now() - start) / 1000;
          var remaining = Math.max(0, total - elapsed);
          var frac = remaining / total;
          ctx.clearRect(0, 0, 360, 360);
          ctx.beginPath();
          ctx.arc(180, 180, 150, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.1)';
          ctx.lineWidth = 10;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(180, 180, 150, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
          ctx.strokeStyle = 'rgba(92,219,127,0.9)';
          ctx.lineWidth = 10;
          ctx.lineCap = 'round';
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.font = '600 80px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(Math.ceil(remaining).toString(), 180, 170);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.fillText('seconds', 180, 220);
          if (remaining > 0) requestAnimationFrame(draw);
        }
        draw();
      }

      (async function() {
        try {
          var startRes = await fetch('/api/register-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ firstName: firstName, lastName: lastName, email: email, appId: appId, deviceId: deviceId })
          });
          if (!startRes.ok) throw new Error('Failed to start registration');
          var options = await startRes.json();

          options.challenge = base64urlToBuffer(options.challenge);
          options.user.id = base64urlToBuffer(options.user.id);
          if (options.excludeCredentials) {
            options.excludeCredentials = options.excludeCredentials.map(function(c) {
              return Object.assign({}, c, { id: base64urlToBuffer(c.id) });
            });
          }

          statusEl.innerHTML = '<div class="spinner"></div> Waiting for authenticator...';
          var credential = await navigator.credentials.create({ publicKey: options });

          var attestationResponse = {
            id: credential.id,
            rawId: bufferToBase64url(credential.rawId),
            type: credential.type,
            response: {
              clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
              attestationObject: bufferToBase64url(credential.response.attestationObject)
            },
            clientExtensionResults: credential.getClientExtensionResults()
          };
          if (credential.response.getTransports) {
            attestationResponse.response.transports = credential.response.getTransports();
          }

          var finishRes = await fetch('/api/register-finish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify(attestationResponse)
          });
          var result = await finishRes.json();

          if (result.verified && result.redirectUrl) {
            var redirectUrl = result.redirectUrl;
            statusEl.className = 'success';
            statusEl.innerHTML = '\u2705 Registration successful!<br><br>';
            var returnBtn = document.createElement('button');
            returnBtn.textContent = 'Return to NeuroNest';
            returnBtn.style.cssText = 'padding:10px 24px;font-size:14px;border:none;border-radius:8px;background:#5cdb7f;color:#000;cursor:pointer;font-weight:600;';
            returnBtn.addEventListener('click', function() {
              returnBtn.disabled = true;
              returnBtn.textContent = 'Redirecting...';
              showCountdownOverlay(5);
              var link = document.createElement('a');
              link.href = redirectUrl;
              link.click();
              setTimeout(function() { window.close(); }, 5500);
            });
            statusEl.appendChild(returnBtn);
          } else {
            throw new Error(result.error || 'Registration failed');
          }
        } catch (err) {
          statusEl.innerHTML = '\u274c ' + err.message;
          statusEl.className = 'error';
        }
      })();
    })();
  </script>
</body>
</html>`;
}

function buildLoginHtml(csrfToken: string, rpId: string, origin: string, userInfo: Record<string, string>): string {
  const email = userInfo.email || '';
  const safeEmail = email.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="csrf-token" content="${csrfToken}">
  <meta name="rp-id" content="${rpId}">
  <meta name="expected-origin" content="${origin}">
  <title>NeuroNest – Sign In</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; background: linear-gradient(135deg, #0f0c29 0%, #1a1a3e 40%, #24243e 100%); color: #e0e0e0; display: flex; align-items: center; justify-content: center; }
    .container { text-align: center; max-width: 520px; padding: 40px 32px; }
    .badge { display: inline-block; background: rgba(52,199,89,0.15); color: #5cdb7f; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; padding: 6px 16px; border-radius: 20px; margin-bottom: 24px; border: 1px solid rgba(52,199,89,0.2); }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 8px; }
    .subtitle { font-size: 15px; color: #8888aa; margin-bottom: 32px; line-height: 1.5; }
    .user-info { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; }
    .user-info .label { font-size: 11px; color: #6666aa; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .user-info .value { font-size: 15px; color: #fff; }
    #status { padding: 16px 20px; border-radius: 12px; font-size: 14px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); margin-bottom: 32px; min-height: 52px; display: flex; align-items: center; justify-content: center; gap: 10px; }
    #status.error { background: rgba(255,59,48,0.1); border-color: rgba(255,59,48,0.3); color: #ff6b6b; }
    #status.success { background: rgba(52,199,89,0.1); border-color: rgba(52,199,89,0.3); color: #5cdb7f; }
    .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.15); border-top-color: #5cdb7f; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .info-section { text-align: left; margin-top: 16px; }
    .info-section h3 { font-size: 12px; color: #6666aa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    .info-item { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; font-size: 13px; color: #9999bb; line-height: 1.4; }
    .info-item span:first-child { font-size: 16px; flex-shrink: 0; }
    .footer { margin-top: 32px; font-size: 11px; color: #444466; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">Passkey Login</div>
    <div class="icon">\ud83d\udd13</div>
    <h1>Welcome Back</h1>
    <p class="subtitle">Authenticate with your passkey — just a touch or glance. No passwords needed.</p>
    <div class="user-info">
      <div class="label">Signing in as</div>
      <div class="value">${safeEmail}</div>
    </div>
    <div id="status"><div class="spinner"></div> Starting authentication...</div>
    <div class="info-section">
      <h3>About Passkeys</h3>
      <div class="info-item"><span>\ud83d\udee1\ufe0f</span><span>Passkeys use your device's biometrics (Touch ID, Face ID) or security key — no passwords to remember or steal.</span></div>
      <div class="info-item"><span>\ud83d\udd12</span><span>Your private key never leaves your device. Only a cryptographic proof is sent during authentication.</span></div>
      <div class="info-item"><span>\u26a1</span><span>Sign in instantly with a single touch. Phishing-resistant by design.</span></div>
    </div>
    <div class="footer">Powered by <a href="https://neuronest.cc" target="_blank" style="color:#5566aa;text-decoration:none;">NeuroNest</a> \u00b7 WebAuthn FIDO2</div>
  </div>
  <script>
    (function() {
      var csrfToken = document.querySelector('meta[name="csrf-token"]').content;
      var statusEl = document.getElementById('status');
      var email = ${JSON.stringify(email)};

      function base64urlToBuffer(base64url) {
        var base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
      }

      function bufferToBase64url(buffer) {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      }

      function showCountdownOverlay(seconds) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(15,12,41,0.35);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);';
        var canvas = document.createElement('canvas');
        canvas.width = 360; canvas.height = 360;
        canvas.style.cssText = 'margin-bottom:24px;';
        overlay.appendChild(canvas);
        var msg = document.createElement('div');
        msg.style.cssText = 'color:#fff;font-size:18px;font-weight:600;text-align:center;text-shadow:0 2px 8px rgba(0,0,0,0.5);';
        msg.textContent = 'Click "Open NeuroNest" in the browser popup';
        overlay.appendChild(msg);
        var sub = document.createElement('div');
        sub.style.cssText = 'color:rgba(255,255,255,0.6);font-size:14px;margin-top:8px;text-align:center;text-shadow:0 1px 4px rgba(0,0,0,0.5);';
        sub.textContent = 'This tab will close automatically';
        overlay.appendChild(sub);
        document.body.appendChild(overlay);
        var ctx = canvas.getContext('2d');
        var total = seconds;
        var start = Date.now();
        function draw() {
          var elapsed = (Date.now() - start) / 1000;
          var remaining = Math.max(0, total - elapsed);
          var frac = remaining / total;
          ctx.clearRect(0, 0, 360, 360);
          ctx.beginPath();
          ctx.arc(180, 180, 150, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.1)';
          ctx.lineWidth = 10;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(180, 180, 150, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
          ctx.strokeStyle = 'rgba(92,219,127,0.9)';
          ctx.lineWidth = 10;
          ctx.lineCap = 'round';
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.font = '600 80px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(Math.ceil(remaining).toString(), 180, 170);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.fillText('seconds', 180, 220);
          if (remaining > 0) requestAnimationFrame(draw);
        }
        draw();
      }

      (async function() {
        try {
          var startRes = await fetch('/api/login-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ email: email })
          });
          if (!startRes.ok) throw new Error('Failed to start authentication');
          var options = await startRes.json();

          options.challenge = base64urlToBuffer(options.challenge);
          if (options.allowCredentials) {
            options.allowCredentials = options.allowCredentials.map(function(c) {
              return Object.assign({}, c, { id: base64urlToBuffer(c.id) });
            });
          }

          statusEl.innerHTML = '<div class="spinner"></div> Waiting for authenticator...';
          var credential = await navigator.credentials.get({ publicKey: options });

          var assertionResponse = {
            id: credential.id,
            rawId: bufferToBase64url(credential.rawId),
            type: credential.type,
            response: {
              clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
              authenticatorData: bufferToBase64url(credential.response.authenticatorData),
              signature: bufferToBase64url(credential.response.signature),
              userHandle: credential.response.userHandle ? bufferToBase64url(credential.response.userHandle) : undefined
            },
            clientExtensionResults: credential.getClientExtensionResults()
          };

          var finishRes = await fetch('/api/login-finish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify(assertionResponse)
          });
          var result = await finishRes.json();

          if (result.verified && result.redirectUrl) {
            var redirectUrl = result.redirectUrl;
            statusEl.className = 'success';
            statusEl.innerHTML = '\u2705 Login successful!<br><br>';
            var returnBtn = document.createElement('button');
            returnBtn.textContent = 'Return to NeuroNest';
            returnBtn.style.cssText = 'padding:10px 24px;font-size:14px;border:none;border-radius:8px;background:#5cdb7f;color:#000;cursor:pointer;font-weight:600;';
            returnBtn.addEventListener('click', function() {
              returnBtn.disabled = true;
              returnBtn.textContent = 'Redirecting...';
              showCountdownOverlay(5);
              var link = document.createElement('a');
              link.href = redirectUrl;
              link.click();
              setTimeout(function() { window.close(); }, 5500);
            });
            statusEl.appendChild(returnBtn);
          } else {
            throw new Error(result.error || 'Authentication failed');
          }
        } catch (err) {
          statusEl.innerHTML = '\u274c ' + err.message;
          statusEl.className = 'error';
        }
      })();
    })();
  </script>
</body>
</html>`;
}

function buildErrorHtml(status: number, title: string, message: string): string {
  const safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Message is trusted HTML (contains hyperlinks) — don't escape it

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>NeuroNest \u2013 ${safeTitle}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; background: linear-gradient(135deg, #0f0c29 0%, #1a1a3e 40%, #24243e 100%); color: #e0e0e0; display: flex; align-items: center; justify-content: center; }
    .container { text-align: center; max-width: 520px; padding: 40px 32px; }
    .badge { display: inline-block; background: rgba(255,59,48,0.15); color: #ff6b6b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; padding: 6px 16px; border-radius: 20px; margin-bottom: 24px; border: 1px solid rgba(255,59,48,0.2); }
    .icon { font-size: 64px; margin-bottom: 16px; }
    .code { font-size: 72px; font-weight: 800; color: rgba(255,255,255,0.08); letter-spacing: -2px; margin-bottom: -8px; }
    h1 { font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 12px; }
    .message { font-size: 15px; color: #8888aa; margin-bottom: 32px; line-height: 1.6; }
    .info-box { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 20px; text-align: left; margin-bottom: 24px; }
    .info-box h3 { font-size: 12px; color: #6666aa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    .info-item { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; font-size: 13px; color: #9999bb; line-height: 1.4; }
    .info-item span:first-child { font-size: 16px; flex-shrink: 0; }
    .footer { margin-top: 32px; font-size: 11px; color: #444466; }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">Error ${status}</div>
    <div class="code">${status}</div>
    <div class="icon">\ud83d\udd10</div>
    <h1>${safeTitle}</h1>
    <p class="message">${message}</p>
    <div class="info-box">
      <h3>How Passkey Auth Works</h3>
      <div class="info-item"><span>\ud83d\udcf1</span><span>Open the <a href="https://neuronest.cc" target="_blank" style="color:#9999bb;text-decoration:underline;">NeuroNest</a> app and click <strong>Create Passkey</strong> or <strong>Sign In with Passkey</strong>.</span></div>
      <div class="info-item"><span>\ud83d\udd17</span><span>The app generates a secure, encrypted link and opens it in your browser automatically.</span></div>
      <div class="info-item"><span>\ud83d\udd11</span><span>Your browser handles the passkey ceremony using Touch ID, Face ID, or a security key.</span></div>
      <div class="info-item"><span>\u21a9\ufe0f</span><span>After authentication, you\u2019re redirected back to <a href="https://neuronest.cc" target="_blank" style="color:#9999bb;text-decoration:underline;">NeuroNest</a> automatically.</span></div>
    </div>
    <div class="footer">Powered by <a href="https://neuronest.cc" target="_blank" style="color:#5566aa;text-decoration:none;">NeuroNest</a> \u00b7 WebAuthn FIDO2</div>
  </div>
</body>
</html>`;
}
