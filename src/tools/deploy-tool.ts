/**
 * Deploy Tool — Export and deploy projects to common hosting platforms.
 *
 * Supports deployment targets:
 * - Docker (build image, optionally push)
 * - Vercel (deploy via Vercel CLI)
 * - Netlify (deploy via Netlify CLI)
 * - Cloudflare Pages (deploy via Wrangler CLI)
 *
 * Also supports generating configuration files for each target if they
 * don't already exist.
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type { ToolContext, ToolResult } from '../shared/types.js';
import type { ExecutableToolDefinition } from './tool-system.js';

// ─── Interfaces ─────────────────────────────────────────────────

export type DeployTarget = 'docker' | 'vercel' | 'netlify' | 'cloudflare';

export type DeployAction =
  | 'deploy-docker'
  | 'deploy-vercel'
  | 'deploy-netlify'
  | 'deploy-cloudflare'
  | 'generate-config';

export interface DeployToolInput {
  action: DeployAction;
  /** Target platform (required for generate-config) */
  target?: DeployTarget;
  /** Docker image name/tag for Docker deployments */
  imageName?: string;
  /** Whether to push the Docker image after building */
  push?: boolean;
  /** Whether to deploy as a production deployment (Vercel/Netlify) */
  production?: boolean;
  /** Build output directory for static deployments */
  outputDir?: string;
  /** Cloudflare project name */
  projectName?: string;
}

// ─── Config Templates ───────────────────────────────────────────

export function generateDockerfile(outputDir?: string): string {
  const buildOutput = outputDir || 'dist';
  return [
    '# Multi-stage build',
    'FROM node:20-alpine AS builder',
    '',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci',
    'COPY . .',
    'RUN npm run build',
    '',
    'FROM node:20-alpine AS runner',
    'WORKDIR /app',
    'ENV NODE_ENV=production',
    'COPY --from=builder /app/package*.json ./',
    'RUN npm ci --omit=dev',
    `COPY --from=builder /app/${buildOutput} ./${buildOutput}`,
    '',
    'EXPOSE 3000',
    'CMD ["node", "dist/index.js"]',
    '',
  ].join('\n');
}

export function generateVercelConfig(): string {
  return JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
      framework: null,
    },
    null,
    2,
  ) + '\n';
}

export function generateNetlifyConfig(): string {
  return [
    '[build]',
    '  command = "npm run build"',
    '  publish = "dist"',
    '',
    '[[redirects]]',
    '  from = "/*"',
    '  to = "/index.html"',
    '  status = 200',
    '',
  ].join('\n');
}

export function generateWranglerConfig(projectName?: string): string {
  const name = projectName || 'my-project';
  return [
    `name = "${name}"`,
    'compatibility_date = "2024-01-01"',
    '',
    '[site]',
    '  bucket = "./dist"',
    '',
  ].join('\n');
}

// ─── URL extraction helpers ─────────────────────────────────────

/**
 * Extract deployment URL from command output using common patterns.
 */
export function extractDeploymentUrl(output: string): string | null {
  // Vercel patterns: "Production: https://..." or "Preview: https://..."
  const vercelMatch = output.match(/(?:Production|Preview|Deployed to):\s*(https?:\/\/[^\s]+)/i);
  if (vercelMatch) return vercelMatch[1];

  // Netlify patterns: "Website URL: https://..." or "Unique Deploy URL: https://..."
  const netlifyMatch = output.match(/(?:Website URL|Unique Deploy URL|Deploy URL):\s*(https?:\/\/[^\s]+)/i);
  if (netlifyMatch) return netlifyMatch[1];

  // Cloudflare patterns: "Published to https://..." or "Deployment complete! https://..."
  const cloudflareMatch = output.match(/(?:Published to|Deployment complete!?)\s*(https?:\/\/[^\s]+)/i);
  if (cloudflareMatch) return cloudflareMatch[1];

  // Generic HTTPS URL as fallback
  const genericMatch = output.match(/(https:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z]{2,}[^\s]*)/);
  if (genericMatch) return genericMatch[1];

  return null;
}

/**
 * Suggest fixes based on common deployment error patterns.
 */
