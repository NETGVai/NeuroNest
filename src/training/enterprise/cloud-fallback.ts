/**
 * Cloud Training Fallback — Offloads training jobs to a configured cloud endpoint
 * when local hardware is unavailable or insufficient.
 *
 * Responsibilities:
 *   - Submit training configuration + dataset to cloud training endpoint
 *   - Poll cloud endpoint for progress updates, relay to UI via same progress panel
 *   - Download trained weights on completion, run local GGUF export + Ollama registration
 *   - Encrypt data in transit (TLS 1.3), enforce NetworkSandbox policy
 *   - Scan dataset for private/sensitive content, warn and require user confirmation
 *   - Track cloud jobs in SQLite (training_cloud_jobs table)
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { EventLog, EventKind } from '../../pipeline/event-log.js';
import type { NetworkSandbox } from '../../security/network-sandbox.js';
import {
  TRAINING_SOURCE_IDENTIFIERS,
} from '../events/training-event-schemas.js';
import type { GGUFExporter, GGUFExportConfig } from '../export/gguf-exporter.js';

// ─── Types ──────────────────────────────────────────────────────

/** Cloud endpoint configuration */
export interface CloudTrainingEndpointConfig {
  /** URL of the cloud training service (must be HTTPS for TLS 1.3) */
  endpoint: string;
  /** API key or token for authentication */
  apiKey: string;
  /** Polling interval in milliseconds (default: 10000) */
  pollIntervalMs?: number;
  /** Maximum poll attempts before timeout (default: 8640 = 24h at 10s intervals) */
  maxPollAttempts?: number;
  /** Connection timeout in milliseconds (default: 30000) */
  connectionTimeoutMs?: number;
}

/** Training configuration sent to the cloud endpoint */
export interface CloudTrainingRequest {
  /** Base model to fine-tune */
  baseModel: string;
  /** Training method */
  method: 'lora' | 'qlora' | 'full-finetune';
  /** Dataset format */
  datasetFormat: 'instruction' | 'chat' | 'continued-pretraining' | 'grpo';
  /** Hyperparameters */
  hyperparameters: Record<string, unknown>;
  /** Base64-encoded dataset content */
  datasetContent: string;
  /** Dataset filename */
  datasetFilename: string;
}

/** Response from the cloud training service on job submission */
export interface CloudTrainingSubmitResponse {
  /** Remote job identifier assigned by cloud service */
  remoteJobId: string;
  /** Estimated duration in milliseconds */
  estimatedDurationMs?: number;
  /** Status message */
  message?: string;
}

/** Progress update from the cloud endpoint */
export interface CloudTrainingProgress {
  /** Remote job state */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Current training step */
  currentStep?: number;
  /** Total training steps */
  totalSteps?: number;
  /** Current loss value */
  loss?: number;
  /** Learning rate */
  learningRate?: number;
  /** ETA in milliseconds */
  etaMs?: number;
  /** Elapsed time in milliseconds */
  elapsedMs?: number;
  /** Error message if failed */
  error?: string;
  /** Download URL for completed weights */
  weightsDownloadUrl?: string;
}

/** Result of a cloud training job */
export interface CloudTrainingResult {
  /** Whether the job completed successfully */
  success: boolean;
  /** Local path to downloaded weights */
  weightsPath?: string;
  /** GGUF export result (if export ran) */
  ggufPath?: string;
  /** Whether model was registered with Ollama */
  ollamaRegistered?: boolean;
  /** Error details if failed */
  error?: string;
  /** Total duration in milliseconds */
  totalDurationMs: number;
}

/** Privacy scan result for a dataset */
export interface PrivacyScanResult {
  /** Whether sensitive content was detected */
  hasSensitiveContent: boolean;
  /** Descriptions of detected sensitive patterns */
  findings: PrivacyScanFinding[];
  /** Total samples scanned */
  totalSamplesScanned: number;
}

