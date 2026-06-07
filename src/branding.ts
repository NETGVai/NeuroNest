/**
 * Application Branding — Single source of truth for app name, description, and identity.
 *
 * All user-facing references to the application name should use these constants
 * instead of hardcoding "NeuroNest". This allows renaming the application by
 * editing branding.json without touching source code.
 *
 * IMPORTANT: Directory paths (~/.neuronest/) and agent IDs (neuronest-architect)
 * are NOT changed by branding — they are stable identifiers tied to user data.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface BrandingConfig {
  appName: string;
  appNameLower: string;
  appDescription: string;
  appTagline: string;
  appUrl: string;
  appAuthor: string;
  appLogo: string;
  appId: string;
}

// Default values (used if branding.json is missing or unreadable)
const DEFAULTS: BrandingConfig = {
  appName: 'NeuroNest',
  appNameLower: 'neuronest',
  appDescription: 'The AI Coding SuperAgent',
  appTagline: 'Self-improving agents, swarm execution, orchestrated workflows, and compounding memory.',
  appUrl: 'https://neuronest.cc',
  appAuthor: 'NETGV AI',
  appLogo: 'build/icon.png',
  appId: 'com.neuronest.app',
};

/**
 * Load branding config from branding.json at the project root.
 * Falls back to defaults if the file is missing or malformed.
 */
function loadBranding(): BrandingConfig {
  try {
    // Try multiple possible locations for branding.json
    const candidates = [
      path.resolve(__dirname, '..', 'branding.json'),       // dist/ → root
      path.resolve(__dirname, '..', '..', 'branding.json'), // dist/main/ → root
      path.resolve(process.cwd(), 'branding.json'),         // CWD
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULTS, ...parsed };
      }
    }
  } catch (err) {
    console.warn('[Branding] Failed to load branding.json, using defaults:', err);
  }

  return DEFAULTS;
}

// Load once at module initialization
const config = loadBranding();

// ─── Exported Constants ─────────────────────────────────────────────────

/** Application display name (e.g., "NeuroNest") */
export const APP_NAME: string = config.appName;

/** Lowercase application name for paths and identifiers (e.g., "neuronest") */
export const APP_NAME_LOWER: string = config.appNameLower;

/** Short description (e.g., "The AI Coding SuperAgent") */
export const APP_DESCRIPTION: string = config.appDescription;

/** Longer tagline for welcome screens */
export const APP_TAGLINE: string = config.appTagline;

/** Application website URL */
export const APP_URL: string = config.appUrl;

/** Author/company name */
export const APP_AUTHOR: string = config.appAuthor;

/** Path to logo file */
export const APP_LOGO: string = config.appLogo;

/** Application ID for OS registration */
export const APP_ID: string = config.appId;

/** Full branding config object (for cases where multiple fields are needed) */
export const BRANDING: BrandingConfig = config;