export function suggestFixes(target: DeployTarget, errorOutput: string): string[] {
  const suggestions: string[] = [];

  if (errorOutput.includes('command not found') || errorOutput.includes('not recognized')) {
    const cliMap: Record<DeployTarget, string> = {
      docker: 'Install Docker: https://docs.docker.com/get-docker/',
      vercel: 'Install Vercel CLI: npm install -g vercel',
      netlify: 'Install Netlify CLI: npm install -g netlify-cli',
      cloudflare: 'Install Wrangler CLI: npm install -g wrangler',
    };
    suggestions.push(cliMap[target]);
  }

  if (errorOutput.includes('not logged in') || errorOutput.includes('unauthorized') || errorOutput.includes('auth')) {
    const authMap: Record<DeployTarget, string> = {
      docker: 'Run "docker login" to authenticate with your registry',
      vercel: 'Run "vercel login" to authenticate',
      netlify: 'Run "netlify login" to authenticate',
      cloudflare: 'Run "wrangler login" to authenticate',
    };
    suggestions.push(authMap[target]);
  }

  if (errorOutput.includes('build') && errorOutput.includes('fail')) {
    suggestions.push('Check your build script in package.json and fix any build errors first');
  }

  if (errorOutput.includes('ENOENT') || errorOutput.includes('no such file')) {
    suggestions.push('Ensure the output/build directory exists. Run "npm run build" first');
  }

  if (errorOutput.includes('permission') || errorOutput.includes('EACCES')) {
    suggestions.push('Check file permissions or run with appropriate privileges');
  }

  if (suggestions.length === 0) {
    suggestions.push(`Check the ${target} documentation for troubleshooting this error`);
  }

  return suggestions;
}

// ─── Command execution helper ───────────────────────────────────

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

async function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number = 120_000,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const proc = spawn(command, [], {
      shell: true,
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        proc.kill('SIGTERM');
      }
    }, timeoutMs);

    proc.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 137 : 1),
        timedOut,
      });
    });

    proc.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + '\n' + err.message,
        exitCode: 1,
        timedOut: false,
      });
    });
  });
}

// ─── Action Handlers ────────────────────────────────────────────

async function handleGenerateConfig(
  input: DeployToolInput,
  projectDir: string,
): Promise<ToolResult> {
  const { target, outputDir, projectName } = input;

  if (!target) {
    return {
      success: false,
      output: null,
      error: 'Missing required parameter: target (docker | vercel | netlify | cloudflare)',
    };
  }

  let fileName: string;
  let content: string;

  switch (target) {
    case 'docker':
      fileName = 'Dockerfile';
      content = generateDockerfile(outputDir);
      break;
    case 'vercel':
      fileName = 'vercel.json';
      content = generateVercelConfig();
      break;
    case 'netlify':
      fileName = 'netlify.toml';
      content = generateNetlifyConfig();
      break;
    case 'cloudflare':
      fileName = 'wrangler.toml';
      content = generateWranglerConfig(projectName);
      break;
    default:
      return {
        success: false,
        output: null,
        error: `Unknown target: ${target}. Valid targets: docker, vercel, netlify, cloudflare`,
      };
  }

  const filePath = path.join(projectDir, fileName);

  // Check if file already exists
  try {
    await fs.access(filePath);
    return {
      success: true,
      output: {
        filePath: fileName,
        alreadyExists: true,
        message: `${fileName} already exists in the project directory. No changes made.`,
      },
    };
  } catch {
    // File doesn't exist, create it
  }

  await fs.writeFile(filePath, content, 'utf-8');

  return {
    success: true,
    output: {
      filePath: fileName,
      alreadyExists: false,
      content,
      message: `Generated ${fileName} in project root`,
    },
  };
}