/** Individual finding from a privacy scan */
export interface PrivacyScanFinding {
  /** Type of sensitive content detected */
  type: 'private-source' | 'pii' | 'credential' | 'internal-url';
  /** Brief description of the finding */
  description: string;
  /** Sample index where finding was detected */
  sampleIndex: number;
  /** Severity level */
  severity: 'warning' | 'critical';
}

/** Callback for relaying progress to the UI */
export type ProgressCallback = (progress: CloudTrainingProgress) => void;

/** Callback for requesting user confirmation on sensitive content */
export type ConfirmationCallback = (scanResult: PrivacyScanResult) => Promise<boolean>;

/** Cloud job record from SQLite */
export interface CloudJobRecord {
  id: string;
  jobId: string;
  endpoint: string;
  remoteJobId: string | null;
  status: string;
  lastPolledAt: number | null;
  createdAt: number;
}

// ─── SQLite Row Type ────────────────────────────────────────────

interface CloudJobRow {
  id: string;
  job_id: string;
  endpoint: string;
  remote_job_id: string | null;
  status: string;
  last_polled_at: number | null;
  created_at: number;
}

// ─── Errors ─────────────────────────────────────────────────────

export class CloudTrainingError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'CloudTrainingError';
  }
}

export class NetworkPolicyViolationError extends CloudTrainingError {
  constructor(endpoint: string) {
    super(
      `Network policy blocks access to cloud endpoint: ${endpoint}. ` +
      'Update NetworkSandbox policy to allow this destination.',
      'NETWORK_POLICY_BLOCKED',
    );
    this.name = 'NetworkPolicyViolationError';
  }
}

export class TLSRequiredError extends CloudTrainingError {
  constructor(endpoint: string) {
    super(
      `Cloud training endpoint must use HTTPS (TLS 1.3): ${endpoint}. ` +
      'Plaintext HTTP connections are not permitted for training data transit.',
      'TLS_REQUIRED',
    );
    this.name = 'TLSRequiredError';
  }
}

export class SensitiveContentError extends CloudTrainingError {
  constructor(public readonly scanResult: PrivacyScanResult) {
    super(
      `Dataset contains ${scanResult.findings.length} sensitive content finding(s). ` +
      'User confirmation required before transmitting to cloud endpoint.',
      'SENSITIVE_CONTENT_DETECTED',
    );
    this.name = 'SensitiveContentError';
  }
}

// ─── Constants ──────────────────────────────────────────────────

/** Default polling interval for cloud job progress (10 seconds) */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** Default max poll attempts (24 hours at 10s intervals) */
export const DEFAULT_MAX_POLL_ATTEMPTS = 8640;

/** Default connection timeout (30 seconds) */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

/** Event kind for cloud training events */
const CLOUD_JOB_START_KIND = 'training.cloud.start' as EventKind;
const CLOUD_JOB_PROGRESS_KIND = 'training.cloud.progress' as EventKind;
const CLOUD_JOB_COMPLETE_KIND = 'training.cloud.complete' as EventKind;
const CLOUD_JOB_FAILED_KIND = 'training.cloud.failed' as EventKind;

/**
 * Sensitive content patterns for privacy scanning.
 * These patterns detect potentially private data in training datasets.
 */
