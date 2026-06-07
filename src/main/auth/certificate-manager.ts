import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { homedir } from 'os';
import * as x509 from '@peculiar/x509';

export interface CertInfo {
  issuer: string;
  domain: string;
  expiryDate: Date;
  daysRemaining: number;
  certPath: string;
  keyPath: string;
}

const DEFAULT_CERTS_DIR = path.join(homedir(), '.neuronest', 'certs');
const DEFAULT_PROVISION_URL = 'https://certs.neuronest.cc';
const DOMAIN = 'auth.neuronest.cc';
const RENEWAL_THRESHOLD_HOURS = 48;
const HEALTH_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const RETRY_DELAY_MS = 60 * 60 * 1000; // 1 hour
const MAX_RETRIES = 3;

const BEARER_TOKEN_KEY = 'certs.neuronest.cc';
const ACME_DIRECTORY_URL = 'https://acme-v02.api.letsencrypt.org/directory';
const ACME_ACCOUNT_KEY_PATH = path.join(homedir(), '.neuronest', 'acme-account.key');


// ── ACME protocol types ──

interface ACMEDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

interface ACMEOrder {
  status: string;
  authorizations: string[];
  finalize: string;
  certificate?: string;
}

interface ACMEChallenge {
  type: string;
  url: string;
  token: string;
  status: string;
}

interface ACMEAuthorization {
  status: string;
  identifier: { type: string; value: string };
  challenges: ACMEChallenge[];
}