async function handleDeployDocker(
  input: DeployToolInput,
  context: ToolContext,
  projectDir: string,
): Promise<ToolResult> {
  const { imageName, push, outputDir } = input;
  const tag = imageName || 'app:latest';

  // Ensure Dockerfile exists; generate one if missing
  const dockerfilePath = path.join(projectDir, 'Dockerfile');
  try {
    await fs.access(dockerfilePath);
  } catch {
    const content = generateDockerfile(outputDir);
    await fs.writeFile(dockerfilePath, content, 'utf-8');
  }

  // Build command
  const buildCommand = `docker build -t ${tag} .`;

  // Request approval
  const approved = await requestApproval(context, buildCommand);
  if (!approved) {
    return {
      success: false,
      output: null,
      error: 'Docker build command rejected by user',
    };
  }

  // Execute build
  const buildResult = await executeCommand(buildCommand, projectDir);

  if (buildResult.exitCode !== 0) {
    const combinedOutput = buildResult.stdout + '\n' + buildResult.stderr;
    return {
      success: false,
      output: {
        stdout: buildResult.stdout,
        stderr: buildResult.stderr,
        exitCode: buildResult.exitCode,
      },
      error: `Docker build failed.\n\nSuggested fixes:\n${suggestFixes('docker', combinedOutput).map(s => `- ${s}`).join('\n')}`,
    };
  }

  // Optionally push
  if (push) {
    const pushCommand = `docker push ${tag}`;
    const pushApproved = await requestApproval(context, pushCommand);
    if (!pushApproved) {
      return {
        success: true,
        output: {
          message: `Docker image built successfully as "${tag}" but push was rejected by user.`,
          imageName: tag,
          pushed: false,
        },
      };
    }

    const pushResult = await executeCommand(pushCommand, projectDir);
    if (pushResult.exitCode !== 0) {
      const combinedOutput = pushResult.stdout + '\n' + pushResult.stderr;
      return {
        success: false,
        output: {
          stdout: pushResult.stdout,
          stderr: pushResult.stderr,
          exitCode: pushResult.exitCode,
        },
        error: `Docker push failed.\n\nSuggested fixes:\n${suggestFixes('docker', combinedOutput).map(s => `- ${s}`).join('\n')}`,
      };
    }

    const url = extractDeploymentUrl(pushResult.stdout + pushResult.stderr);
    return {
      success: true,
      output: {
        message: `Docker image "${tag}" built and pushed successfully.`,
        imageName: tag,
        pushed: true,
        url: url || undefined,
      },
    };
  }

  return {
    success: true,
    output: {
      message: `Docker image built successfully as "${tag}".`,
      imageName: tag,
      pushed: false,
    },
  };
}

async function handleDeployVercel(
  input: DeployToolInput,
  context: ToolContext,
  projectDir: string,
): Promise<ToolResult> {
  const { production } = input;

  // Ensure vercel.json exists
  const vercelConfigPath = path.join(projectDir, 'vercel.json');
  try {
    await fs.access(vercelConfigPath);
  } catch {
    const content = generateVercelConfig();
    await fs.writeFile(vercelConfigPath, content, 'utf-8');
  }

  const command = production ? 'vercel --prod --yes' : 'vercel --yes';

  const approved = await requestApproval(context, command);
  if (!approved) {
    return {
      success: false,
      output: null,
      error: 'Vercel deploy command rejected by user',
    };
  }

  const result = await executeCommand(command, projectDir);
  const combinedOutput = result.stdout + '\n' + result.stderr;

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      error: `Vercel deployment failed.\n\nSuggested fixes:\n${suggestFixes('vercel', combinedOutput).map(s => `- ${s}`).join('\n')}`,
    };
  }

  const url = extractDeploymentUrl(combinedOutput);
  return {
    success: true,
    output: {
      message: url
        ? `Deployed to Vercel successfully: ${url}`
        : 'Deployed to Vercel successfully.',
      url: url || undefined,
      production: production || false,
    },
  };
}

async function handleDeployNetlify(
  input: DeployToolInput,
  context: ToolContext,
  projectDir: string,
): Promise<ToolResult> {
  const { production, outputDir } = input;

  // Ensure netlify.toml exists
  const netlifyConfigPath = path.join(projectDir, 'netlify.toml');
  try {
    await fs.access(netlifyConfigPath);
  } catch {
    const content = generateNetlifyConfig();
    await fs.writeFile(netlifyConfigPath, content, 'utf-8');
  }

  const dir = outputDir || 'dist';
  const command = production
    ? `netlify deploy --prod --dir=${dir}`
    : `netlify deploy --dir=${dir}`;

  const approved = await requestApproval(context, command);
  if (!approved) {
    return {
      success: false,
      output: null,
      error: 'Netlify deploy command rejected by user',
    };
  }

  const result = await executeCommand(command, projectDir);
  const combinedOutput = result.stdout + '\n' + result.stderr;

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      error: `Netlify deployment failed.\n\nSuggested fixes:\n${suggestFixes('netlify', combinedOutput).map(s => `- ${s}`).join('\n')}`,
    };
  }

  const url = extractDeploymentUrl(combinedOutput);
  return {
    success: true,
    output: {
      message: url
        ? `Deployed to Netlify successfully: ${url}`
        : 'Deployed to Netlify successfully.',
      url: url || undefined,
      production: production || false,
    },
  };
}

