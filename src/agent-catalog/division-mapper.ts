/**
 * Division Mapper
 *
 * Maps directory paths from the agency-agents repository structure
 * to NeuroNest department names. Supports both existing and new divisions.
 *
 * Requirements: 3.1, 3.2, 3.4
 */

// ─────────────────────────────────────────────
// DEPARTMENTS Array
// ─────────────────────────────────────────────

/**
 * Complete list of all NeuroNest departments, maintained in alphabetical order.
 * Includes both existing departments and new divisions from agency-agents.
 */
export const DEPARTMENTS: string[] = [
  'Academic',
  'Consensus',
  'Data Science',
  'Design',
  'DevOps',
  'Engineering',
  'Finance',
  'Game Development',
  'GIS',
  'Healthcare',
  'Infrastructure',
  'Marketing',
  'NeuroNest Orchestration',
  'Optimization',
  'Paid Media',
  'Product',
  'Project Management',
  'Research',
  'Sales',
  'Security',
  'Software Delivery',
  'Spatial Computing',
  'Specialized',
  'Support',
  'Testing',
];

// ─────────────────────────────────────────────
// Directory-to-Department Mapping Table
// ─────────────────────────────────────────────

/**
 * Maps lowercase directory names to NeuroNest department names.
 * Includes both existing departments and new divisions from agency-agents.
 */
const DIRECTORY_TO_DEPARTMENT: Record<string, string> = {
  // Existing NeuroNest departments
  engineering: 'Engineering',
  design: 'Design',
  marketing: 'Marketing',
  product: 'Product',
  'project-management': 'Project Management',
  'project_management': 'Project Management',
  projectmanagement: 'Project Management',
  testing: 'Testing',
  support: 'Support',
  specialized: 'Specialized',
  consensus: 'Consensus',
  infrastructure: 'Infrastructure',
  optimization: 'Optimization',
  research: 'Research',
  'software-delivery': 'Software Delivery',
  'software_delivery': 'Software Delivery',
  softwaredelivery: 'Software Delivery',
  'neuronest-orchestration': 'NeuroNest Orchestration',
  'data-science': 'Data Science',
  'data_science': 'Data Science',
  datascience: 'Data Science',

  // New divisions from agency-agents
  sales: 'Sales',
  'paid-media': 'Paid Media',
  'paid_media': 'Paid Media',
  paidmedia: 'Paid Media',
  'spatial-computing': 'Spatial Computing',
  'spatial_computing': 'Spatial Computing',
  spatialcomputing: 'Spatial Computing',
  finance: 'Finance',
  'game-development': 'Game Development',
  'game_development': 'Game Development',
  gamedevelopment: 'Game Development',
  academic: 'Academic',
  gis: 'GIS',
  healthcare: 'Healthcare',
  security: 'Security',
  devops: 'DevOps',
};

// ─────────────────────────────────────────────
// Division-to-Permission Mapping
// ─────────────────────────────────────────────

export interface DivisionPermissionProfile {
  read: boolean;
  edit: boolean;
  command: boolean;
  mcp: boolean;
}

/**
 * Maps departments to their default tool permission profiles.
 * Used by the Agent Importer to assign initial permissions.
 */
export const DIVISION_PERMISSION_MAP: Record<string, DivisionPermissionProfile> = {
  // Engineering, DevOps, Infrastructure
  Engineering: { read: true, edit: true, command: true, mcp: false },
  DevOps: { read: true, edit: true, command: true, mcp: false },
  Infrastructure: { read: true, edit: true, command: true, mcp: false },

  // Design, Product, Project Management
  Design: { read: true, edit: true, command: false, mcp: false },
  Product: { read: true, edit: true, command: false, mcp: false },
  'Project Management': { read: true, edit: true, command: false, mcp: false },

  // Marketing, Sales, Paid Media, Support, Academic, Finance
  Marketing: { read: true, edit: false, command: false, mcp: false },
  Sales: { read: true, edit: false, command: false, mcp: false },
  'Paid Media': { read: true, edit: false, command: false, mcp: false },
  Support: { read: true, edit: false, command: false, mcp: false },
  Academic: { read: true, edit: false, command: false, mcp: false },
  Finance: { read: true, edit: false, command: false, mcp: false },

  // Testing, Security, Game Development
  Testing: { read: true, edit: true, command: true, mcp: false },
  Security: { read: true, edit: true, command: true, mcp: false },
  'Game Development': { read: true, edit: true, command: true, mcp: false },
};

