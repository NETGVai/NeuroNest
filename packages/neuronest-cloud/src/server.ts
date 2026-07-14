/**
 * NeuroNest Cloud Agent — HTTP Server
 *
 * REST API for task submission, status checking, and result retrieval.
 * Webhook triggers with HMAC signature verification.
 * Cron-scheduled triggers with configurable schedules.
 * Multi-tenant isolation: per-project/team data separation.
 *
 * Task 22.1
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { WebSocketServer } from 'ws';
import { CronScheduler } from './cron-scheduler';
import { TenantIsolation, TenantContext } from './tenant-isolation';

// ─── Types ──────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CloudTask {
  id: string;
  tenantId: string;
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
  status: TaskStatus;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookConfig {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
}

export interface CronTrigger {
  id: string;
  tenantId: string;
  schedule: string;  // cron expression
  taskType: string;
  payload: Record<string, unknown>;
  active: boolean;
}

export interface ServerConfig {
  port: number;
  host: string;
  hmacAlgorithm: string;
  maxPayloadSize: number;
  rateLimitPerMinute: number;
}

// ─── In-Memory Stores (per-tenant isolation) ─────────────────────

const tasks = new Map<string, CloudTask>();
const webhooks = new Map<string, WebhookConfig>();
const cronTriggers = new Map<string, CronTrigger>();

// ─── HMAC Signature Verification ─────────────────────────────────

function computeHmacSignature(payload: string, secret: string, algorithm = 'sha256'): string {
  return crypto.createHmac(algorithm, secret).update(payload).digest('hex');
}

function verifyHmacSignature(
  payload: string,
  signature: string,
  secret: string,
  algorithm = 'sha256'
): boolean {
  const expected = computeHmacSignature(payload, secret, algorithm);
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Rate Limiting ──────────────────────────────────────────────

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(tenantId: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(tenantId);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(tenantId, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (entry.count >= maxPerMinute) {
    return false;
  }

  entry.count++;
  return true;
}

// ─── Request Parsing ─────────────────────────────────────────────

function parseBody(req: http.IncomingMessage, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function extractTenantContext(req: http.IncomingMessage): TenantContext | null {
  const tenantId = req.headers['x-tenant-id'] as string | undefined;
  const projectId = req.headers['x-project-id'] as string | undefined;
  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (!tenantId || !apiKey) {
    return null;
  }

  return { tenantId, projectId: projectId || 'default', apiKey };
}

// ─── Route Handlers ──────────────────────────────────────────────

/** POST /api/tasks — Submit a new task */
function handleSubmitTask(
  body: string,
  tenant: TenantContext,
  res: http.ServerResponse
): void {
  let parsed: { type: string; payload?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!parsed.type) {
    sendJson(res, 400, { error: 'Missing required field: type' });
    return;
  }

  const task: CloudTask = {
    id: uuidv4(),
    tenantId: tenant.tenantId,
    projectId: tenant.projectId,
    type: parsed.type,
    payload: parsed.payload || {},
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  tasks.set(task.id, task);
  sendJson(res, 201, { taskId: task.id, status: task.status });
}

/** GET /api/tasks/:id — Check task status */
function handleGetTask(
  taskId: string,
  tenant: TenantContext,
  res: http.ServerResponse
): void {
  const task = tasks.get(taskId);

  if (!task) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }

  // Multi-tenant isolation: only allow access to own tasks
  if (!TenantIsolation.canAccess(tenant, task.tenantId, task.projectId)) {
    sendJson(res, 403, { error: 'Access denied' });
    return;
  }

  sendJson(res, 200, {
    id: task.id,
    type: task.type,
    status: task.status,
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

/** GET /api/tasks — List tasks for tenant */
function handleListTasks(
  tenant: TenantContext,
  res: http.ServerResponse
): void {
  const tenantTasks = Array.from(tasks.values())
    .filter(t => TenantIsolation.canAccess(tenant, t.tenantId, t.projectId))
    .map(t => ({
      id: t.id,
      type: t.type,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }));

  sendJson(res, 200, { tasks: tenantTasks });
}

/** GET /api/tasks/:id/result — Retrieve task result */
function handleGetResult(
  taskId: string,
  tenant: TenantContext,
  res: http.ServerResponse
): void {
  const task = tasks.get(taskId);

  if (!task) {
    sendJson(res, 404, { error: 'Task not found' });
    return;
  }

  if (!TenantIsolation.canAccess(tenant, task.tenantId, task.projectId)) {
    sendJson(res, 403, { error: 'Access denied' });
    return;
  }

  if (task.status !== 'completed' && task.status !== 'failed') {
    sendJson(res, 409, { error: 'Task not yet finished', status: task.status });
    return;
  }

  sendJson(res, 200, { id: task.id, status: task.status, result: task.result, error: task.error });
}

/** POST /api/webhooks/incoming — Receive inbound webhook with HMAC verification */
function handleIncomingWebhook(
  body: string,
  headers: http.IncomingHttpHeaders,
  res: http.ServerResponse
): void {
  const signature = headers['x-webhook-signature'] as string | undefined;
  const webhookId = headers['x-webhook-id'] as string | undefined;

  if (!signature || !webhookId) {
    sendJson(res, 401, { error: 'Missing webhook signature or ID' });
    return;
  }

  const webhook = webhooks.get(webhookId);
  if (!webhook || !webhook.active) {
    sendJson(res, 404, { error: 'Webhook not found or inactive' });
    return;
  }

  if (!verifyHmacSignature(body, signature, webhook.secret)) {
    sendJson(res, 401, { error: 'Invalid webhook signature' });
    return;
  }

  let parsed: { event: string; data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!webhook.events.includes(parsed.event)) {
    sendJson(res, 422, { error: `Event "${parsed.event}" not subscribed` });
    return;
  }

  // Create a task from the webhook event
  const task: CloudTask = {
    id: uuidv4(),
    tenantId: webhook.tenantId,
    projectId: 'default',
    type: `webhook.${parsed.event}`,
    payload: parsed.data || {},
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  tasks.set(task.id, task);
  sendJson(res, 202, { taskId: task.id, event: parsed.event });
}

/** POST /api/webhooks — Register a new webhook */
function handleRegisterWebhook(
  body: string,
  tenant: TenantContext,
  res: http.ServerResponse
): void {
  let parsed: { url: string; events: string[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!parsed.url || !parsed.events?.length) {
    sendJson(res, 400, { error: 'Missing required fields: url, events' });
    return;
  }

  const secret = crypto.randomBytes(32).toString('hex');
  const webhook: WebhookConfig = {
    id: uuidv4(),
    tenantId: tenant.tenantId,
    url: parsed.url,
    secret,
    events: parsed.events,
    active: true,
  };

  webhooks.set(webhook.id, webhook);
  sendJson(res, 201, { webhookId: webhook.id, secret });
}

/** POST /api/cron — Register a cron trigger */
function handleRegisterCron(
  body: string,
  tenant: TenantContext,
  scheduler: CronScheduler,
  res: http.ServerResponse
): void {
  let parsed: { schedule: string; taskType: string; payload?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!parsed.schedule || !parsed.taskType) {
    sendJson(res, 400, { error: 'Missing required fields: schedule, taskType' });
    return;
  }

  if (!CronScheduler.isValidExpression(parsed.schedule)) {
    sendJson(res, 400, { error: 'Invalid cron expression' });
    return;
  }

  const trigger: CronTrigger = {
    id: uuidv4(),
    tenantId: tenant.tenantId,
    schedule: parsed.schedule,
    taskType: parsed.taskType,
    payload: parsed.payload || {},
    active: true,
  };

  cronTriggers.set(trigger.id, trigger);
  scheduler.register(trigger, () => {
    const task: CloudTask = {
      id: uuidv4(),
      tenantId: trigger.tenantId,
      projectId: 'default',
      type: trigger.taskType,
      payload: trigger.payload,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    tasks.set(task.id, task);
  });

  sendJson(res, 201, { cronId: trigger.id, schedule: trigger.schedule });
}

// ─── Server Factory ─────────────────────────────────────────────

export function createCloudServer(config: Partial<ServerConfig> = {}): http.Server {
  const resolvedConfig: ServerConfig = {
    port: config.port ?? 3100,
    host: config.host ?? '0.0.0.0',
    hmacAlgorithm: config.hmacAlgorithm ?? 'sha256',
    maxPayloadSize: config.maxPayloadSize ?? 1_048_576,  // 1MB
    rateLimitPerMinute: config.rateLimitPerMinute ?? 100,
  };

  const scheduler = new CronScheduler();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method?.toUpperCase();

    // Health check — no auth required
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok', timestamp: Date.now() });
      return;
    }

    // Webhook incoming — uses its own auth (HMAC)
    if (method === 'POST' && path === '/api/webhooks/incoming') {
      try {
        const body = await parseBody(req, resolvedConfig.maxPayloadSize);
        handleIncomingWebhook(body, req.headers, res);
      } catch (err) {
        sendJson(res, 413, { error: 'Payload too large' });
      }
      return;
    }

    // All other routes require tenant context
    const tenant = extractTenantContext(req);
    if (!tenant) {
      sendJson(res, 401, { error: 'Missing X-Tenant-ID or X-API-Key headers' });
      return;
    }

    // Rate limiting
    if (!checkRateLimit(tenant.tenantId, resolvedConfig.rateLimitPerMinute)) {
      sendJson(res, 429, { error: 'Rate limit exceeded' });
      return;
    }

    try {
      // Task routes
      if (method === 'POST' && path === '/api/tasks') {
        const body = await parseBody(req, resolvedConfig.maxPayloadSize);
        handleSubmitTask(body, tenant, res);
        return;
      }

      if (method === 'GET' && path === '/api/tasks') {
        handleListTasks(tenant, res);
        return;
      }

      const taskMatch = path.match(/^\/api\/tasks\/([a-f0-9-]+)$/);
      if (method === 'GET' && taskMatch) {
        handleGetTask(taskMatch[1], tenant, res);
        return;
      }

      const resultMatch = path.match(/^\/api\/tasks\/([a-f0-9-]+)\/result$/);
      if (method === 'GET' && resultMatch) {
        handleGetResult(resultMatch[1], tenant, res);
        return;
      }

      // Webhook registration
      if (method === 'POST' && path === '/api/webhooks') {
        const body = await parseBody(req, resolvedConfig.maxPayloadSize);
        handleRegisterWebhook(body, tenant, res);
        return;
      }

      // Cron registration
      if (method === 'POST' && path === '/api/cron') {
        const body = await parseBody(req, resolvedConfig.maxPayloadSize);
        handleRegisterCron(body, tenant, scheduler, res);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      sendJson(res, 500, { error: message });
    }
  });

  // WebSocket server for real-time updates
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const tenantId = url.searchParams.get('tenantId');

    if (!tenantId) {
      ws.close(4001, 'Missing tenantId');
      return;
    }

    ws.on('message', (data) => {
      // Echo acknowledgments
      ws.send(JSON.stringify({ type: 'ack', timestamp: Date.now() }));
    });
  });

  return server;
}

// ─── Entry Point ─────────────────────────────────────────────────

export function startCloudServer(config: Partial<ServerConfig> = {}): http.Server {
  const server = createCloudServer(config);
  const port = config.port ?? 3100;
  const host = config.host ?? '0.0.0.0';

  server.listen(port, host, () => {
    console.log(`[neuronest-cloud] Server listening on ${host}:${port}`);
  });

  return server;
}

// Export for integrations
export { computeHmacSignature, verifyHmacSignature };
export { CronScheduler } from './cron-scheduler';
export { TenantIsolation, TenantContext } from './tenant-isolation';