export class CertificateManager {
  private certsDir: string;
  private provisionUrl: string;
  private healthMonitorInterval: ReturnType<typeof setInterval> | null = null;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: { certsDir?: string; provisionUrl?: string }) {
    this.certsDir = options?.certsDir ?? DEFAULT_CERTS_DIR;
    this.provisionUrl = options?.provisionUrl ?? DEFAULT_PROVISION_URL;
  }

  private get keyPath(): string {
    return path.join(this.certsDir, `${DOMAIN}.key`);
  }

  private get certPath(): string {
    return path.join(this.certsDir, `${DOMAIN}.crt`);
  }

  private get chainPath(): string {
    return path.join(this.certsDir, 'ca-chain.crt');
  }

  private log(event: string, details?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const msg = `[CertificateManager] [${timestamp}] ${event}`;
    if (details) {
      console.log(msg, details);
    } else {
      console.log(msg);
    }
  }

  /**
   * Check if a valid (non-expired) certificate exists in the certs directory.
   */
  hasValidCert(): boolean {
    try {
      if (!fs.existsSync(this.certPath) || !fs.existsSync(this.keyPath)) {
        return false;
      }
      const certPem = fs.readFileSync(this.certPath, 'utf-8');
      const cert = new crypto.X509Certificate(certPem);
      const now = new Date();
      return now < new Date(cert.validTo);
    } catch {
      return false;
    }
  }

  /**
   * Get certificate metadata (issuer, domain, expiry, days remaining).
   */
  getCertInfo(): CertInfo | null {
    try {
      if (!fs.existsSync(this.certPath)) {
        return null;
      }
      const certPem = fs.readFileSync(this.certPath, 'utf-8');
      const cert = new crypto.X509Certificate(certPem);
      const expiryDate = new Date(cert.validTo);
      const now = new Date();
      const msRemaining = expiryDate.getTime() - now.getTime();
      const daysRemaining = Math.max(0, Math.floor(msRemaining / (1000 * 60 * 60 * 24)));

      const subjectParts = cert.subject.split('\n').map(s => s.trim());
      const cnEntry = subjectParts.find(p => p.startsWith('CN='));
      const domain = cnEntry ? cnEntry.substring(3) : DOMAIN;

      const issuerParts = cert.issuer.split('\n').map(s => s.trim());
      const issuerCn = issuerParts.find(p => p.startsWith('CN='));
      const issuer = issuerCn ? issuerCn.substring(3) : cert.issuer;

      return {
        issuer,
        domain,
        expiryDate,
        daysRemaining,
        certPath: this.certPath,
        keyPath: this.keyPath,
      };
    } catch {
      return null;
    }
  }

  /**
   * Generate a new RSA-2048 private key and PKCS#10 CSR for auth.neuronest.cc.
   * The private key is generated locally and never transmitted.
   */
  async generateCSR(): Promise<{ privateKey: string; csr: string }> {
    this.log('Generating RSA-2048 key pair and CSR', { domain: DOMAIN });

    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    x509.cryptoProvider.set(crypto.webcrypto as any);

    const alg = {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    };

    const pubDer = pemToDer(publicKey);
    const privDer = pemToDer(privateKey);

    const wcPrivKey = await crypto.webcrypto.subtle.importKey('pkcs8', privDer, alg, true, ['sign']);
    const wcPubKey = await crypto.webcrypto.subtle.importKey('spki', pubDer, alg, true, ['verify']);

    const csrObj = await x509.Pkcs10CertificateRequestGenerator.create({
      name: `CN=${DOMAIN}`,
      keys: { privateKey: wcPrivKey, publicKey: wcPubKey },
      signingAlgorithm: alg,
    });

    const csrPem = csrObj.toString('pem');
    this.log('CSR generated successfully', { domain: DOMAIN });

    return { privateKey, csr: csrPem };
  }

  // ── Bearer token ──

  private getBearerToken(): string {
    return crypto
      .createHmac('sha256', BEARER_TOKEN_KEY)
      .update(BEARER_TOKEN_KEY)
      .digest('hex');
  }

  // ── ACME account key management ──

  /**
   * Get or generate the ACME account key (ECDSA P-256, PKCS8 PEM).
   * Stored at ~/.neuronest/acme-account.key.
   */
  private getOrCreateAccountKey(): string {
    if (fs.existsSync(ACME_ACCOUNT_KEY_PATH)) {
      return fs.readFileSync(ACME_ACCOUNT_KEY_PATH, 'utf-8');
    }

    this.log('Generating new ACME account key', { path: ACME_ACCOUNT_KEY_PATH });

    const { privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    fs.mkdirSync(path.dirname(ACME_ACCOUNT_KEY_PATH), { recursive: true });
    fs.writeFileSync(ACME_ACCOUNT_KEY_PATH, privateKey, process.platform === 'win32' ? {} : { mode: 0o600 });

    return privateKey;
  }

  // ── HTTPS request helper ──

  private httpsRequest(
    url: string,
    options: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const requester = parsed.protocol === 'http:' ? require('http') : https;

      const reqOptions: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.pathname + parsed.search,
        method: options.method,
        headers: options.headers,
      };

      const req = requester.request(reqOptions, (res: import('http').IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, val] of Object.entries(res.headers)) {
            if (typeof val === 'string') responseHeaders[key] = val;
            else if (Array.isArray(val)) responseHeaders[key] = val[0] ?? '';
          }
          resolve({ statusCode: res.statusCode ?? 0, headers: responseHeaders, body: data });
        });
      });

      req.on('error', (err: Error) => reject(err));

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  // ── Worker DNS API helpers ──

  private async workerCreateTXT(value: string): Promise<{ recordId: string }> {
    const resp = await this.httpsRequest(`${this.provisionUrl}/dns/create-txt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.getBearerToken()}`,
      },
      body: JSON.stringify({ value }),
    });

    if (resp.statusCode !== 200) {
      // Try to extract detailed error from worker response
      let detail = resp.body;
      try {
        const parsed = JSON.parse(resp.body);
        detail = parsed.details || parsed.error || resp.body;
      } catch {}
      throw new Error(`Worker create-txt failed (${resp.statusCode}): ${detail}`);
    }

    const parsed = JSON.parse(resp.body);
    return { recordId: parsed.recordId };
  }

  private async workerDeleteTXT(recordId: string): Promise<void> {
    const resp = await this.httpsRequest(`${this.provisionUrl}/dns/delete-txt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.getBearerToken()}`,
      },
      body: JSON.stringify({ recordId }),
    });

    if (resp.statusCode !== 200) {
      throw new Error(`Worker delete-txt failed (${resp.statusCode}): ${resp.body}`);
    }
  }

  /**
   * Find an existing ACME challenge TXT record (if any).
   * Returns the recordId if found, null otherwise.
   */
  private async workerFindTXT(): Promise<string | null> {
    try {
      const resp = await this.httpsRequest(`${this.provisionUrl}/dns/find-txt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getBearerToken()}`,
        },
        body: '{}',
      });

      if (resp.statusCode === 200) {
        const parsed = JSON.parse(resp.body);
        if (parsed.found && parsed.recordId) {
          return parsed.recordId;
        }
      }
    } catch (err) {
      this.log('Failed to query existing TXT record (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }

  // ── ACME JWS / crypto helpers ──

  private base64url(data: Buffer): string {
    return data.toString('base64url');
  }

  private base64urlJSON(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
  }

  /**
   * Build the JWK (public) representation of the ECDSA P-256 account key.
   */
  private getAccountJWK(accountKeyPem: string): { kty: string; crv: string; x: string; y: string } {
    const keyObj = crypto.createPublicKey(crypto.createPrivateKey({ key: accountKeyPem, format: 'pem', type: 'pkcs8' }));
    const jwk = keyObj.export({ format: 'jwk' });
    return { kty: jwk.kty as string, crv: jwk.crv as string, x: jwk.x as string, y: jwk.y as string };
  }

  /**
   * Compute the JWK thumbprint (SHA-256) for the account key.
   */
  private getJWKThumbprint(accountKeyPem: string): string {
    const jwk = this.getAccountJWK(accountKeyPem);
    const thumbprintInput = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    const hash = crypto.createHash('sha256').update(thumbprintInput).digest();
    return this.base64url(hash);
  }

  /**
   * Sign an ACME JWS request (ES256 / ECDSA P-256).
   */
  private signJWS(
    accountKeyPem: string,
    url: string,
    payload: string | null,
    nonce: string,
    accountUrl?: string,
  ): string {
    const protectedHeader: Record<string, unknown> = {
      alg: 'ES256',
      nonce,
      url,
    };

    if (accountUrl) {
      protectedHeader['kid'] = accountUrl;
    } else {
      protectedHeader['jwk'] = this.getAccountJWK(accountKeyPem);
    }

    const protectedB64 = this.base64urlJSON(protectedHeader);
    const payloadB64 = payload !== null ? Buffer.from(payload).toString('base64url') : '';
    const signingInput = `${protectedB64}.${payloadB64}`;

    const signer = crypto.createSign('SHA256');
    signer.update(signingInput);
    const derSig = signer.sign({ key: accountKeyPem, dsaEncoding: 'ieee-p1363' });

    return JSON.stringify({
      protected: protectedB64,
      payload: payloadB64,
      signature: this.base64url(derSig),
    });
  }

  // ── ACME protocol methods ──

  private async acmeFetchDirectory(): Promise<ACMEDirectory> {
    const resp = await this.httpsRequest(ACME_DIRECTORY_URL, { method: 'GET' });
    if (resp.statusCode !== 200) {
      throw new Error(`Failed to fetch ACME directory: ${resp.statusCode}`);
    }
    return JSON.parse(resp.body);
  }

  private async acmeFetchNonce(nonceUrl: string): Promise<string> {
    const resp = await this.httpsRequest(nonceUrl, { method: 'HEAD' });
    const nonce = resp.headers['replay-nonce'];
    if (!nonce) {
      throw new Error('No replay-nonce header in response');
    }
    return nonce;
  }

  private async acmePost(
    url: string,
    accountKeyPem: string,
    payload: string | null,
    nonce: string,
    accountUrl?: string,
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
    const jws = this.signJWS(accountKeyPem, url, payload, nonce, accountUrl);
    return this.httpsRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json' },
      body: jws,
    });
  }

  /**
   * Poll an ACME resource until it reaches a target status.
   */
  private async acmePollStatus(
    url: string,
    accountKeyPem: string,
    accountUrl: string,
    nonceUrl: string,
    targetStatuses: string[],
    maxAttempts = 30,
    delayMs = 2000,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const nonce = await this.acmeFetchNonce(nonceUrl);
      const resp = await this.acmePost(url, accountKeyPem, null, nonce, accountUrl);
      const result = JSON.parse(resp.body);
      const status = result.status as string;

      if (targetStatuses.includes(status)) {
        return result;
      }
      if (status === 'invalid') {
        throw new Error(`ACME resource became invalid: ${JSON.stringify(result)}`);
      }

      await this.delay(delayMs);
    }
    throw new Error(`ACME polling timed out after ${maxAttempts} attempts`);
  }

  /**
   * Provision a certificate using the full ACME DNS-01 flow.
   *
   * Steps:
   *  1. Generate key pair + CSR
   *  2. Fetch ACME directory from Let's Encrypt
   *  3. Register/find ACME account
   *  4. Create order for auth.neuronest.cc
   *  5. Get DNS-01 challenge
   *  6. Call Worker to set TXT record
   *  7. Notify Let's Encrypt the challenge is ready
   *  8. Poll until valid
   *  9. Finalize with CSR
   * 10. Download cert
   * 11. Call Worker to clean up TXT record
   * 12. Store cert/key/chain locally
   */
  async provisionCert(): Promise<void> {
    this.log('Starting certificate provisioning (local ACME flow)');

    const { privateKey, csr } = await this.generateCSR();
    const accountKeyPem = this.getOrCreateAccountKey();

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.log('ACME provisioning attempt', { attempt, maxRetries: MAX_RETRIES });

        // Step 1: Fetch ACME directory
        const directory = await this.acmeFetchDirectory();
        this.log('ACME directory fetched');

        // Step 2: Get initial nonce
        let nonce = await this.acmeFetchNonce(directory.newNonce);

        // Step 3: Register or find ACME account
        const accountResp = await this.acmePost(
          directory.newAccount,
          accountKeyPem,
          JSON.stringify({ termsOfServiceAgreed: true }),
          nonce,
        );
        const accountUrl = accountResp.headers['location'];
        if (!accountUrl) {
          throw new Error('No account URL in ACME response');
        }
        nonce = accountResp.headers['replay-nonce'] || await this.acmeFetchNonce(directory.newNonce);
        this.log('ACME account ready', { accountUrl });

        // Step 4: Create order
        const orderResp = await this.acmePost(
          directory.newOrder,
          accountKeyPem,
          JSON.stringify({ identifiers: [{ type: 'dns', value: DOMAIN }] }),
          nonce,
          accountUrl,
        );
        if (orderResp.statusCode !== 201 && orderResp.statusCode !== 200) {
          throw new Error(`Failed to create order: ${orderResp.statusCode} ${orderResp.body}`);
        }
        const order: ACMEOrder = JSON.parse(orderResp.body);
        const orderUrl = orderResp.headers['location']!;
        nonce = orderResp.headers['replay-nonce'] || await this.acmeFetchNonce(directory.newNonce);

        // Step 5: Get authorization and DNS-01 challenge
        const authzUrl = order.authorizations[0]!;
        const authzResp = await this.acmePost(authzUrl, accountKeyPem, null, nonce, accountUrl);
        const authz: ACMEAuthorization = JSON.parse(authzResp.body);
        nonce = authzResp.headers['replay-nonce'] || await this.acmeFetchNonce(directory.newNonce);

        const dns01 = authz.challenges.find(c => c.type === 'dns-01');
        if (!dns01) {
          throw new Error('No DNS-01 challenge found in authorization');
        }

        // Step 6: Compute key authorization and DNS TXT value
        const thumbprint = this.getJWKThumbprint(accountKeyPem);
        const keyAuth = `${dns01.token}.${thumbprint}`;
        const txtValue = this.base64url(crypto.createHash('sha256').update(keyAuth).digest());

        // Step 7: Clean up any stale TXT record from a previous failed attempt, then set new one
        const staleRecordId = await this.workerFindTXT();
        if (staleRecordId) {
          this.log('Removing stale ACME challenge TXT record', { recordId: staleRecordId });
          try {
            await this.workerDeleteTXT(staleRecordId);
          } catch (cleanErr) {
            this.log('Failed to remove stale TXT record (continuing anyway)', {
              error: cleanErr instanceof Error ? cleanErr.message : String(cleanErr),
            });
          }
        }

        const { recordId } = await this.workerCreateTXT(txtValue);
        this.log('DNS TXT record created', { recordId });

        try {
          // Brief delay for DNS propagation
          await this.delay(5000);

          // Step 8: Notify ACME server the challenge is ready
          const challengeResp = await this.acmePost(dns01.url, accountKeyPem, JSON.stringify({}), nonce, accountUrl);
          nonce = challengeResp.headers['replay-nonce'] || await this.acmeFetchNonce(directory.newNonce);

          // Step 9: Poll authorization until valid
          await this.acmePollStatus(authzUrl, accountKeyPem, accountUrl, directory.newNonce, ['valid']);

          // Step 10: Finalize order with CSR
          const csrDer = pemToDer(csr);
          const csrB64 = Buffer.from(csrDer).toString('base64url');

          const finalizeNonce = await this.acmeFetchNonce(directory.newNonce);
          const finalizeResp = await this.acmePost(
            order.finalize,
            accountKeyPem,
            JSON.stringify({ csr: csrB64 }),
            finalizeNonce,
            accountUrl,
          );
          if (finalizeResp.statusCode !== 200 && finalizeResp.statusCode !== 201) {
            throw new Error(`Failed to finalize order: ${finalizeResp.statusCode} ${finalizeResp.body}`);
          }

          // Step 11: Poll order until valid and certificate URL is available
          const completedOrder = await this.acmePollStatus(
            orderUrl, accountKeyPem, accountUrl, directory.newNonce, ['valid'],
          ) as unknown as ACMEOrder;

          if (!completedOrder.certificate) {
            throw new Error('Order completed but no certificate URL');
          }

          // Step 12: Download certificate
          const certNonce = await this.acmeFetchNonce(directory.newNonce);
          const certResp = await this.acmePost(completedOrder.certificate, accountKeyPem, null, certNonce, accountUrl);
          if (certResp.statusCode !== 200) {
            throw new Error(`Failed to download certificate: ${certResp.statusCode}`);
          }

          const fullChain = certResp.body;
          const certs = fullChain.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
          if (!certs || certs.length === 0) {
            throw new Error('No certificates found in response');
          }

          const leafCert = certs[0]!;
          const chain = certs.slice(1).join('\n');

          // Store cert/key/chain locally
          fs.mkdirSync(this.certsDir, { recursive: true });
          fs.writeFileSync(this.keyPath, privateKey, process.platform === 'win32' ? {} : { mode: 0o600 });
          fs.writeFileSync(this.certPath, leafCert);
          fs.writeFileSync(this.chainPath, chain);

          this.log('Certificate provisioned successfully', {
            certPath: this.certPath,
            keyPath: this.keyPath,
            chainPath: this.chainPath,
          });
          return;
        } finally {
          // Step 13: Clean up DNS TXT record
          try {
            await this.workerDeleteTXT(recordId);
            this.log('DNS TXT record cleaned up');
          } catch (cleanupErr) {
            this.log('Failed to clean up DNS TXT record', {
              error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.log('Provisioning attempt failed', { attempt, error: lastError.message });

        if (attempt < MAX_RETRIES) {
          this.log('Scheduling retry', { delayMs: RETRY_DELAY_MS });
          await this.delay(RETRY_DELAY_MS);
        }
      }
    }

    this.log('Certificate provisioning failed after all retries', {
      retries: MAX_RETRIES,
      error: lastError?.message,
    });
    throw lastError ?? new Error('Certificate provisioning failed');
  }

  /**
   * Check certificate expiry and trigger renewal if within 48 hours.
   */
  async checkAndRenew(): Promise<void> {
    this.log('Checking certificate expiry');

    const certInfo = this.getCertInfo();
    if (!certInfo) {
      this.log('No certificate found, triggering provisioning');
      await this.provisionCert();
      return;
    }

    const now = new Date();
    const msUntilExpiry = certInfo.expiryDate.getTime() - now.getTime();
    const hoursUntilExpiry = msUntilExpiry / (1000 * 60 * 60);

    if (hoursUntilExpiry <= RENEWAL_THRESHOLD_HOURS) {
      this.log('Certificate expiring soon, triggering renewal', {
        expiryDate: certInfo.expiryDate.toISOString(),
        hoursRemaining: Math.round(hoursUntilExpiry * 10) / 10,
      });
      await this.provisionCert();
    } else {
      this.log('Certificate is valid', {
        expiryDate: certInfo.expiryDate.toISOString(),
        daysRemaining: certInfo.daysRemaining,
      });
    }
  }

  /**
   * Start the 12-hour periodic health check calling checkAndRenew().
   */
  startHealthMonitor(): void {
    if (this.healthMonitorInterval) {
      this.log('Health monitor already running');
      return;
    }

    this.log('Starting certificate health monitor', {
      intervalMs: HEALTH_CHECK_INTERVAL_MS,
    });

    this.healthMonitorInterval = setInterval(() => {
      this.checkAndRenew().catch((err) => {
        this.log('Health monitor renewal failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Stop the periodic health check.
   */
  stopHealthMonitor(): void {
    if (this.healthMonitorInterval) {
      clearInterval(this.healthMonitorInterval);
      this.healthMonitorInterval = null;
      this.log('Certificate health monitor stopped');
    }
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }

  /**
   * Delay helper for retry logic. Can be overridden in tests.
   */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.retryTimeout = setTimeout(resolve, ms);
    });
  }
}

/**
 * Convert a PEM-encoded string to a DER ArrayBuffer.
 */
function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s/g, '');
  const binary = Buffer.from(base64, 'base64');
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
}