/** Default permission profile for divisions not in the mapping table. */
export const DEFAULT_PERMISSION_PROFILE: DivisionPermissionProfile = {
  read: true,
  edit: false,
  command: false,
  mcp: false,
};

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Maps a directory path segment to a NeuroNest department name.
 *
 * Extracts the first meaningful directory name from the path
 * and looks it up in the mapping table. Returns 'Specialized'
 * for unmapped directories.
 *
 * @param directoryPath - Relative path from the agent repository root
 * @returns The mapped department name, or 'Specialized' if no mapping exists
 */
export function mapDirectoryToDepartment(directoryPath: string): string {
  // Normalize: strip leading/trailing slashes, lowercase
  const normalized = directoryPath.replace(/^\/+|\/+$/g, '').toLowerCase();

  // Try the first directory segment
  const segments = normalized.split('/').filter((s) => s.length > 0);

  for (const segment of segments) {
    const department = DIRECTORY_TO_DEPARTMENT[segment];
    if (department) {
      return department;
    }
  }

  return 'Specialized';
}

/**
 * Gets the default tool permission profile for a department.
 *
 * @param department - The department name
 * @returns The permission profile for the department, or the default profile
 */
export function getPermissionForDivision(department: string): DivisionPermissionProfile {
  return DIVISION_PERMISSION_MAP[department] ?? DEFAULT_PERMISSION_PROFILE;
}

/**
 * Checks if a department already exists in the DEPARTMENTS array.
 */
export function departmentExists(department: string): boolean {
  return DEPARTMENTS.includes(department);
}

/**
 * Adds a new department to the DEPARTMENTS array.
 * Maintains alphabetical ordering.
 *
 * @param name - The department name to add
 * @returns true if the department was added, false if it already exists, is invalid, or failed
 */
export function addDepartment(name: string): boolean {
  if (!name || typeof name !== 'string') {
    return false;
  }

  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (DEPARTMENTS.includes(trimmed)) {
    return false;
  }

  try {
    DEPARTMENTS.push(trimmed);
    DEPARTMENTS.sort((a, b) => a.localeCompare(b));
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempts to register a department. Unlike addDepartment, this returns true
 * if the department already exists (for use during import where we just need
 * the department to be present).
 *
 * @param department - The department name to register
 * @returns true if the department is now available, false on failure
 */
export function registerDepartment(department: string): boolean {
  if (!department || typeof department !== 'string') {
    return false;
  }

  const trimmed = department.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (DEPARTMENTS.includes(trimmed)) {
    return true;
  }

  try {
    DEPARTMENTS.push(trimmed);
    DEPARTMENTS.sort((a, b) => a.localeCompare(b));
    return true;
  } catch {
    return false;
  }
}

/**
 * Color-to-emoji mapping for frontmatter color fields.
 * Falls back to default 🤖 for unknown colors.
 */
const COLOR_TO_EMOJI: Record<string, string> = {
  red: '🔴',
  orange: '🟠',
  yellow: '🟡',
  green: '🟢',
  blue: '🔵',
  purple: '🟣',
  pink: '💗',
  black: '⚫',
  white: '⚪',
  brown: '🟤',
  // Common frontmatter color strings
  '#ff0000': '🔴',
  '#00ff00': '🟢',
  '#0000ff': '🔵',
  '#ffff00': '🟡',
  '#ff00ff': '🟣',
  '#00ffff': '🔵',
};

const DEFAULT_EMOJI = '🤖';

/**
 * Maps a frontmatter color value to an emoji.
 *
 * @param color - The color string from frontmatter
 * @returns An emoji representing the color, or the default emoji
 */
export function mapColorToEmoji(color: string | undefined): string {
  if (!color) return DEFAULT_EMOJI;
  return COLOR_TO_EMOJI[color.toLowerCase().trim()] ?? DEFAULT_EMOJI;
}
