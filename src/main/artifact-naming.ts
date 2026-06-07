/**
 * Artifact Naming Validation Utility
 *
 * Validates and generates artifact filenames for NeuroNest builds.
 * Enforces consistent naming conventions across all platforms:
 * - macOS: NeuroNest-{version}-mac-universal.{ext}
 * - Windows NSIS: NeuroNest-Setup-{version}-win-x64.exe
 * - Windows Portable: NeuroNest-{version}-win-x64.exe
 * - Linux: NeuroNest-{version}-linux-{arch}.{ext}
 */

/** Only alphanumeric, hyphens, and dots are allowed in artifact filenames */
const ALLOWED_CHARS_REGEX = /^[a-zA-Z0-9\-\.]+$/;

/** Valid semantic version pattern (e.g., 0.1.404) */
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

/** Valid macOS extensions */
const MAC_EXTENSIONS = ['dmg', 'zip'];

/** Valid Linux extensions */
const LINUX_EXTENSIONS = ['AppImage', 'deb', 'rpm'];

/** Valid Linux architectures */
const LINUX_ARCHS = ['x64', 'arm64'];

/** Valid Windows architectures */
const WIN_ARCHS = ['x64', 'arm64'];

export type Platform = 'mac' | 'win-nsis' | 'win-portable' | 'linux';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates an artifact filename against expected patterns for the given platform.
 *
 * @param filename - The artifact filename to validate
 * @param platform - The target platform: 'mac', 'win-nsis', 'win-portable', or 'linux'
 * @param version - The expected semantic version string (e.g., '0.1.404')
 * @param arch - The architecture (required for linux, optional for others)
 * @returns Validation result with error message if invalid
 */
export function validateArtifactName(
  filename: string,
  platform: string,
  version: string,
  arch?: string
): ValidationResult {
  // Check for empty filename
  if (!filename || filename.trim() === '') {
    return { valid: false, error: 'Artifact filename must not be empty' };
  }

  // Check allowed characters
  if (!ALLOWED_CHARS_REGEX.test(filename)) {
    return {
      valid: false,
      error: `Artifact filename "${filename}" contains invalid characters. Only a-z, A-Z, 0-9, hyphen (-), and dot (.) are allowed`,
    };
  }

  // Validate version format
  if (!SEMVER_REGEX.test(version)) {
    return {
      valid: false,
      error: `Version "${version}" is not a valid semantic version (expected format: major.minor.patch)`,
    };
  }

  switch (platform) {
    case 'mac':
      return validateMacArtifact(filename, version);
    case 'win-nsis':
      return validateWinNsisArtifact(filename, version, arch);
    case 'win-portable':
      return validateWinPortableArtifact(filename, version);
    case 'linux':
      return validateLinuxArtifact(filename, version, arch);
    default:
      return { valid: false, error: `Unknown platform "${platform}". Expected: mac, win-nsis, win-portable, linux` };
  }
}

/**
 * Generates the expected artifact filename for a given platform, version, and target.
 *
 * @param platform - The target platform: 'mac', 'win-nsis', 'win-portable', or 'linux'
 * @param version - The semantic version string (e.g., '0.1.404')
 * @param target - The build target/extension (e.g., 'dmg', 'zip', 'exe', 'AppImage', 'deb', 'rpm')
 * @param arch - The architecture (required for linux; defaults to 'x64' for win-nsis)
 * @returns The generated artifact filename
 */
export function generateArtifactName(
  platform: string,
  version: string,
  target: string,
  arch?: string
): string {
  switch (platform) {
    case 'mac':
      return `NeuroNest-${version}-mac-universal.${target}`;
    case 'win-nsis':
      return `NeuroNest-Setup-${version}-win-${arch || 'x64'}.exe`;
    case 'win-portable':
      return `NeuroNest-${version}-win-x64.exe`;
    case 'linux':
      return `NeuroNest-${version}-linux-${arch || 'x64'}.${target}`;
    default:
      throw new Error(`Unknown platform "${platform}". Expected: mac, win-nsis, win-portable, linux`);
  }
}