async function handleDeployCloudflare(
  input: DeployToolInput,
  context: ToolContext,
  projectDir: string,
): Promise<ToolResult> {
  const { projectName, outputDir } = input;

  // Ensure wrangler.toml exists
  const wranglerConfigPath = path.join(projectDir, 'wrangler.toml');
  try {
    await fs.access(wranglerConfigPath);
  } catch {
    const content = generateWranglerConfig(projectName);
    await fs.writeFile(wranglerConfigPath, content, 'utf-8');
  }

  const dir = outputDir || 'dist';
  const name = projectName || 'my-project';
  const command = `wrangler pages deploy ${dir} --project-name=${name}`;

  const approved = await requestApproval(context, command);
  if (!approved) {
    return {
      success: false,
      output: null,
      error: 'Cloudflare Pages deploy command rejected by user',
    };
  }

  const result = await executeCommand(command, projectDir);
  const combinedOutput = result.stdout + '\n' + result.stderr;

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      error: `Cloudflare Pages deployment failed.\n\nSuggested fixes:\n${suggestFixes('cloudflare', combinedOutput).map(s => `- ${s}`).join('\n')}`,
    };
  }

  const url = extractDeploymentUrl(combinedOutput);
  return {
    success: true,
    output: {
      message: url
        ? `Deployed to Cloudflare Pages successfully: ${url}`
        : 'Deployed to Cloudflare Pages successfully.',
      url: url || undefined,
      projectName: name,
    },
  };
}

// ─── Approval helper ────────────────────────────────────────────

async function requestApproval(context: ToolContext, command: string): Promise<boolean> {
  const isAutoApprove = context.permissionMode === 'auto-approve';
  if (isAutoApprove) return true;

  if (context.approvalHandler) {
    return context.approvalHandler(command);
  }

  return false;
}

// ─── Main execute function ──────────────────────────────────────

async function deployToolExecute(input: unknown, context: ToolContext): Promise<ToolResult> {
  const params = input as DeployToolInput;

  if (!params || typeof params !== 'object') {
    return { success: false, output: null, error: 'Invalid input: expected an object' };
  }

  const { action } = params;

  if (!action || typeof action !== 'string') {
    return {
      success: false,
      output: null,
      error: 'Missing required parameter: action (deploy-docker | deploy-vercel | deploy-netlify | deploy-cloudflare | generate-config)',
    };
  }

  if (!context.projectDir) {
    return { success: false, output: null, error: 'No project directory set in context' };
  }

  const projectDir = path.resolve(context.projectDir);

  switch (action) {
    case 'deploy-docker':
      return handleDeployDocker(params, context, projectDir);

    case 'deploy-vercel':
      return handleDeployVercel(params, context, projectDir);

    case 'deploy-netlify':
      return handleDeployNetlify(params, context, projectDir);

    case 'deploy-cloudflare':
      return handleDeployCloudflare(params, context, projectDir);

    case 'generate-config':
      return handleGenerateConfig(params, projectDir);

    default:
      return {
        success: false,
        output: null,
        error: `Unknown action: ${action}. Valid actions: deploy-docker, deploy-vercel, deploy-netlify, deploy-cloudflare, generate-config`,
      };
  }
}

// ─── Tool Definition ────────────────────────────────────────────

export const DeployTool: ExecutableToolDefinition = {
  id: 'deploy',
  name: 'DeployTool',
  description:
    'Deploy projects to Docker, Vercel, Netlify, or Cloudflare Pages. Generates config files if missing and executes deployment commands with user approval.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['deploy-docker', 'deploy-vercel', 'deploy-netlify', 'deploy-cloudflare', 'generate-config'],
        description: 'The deployment action to perform',
      },
      target: {
        type: 'string',
        enum: ['docker', 'vercel', 'netlify', 'cloudflare'],
        description: 'Target platform (required for generate-config action)',
      },
      imageName: {
        type: 'string',
        description: 'Docker image name/tag (default: "app:latest")',
      },
      push: {
        type: 'boolean',
        description: 'Whether to push the Docker image after building (default: false)',
      },
      production: {
        type: 'boolean',
        description: 'Whether to deploy as production (Vercel/Netlify, default: false)',
      },
      outputDir: {
        type: 'string',
        description: 'Build output directory for deployments (default: "dist")',
      },
      projectName: {
        type: 'string',
        description: 'Cloudflare Pages project name',
      },
    },
    required: ['action'],
  },
  riskLevel: 'execute',
  execute: deployToolExecute,
};