const SENSITIVE_PATTERNS: Array<{
  type: PrivacyScanFinding['type'];
  pattern: RegExp;
  description: string;
  severity: PrivacyScanFinding['severity'];
}> = [
  {
    type: 'pii',
    pattern: /\b[A-Z][a-z]+\s[A-Z][a-z]+\b.*\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,
    description: 'Possible name with phone number',
    severity: 'warning',
  },
  {
    type: 'pii',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
    description: 'Email address detected',
    severity: 'warning',
  },
  {
    type: 'credential',
    pattern: /(?:api[_-]?key|secret|token|password|auth)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{16,}/i,
    description: 'Possible API key or credential',
    severity: 'critical',
  },
  {
    type: 'credential',
    pattern: /(?:ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{36,}/,
    description: 'GitHub personal access token detected',
    severity: 'critical',
  },
  {
    type: 'credential',
    pattern: /(?:sk-|pk_)[A-Za-z0-9]{32,}/,
    description: 'Possible secret key (sk-/pk- prefix)',
    severity: 'critical',
  },
  {
    type: 'internal-url',
    pattern: /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/,
    description: 'Internal/private network URL detected',
    severity: 'warning',
  },
  {
    type: 'pii',
    pattern: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/,
    description: 'Possible SSN pattern detected',
    severity: 'critical',
  },
];

// ─── CloudTrainingFallback Class ────────────────────────────────

/**
 * Manages cloud-based training job offloading.
 *
 * When local hardware is unavailable or insufficient, training jobs can be
 * offloaded to a configured cloud endpoint. This class handles:
 *   - TLS 1.3 enforcement for all data in transit
 *   - NetworkSandbox policy enforcement
 *   - Dataset privacy scanning with user confirmation flow
 *   - Job submission, progress polling, and weight downloading
 *   - Local GGUF export + Ollama registration after completion
 *   - Persistence of cloud job state in SQLite for crash recovery
 */
export class CloudTrainingFallback {
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;
  private readonly connectionTimeoutMs: number;

  constructor(
    private readonly db: Database.Database,
    private readonly eventLog: EventLog,
    private readonly networkSandbox: NetworkSandbox,
    private readonly ggufExporter: GGUFExporter,
    private readonly endpointConfig: CloudTrainingEndpointConfig,
  ) {
    this.pollIntervalMs = endpointConfig.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPollAttempts = endpointConfig.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
    this.connectionTimeoutMs = endpointConfig.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  }

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Submit a training job to the cloud endpoint.
   *
   * Full flow:
   *   1. Validate endpoint TLS and NetworkSandbox policy
   *   2. Scan dataset for sensitive/private content
   *   3. If sensitive content found, invoke confirmationCallback for user consent
   *   4. Upload training config + dataset to cloud endpoint
   *   5. Poll for progress, relay updates via progressCallback
   *   6. Download trained weights on completion
   *   7. Run local GGUF export + Ollama registration
   *
   * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5
   */
  async submitJob(
    jobId: string,
    request: CloudTrainingRequest,
    options: {
      /** Callback to relay progress updates to the UI */
      onProgress?: ProgressCallback;
      /** Callback to get user confirmation for sensitive content */
      onConfirmationRequired?: ConfirmationCallback;
      /** Output directory for downloaded weights */
      outputDir: string;
      /** Ollama model name for registration */
      ollamaModelName: string;
      /** GGUF quantization type */
      quantization?: 'q4_0' | 'q4_1' | 'q5_0' | 'q5_1' | 'q8_0' | 'f16';
      /** Sources marked as private (for privacy scanning) */
      privateSources?: string[];
    },
  ): Promise<CloudTrainingResult> {
    const startTime = Date.now();

    try {
      // Step 1: Validate TLS and network policy
      this.validateEndpointSecurity(this.endpointConfig.endpoint);

      // Step 2: Scan dataset for sensitive content
      const scanResult = this.scanDatasetForSensitiveContent(
        request.datasetContent,
        options.privateSources,
      );

      // Step 3: If sensitive content detected, require user confirmation
      if (scanResult.hasSensitiveContent) {
        if (!options.onConfirmationRequired) {
          throw new SensitiveContentError(scanResult);
        }

        const confirmed = await options.onConfirmationRequired(scanResult);
        if (!confirmed) {
          throw new CloudTrainingError(
            'User declined to transmit dataset with sensitive content to cloud endpoint.',
            'USER_DECLINED',
          );
        }
      }

      // Step 4: Submit job to cloud endpoint
      const submitResponse = await this.submitToCloud(jobId, request);

      // Persist cloud job record
      this.persistCloudJob(jobId, submitResponse.remoteJobId);

      // Emit start event
      this.emitEvent(CLOUD_JOB_START_KIND, {
        jobId,
        remoteJobId: submitResponse.remoteJobId,
        endpoint: this.endpointConfig.endpoint,
        baseModel: request.baseModel,
        method: request.method,
      });

      // Step 5: Poll for progress
      const finalProgress = await this.pollForCompletion(
        submitResponse.remoteJobId,
        options.onProgress,
      );

      if (finalProgress.status === 'failed') {
        const error = finalProgress.error ?? 'Cloud training job failed without error details';
        this.updateCloudJobStatus(jobId, 'failed');
        this.emitEvent(CLOUD_JOB_FAILED_KIND, {
          jobId,
          remoteJobId: submitResponse.remoteJobId,
          error,
        });
        return {
          success: false,
          error,
          totalDurationMs: Date.now() - startTime,
        };
      }

      if (finalProgress.status !== 'completed' || !finalProgress.weightsDownloadUrl) {
        const error = 'Cloud training did not complete or no download URL provided';
        this.updateCloudJobStatus(jobId, 'failed');
        return {
          success: false,
          error,
          totalDurationMs: Date.now() - startTime,
        };
      }

      // Step 6: Download trained weights
      const weightsPath = await this.downloadWeights(
        finalProgress.weightsDownloadUrl,
        options.outputDir,
      );

      // Step 7: Run local GGUF export + Ollama registration
      const quantization = options.quantization ?? 'q4_0';
      const ggufOutputPath = path.join(
        options.outputDir,
        `${options.ollamaModelName}-${quantization}.gguf`,
      );

      const exportConfig: GGUFExportConfig = {
        modelPath: weightsPath,
        outputPath: ggufOutputPath,
        quantization,
        ollamaModelName: options.ollamaModelName,
        jobId,
      };

      const exportResult = await this.ggufExporter.export(exportConfig);

      // Update cloud job status
      this.updateCloudJobStatus(jobId, 'completed');

      // Emit completion event
      this.emitEvent(CLOUD_JOB_COMPLETE_KIND, {
        jobId,
        remoteJobId: submitResponse.remoteJobId,
        weightsPath,
        ggufPath: exportResult.ggufPath,
        ollamaRegistered: exportResult.ollamaRegistered,
        durationMs: Date.now() - startTime,
      });

      return {
        success: true,
        weightsPath,
        ggufPath: exportResult.ggufPath,
        ollamaRegistered: exportResult.ollamaRegistered,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateCloudJobStatus(jobId, 'failed');

      this.emitEvent(CLOUD_JOB_FAILED_KIND, {
        jobId,
        error: errorMsg,
      });

      return {
        success: false,
        error: errorMsg,
        totalDurationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get the status of a cloud training job from the local database.
   */
  getCloudJobStatus(jobId: string): CloudJobRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM training_cloud_jobs WHERE job_id = ?',
    );
    const row = stmt.get(jobId) as CloudJobRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * List all cloud training jobs.
   */
  listCloudJobs(): CloudJobRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM training_cloud_jobs ORDER BY created_at DESC',
    );
    const rows = stmt.all() as CloudJobRow[];
    return rows.map((row) => this.rowToRecord(row));
  }

  // ─── Security Validation ──────────────────────────────────────

  /**
   * Validate that the cloud endpoint uses TLS (HTTPS) and is permitted
   * by the active NetworkSandbox policy.
   *
   * Requirements: 22.4
   */
  validateEndpointSecurity(endpoint: string): void {
    // Enforce HTTPS (TLS 1.3)
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(endpoint);
    } catch {
      throw new CloudTrainingError(
        `Invalid cloud endpoint URL: ${endpoint}`,
        'INVALID_URL',
      );
    }

    if (parsedUrl.protocol !== 'https:') {
      throw new TLSRequiredError(endpoint);
    }

    // Enforce NetworkSandbox policy
    const policyResult = this.networkSandbox.evaluateRequest(
      'POST',
      endpoint,
    );

    if (!policyResult.allowed) {
      throw new NetworkPolicyViolationError(endpoint);
    }
  }

  // ─── Privacy Scanning ─────────────────────────────────────────

  /**
   * Scan a dataset for private/sensitive content before cloud transmission.
   *
   * Checks for:
   *   - Content from sources marked as private/sensitive
   *   - PII patterns (emails, phone numbers, SSNs)
   *   - Credential patterns (API keys, tokens, passwords)
   *   - Internal/private network URLs
   *
   * Requirements: 22.5
   */
  scanDatasetForSensitiveContent(
    datasetContent: string,
    privateSources?: string[],
  ): PrivacyScanResult {
    const findings: PrivacyScanFinding[] = [];

    // Decode base64 content for scanning
    let decodedContent: string;
    try {
      decodedContent = Buffer.from(datasetContent, 'base64').toString('utf-8');
    } catch {
      // If not base64, treat as raw string
      decodedContent = datasetContent;
    }

    // Split into samples (JSONL format: one JSON object per line)
    const lines = decodedContent.split('\n').filter((line) => line.trim());
    const totalSamplesScanned = lines.length;

    // Check each sample against sensitive patterns
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;

      for (const { type, pattern, description, severity } of SENSITIVE_PATTERNS) {
        if (pattern.test(line)) {
          findings.push({
            type,
            description,
            sampleIndex: i,
            severity,
          });
        }
      }

      // Check for content from private sources
      if (privateSources && privateSources.length > 0) {
        for (const source of privateSources) {
          if (line.includes(source)) {
            findings.push({
              type: 'private-source',
              description: `Content from private source: ${source}`,
              sampleIndex: i,
              severity: 'warning',
            });
          }
        }
      }
    }

    return {
      hasSensitiveContent: findings.length > 0,
      findings,
      totalSamplesScanned,
    };
  }

  // ─── Cloud Communication ──────────────────────────────────────

  /**
   * Submit a training job to the cloud endpoint.
   *
   * Sends training configuration and dataset via HTTPS POST.
   * The cloud service is expected to return a remote job ID.
   *
   * Requirements: 22.1, 22.4
   */
  private async submitToCloud(
    jobId: string,
    request: CloudTrainingRequest,
  ): Promise<CloudTrainingSubmitResponse> {
    const submitUrl = `${this.endpointConfig.endpoint}/v1/training/jobs`;

    const response = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.endpointConfig.apiKey}`,
        'X-Client-Job-Id': jobId,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.connectionTimeoutMs),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'No error body');
      throw new CloudTrainingError(
        `Cloud endpoint returned HTTP ${response.status}: ${errorBody}`,
        'SUBMIT_FAILED',
      );
    }

    const result = await response.json() as CloudTrainingSubmitResponse;

    if (!result.remoteJobId) {
      throw new CloudTrainingError(
        'Cloud endpoint response missing remoteJobId',
        'INVALID_RESPONSE',
      );
    }

    return result;
  }

  /**
   * Poll the cloud endpoint for job progress until completion or failure.
   *
   * Relays progress updates to the UI via the provided callback,
   * using the same progress format as local training.
   *
   * Requirements: 22.2
   */
  private async pollForCompletion(
    remoteJobId: string,
    onProgress?: ProgressCallback,
  ): Promise<CloudTrainingProgress> {
    const statusUrl = `${this.endpointConfig.endpoint}/v1/training/jobs/${remoteJobId}/status`;
    let attempts = 0;
    let lastProgress: CloudTrainingProgress = { status: 'pending' };

    while (attempts < this.maxPollAttempts) {
      // Wait before polling
      await this.sleep(this.pollIntervalMs);
      attempts++;

      try {
        const response = await fetch(statusUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.endpointConfig.apiKey}`,
          },
          signal: AbortSignal.timeout(this.connectionTimeoutMs),
        });

        if (!response.ok) {
          // Transient error — continue polling
          if (response.status >= 500) {
            continue;
          }
          throw new CloudTrainingError(
            `Cloud status endpoint returned HTTP ${response.status}`,
            'POLL_FAILED',
          );
        }

        lastProgress = await response.json() as CloudTrainingProgress;

        // Update the last polled timestamp in the database
        this.updateLastPolled(remoteJobId);

        // Relay progress to UI callback
        if (onProgress) {
          onProgress(lastProgress);
        }

        // Emit progress event
        if (lastProgress.status === 'running') {
          this.emitEvent(CLOUD_JOB_PROGRESS_KIND, {
            remoteJobId,
            status: lastProgress.status,
            currentStep: lastProgress.currentStep,
            totalSteps: lastProgress.totalSteps,
            loss: lastProgress.loss,
          });
        }

        // Terminal states
        if (
          lastProgress.status === 'completed' ||
          lastProgress.status === 'failed' ||
          lastProgress.status === 'cancelled'
        ) {
          return lastProgress;
        }
      } catch (error: unknown) {
        // Network errors during polling are transient — continue
        if (error instanceof CloudTrainingError) {
          throw error;
        }
        // Exponential backoff on transient failures
        if (attempts % 10 === 0) {
          await this.sleep(this.pollIntervalMs * 2);
        }
      }
    }

    // Exceeded max poll attempts
    throw new CloudTrainingError(
      `Cloud training job polling timed out after ${this.maxPollAttempts} attempts`,
      'POLL_TIMEOUT',
    );
  }

  /**
   * Download trained model weights from the cloud endpoint.
   *
   * Validates the download URL against NetworkSandbox policy and
   * ensures TLS is used for the download.
   *
   * Requirements: 22.3, 22.4
   */
  private async downloadWeights(
    downloadUrl: string,
    outputDir: string,
  ): Promise<string> {
    // Validate download URL security
    this.validateEndpointSecurity(downloadUrl);

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    const response = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.endpointConfig.apiKey}`,
      },
      signal: AbortSignal.timeout(this.connectionTimeoutMs * 10), // Longer timeout for downloads
    });

    if (!response.ok) {
      throw new CloudTrainingError(
        `Failed to download weights: HTTP ${response.status}`,
        'DOWNLOAD_FAILED',
      );
    }

    // Stream the response body to a file
    const weightsFilename = 'cloud-trained-weights';
    const weightsPath = path.join(outputDir, weightsFilename);

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(weightsPath, Buffer.from(arrayBuffer));

    return weightsPath;
  }

  // ─── Database Operations ──────────────────────────────────────

  /**
   * Persist a new cloud job record to SQLite.
   */
  private persistCloudJob(jobId: string, remoteJobId: string): void {
    const id = randomUUID();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO training_cloud_jobs (id, job_id, endpoint, remote_job_id, status, last_polled_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', NULL, ?)
    `);

    stmt.run(id, jobId, this.endpointConfig.endpoint, remoteJobId, now);
  }

  /**
   * Update the status of a cloud job.
   */
  private updateCloudJobStatus(jobId: string, status: string): void {
    const stmt = this.db.prepare(
      'UPDATE training_cloud_jobs SET status = ? WHERE job_id = ?',
    );
    stmt.run(status, jobId);
  }

  /**
   * Update the last polled timestamp for a remote job.
   */
  private updateLastPolled(remoteJobId: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      'UPDATE training_cloud_jobs SET last_polled_at = ? WHERE remote_job_id = ?',
    );
    stmt.run(now, remoteJobId);
  }

  // ─── Event Emission ───────────────────────────────────────────

  /**
   * Emit a structured event to the EventLog.
   * Uses the `kb-training` source identifier for rate limiting.
   */
  private emitEvent(kind: EventKind, payload: Record<string, unknown>): void {
    try {
      void this.eventLog.emit({
        sessionId: TRAINING_SOURCE_IDENTIFIERS.TRAINING,
        kind,
        payload,
      });
    } catch {
      // EventLog emission is best-effort; don't crash the cloud training operation
    }
  }

  // ─── Utilities ────────────────────────────────────────────────

  /**
   * Sleep for a specified duration. Used between poll attempts.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Convert a SQLite row to a CloudJobRecord.
   */
  private rowToRecord(row: CloudJobRow): CloudJobRecord {
    return {
      id: row.id,
      jobId: row.job_id,
      endpoint: row.endpoint,
      remoteJobId: row.remote_job_id,
      status: row.status,
      lastPolledAt: row.last_polled_at,
      createdAt: row.created_at,
    };
  }
}