/**
 * Validates a macOS artifact filename.
 * Expected pattern: NeuroNest-{version}-mac-universal.{ext}
 * Valid extensions: dmg, zip
 */
function validateMacArtifact(filename: string, version: string): ValidationResult {
  const ext = getExtension(filename);
  if (!ext || !MAC_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `macOS artifact "${filename}" has invalid extension "${ext || '(none)'}". Expected: ${MAC_EXTENSIONS.join(', ')}`,
    };
  }

  const expected = `NeuroNest-${version}-mac-universal.${ext}`;
  if (filename !== expected) {
    return {
      valid: false,
      error: `macOS artifact "${filename}" does not match expected pattern. Expected: "${expected}"`,
    };
  }

  return { valid: true };
}

/**
 * Validates a Windows NSIS installer artifact filename.
 * Expected pattern: NeuroNest-Setup-{version}-win-{arch}.exe
 */
function validateWinNsisArtifact(filename: string, version: string, arch?: string): ValidationResult {
  const effectiveArch = arch || 'x64';
  if (!WIN_ARCHS.includes(effectiveArch)) {
    return {
      valid: false,
      error: `Windows architecture "${effectiveArch}" is not valid. Expected: ${WIN_ARCHS.join(', ')}`,
    };
  }

  const ext = getExtension(filename);
  if (ext !== 'exe') {
    return {
      valid: false,
      error: `Windows NSIS artifact "${filename}" must have .exe extension`,
    };
  }

  const expected = `NeuroNest-Setup-${version}-win-${effectiveArch}.exe`;
  if (filename !== expected) {
    return {
      valid: false,
      error: `Windows NSIS artifact "${filename}" does not match expected pattern. Expected: "${expected}"`,
    };
  }

  return { valid: true };
}

/**
 * Validates a Windows portable executable artifact filename.
 * Expected pattern: NeuroNest-{version}-win-x64.exe
 */
function validateWinPortableArtifact(filename: string, version: string): ValidationResult {
  const ext = getExtension(filename);
  if (ext !== 'exe') {
    return {
      valid: false,
      error: `Windows portable artifact "${filename}" must have .exe extension`,
    };
  }

  const expected = `NeuroNest-${version}-win-x64.exe`;
  if (filename !== expected) {
    return {
      valid: false,
      error: `Windows portable artifact "${filename}" does not match expected pattern. Expected: "${expected}"`,
    };
  }

  return { valid: true };
}

/**
 * Validates a Linux artifact filename.
 * Expected pattern: NeuroNest-{version}-linux-{arch}.{ext}
 * Valid extensions: AppImage, deb, rpm
 * Valid architectures: x64, arm64
 */
function validateLinuxArtifact(filename: string, version: string, arch?: string): ValidationResult {
  const effectiveArch = arch || 'x64';
  if (!LINUX_ARCHS.includes(effectiveArch)) {
    return {
      valid: false,
      error: `Linux architecture "${effectiveArch}" is not valid. Expected: ${LINUX_ARCHS.join(', ')}`,
    };
  }

  const ext = getExtension(filename);
  if (!ext || !LINUX_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Linux artifact "${filename}" has invalid extension "${ext || '(none)'}". Expected: ${LINUX_EXTENSIONS.join(', ')}`,
    };
  }

  const expected = `NeuroNest-${version}-linux-${effectiveArch}.${ext}`;
  if (filename !== expected) {
    return {
      valid: false,
      error: `Linux artifact "${filename}" does not match expected pattern. Expected: "${expected}"`,
    };
  }

  return { valid: true };
}

/**
 * Extracts the file extension from a filename.
 * Handles multi-part names by taking the last dot-separated segment.
 */
function getExtension(filename: string): string | undefined {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return undefined;
  }
  return filename.substring(lastDot + 1);
}
