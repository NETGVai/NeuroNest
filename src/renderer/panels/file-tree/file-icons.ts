/**
 * File Icons Module — Maps file extensions and names to appropriate icons/emojis
 * for display in the file tree panel.
 *
 * Requirements: 23.6
 */

/** Map of file extensions to icon emoji/characters. */
const EXTENSION_ICON_MAP: Record<string, string> = {
  // TypeScript / JavaScript
  ts: '\uD83D\uDCD8',      // 📘
  tsx: '\u269B',            // ⚛
  js: '\uD83D\uDCD2',      // 📒
  jsx: '\u269B',            // ⚛
  mjs: '\uD83D\uDCD2',     // 📒
  cjs: '\uD83D\uDCD2',     // 📒
  // Styles
  css: '\uD83C\uDFA8',     // 🎨
  scss: '\uD83C\uDFA8',    // 🎨
  sass: '\uD83C\uDFA8',    // 🎨
  less: '\uD83C\uDFA8',    // 🎨
  // Markup
  html: '\uD83C\uDF10',    // 🌐
  htm: '\uD83C\uDF10',     // 🌐
  xml: '\uD83D\uDCC4',     // 📄
  svg: '\uD83D\uDDBC',     // 🖼
  // Data / Config
  json: '\u2699',           // ⚙
  yaml: '\u2699',           // ⚙
  yml: '\u2699',            // ⚙
  toml: '\u2699',           // ⚙
  ini: '\u2699',            // ⚙
  env: '\uD83D\uDD12',     // 🔒
  // Documentation
  md: '\uD83D\uDCC3',      // 📃
  markdown: '\uD83D\uDCC3',// 📃
  txt: '\uD83D\uDCC4',     // 📄
  rst: '\uD83D\uDCC3',     // 📃
  // Python
  py: '\uD83D\uDC0D',      // 🐍
  pyx: '\uD83D\uDC0D',     // 🐍
  pyi: '\uD83D\uDC0D',     // 🐍
  // Rust
  rs: '\uD83E\uDD80',      // 🦀
  // Go
  go: '\uD83D\uDC39',      // 🐹
  // Ruby
  rb: '\uD83D\uDC8E',      // 💎
  // Shell
  sh: '\uD83D\uDCBB',      // 💻
  bash: '\uD83D\uDCBB',    // 💻
  zsh: '\uD83D\uDCBB',     // 💻
  fish: '\uD83D\uDCBB',    // 💻
  // Java / Kotlin
  java: '\u2615',           // ☕
  kt: '\uD83D\uDCE6',      // 📦
  kts: '\uD83D\uDCE6',     // 📦
  // C / C++
  c: '\uD83D\uDD27',       // 🔧
  h: '\uD83D\uDD27',       // 🔧
  cpp: '\uD83D\uDD27',     // 🔧
  hpp: '\uD83D\uDD27',     // 🔧
  // Swift
  swift: '\uD83E\uDD85',   // 🦅
  // Docker
  dockerfile: '\uD83D\uDC33', // 🐳
  // Database
  sql: '\uD83D\uDDC3',     // 🗃
  db: '\uD83D\uDDC3',      // 🗃
  sqlite: '\uD83D\uDDC3',  // 🗃
  // Images
  png: '\uD83D\uDDBC',     // 🖼
  jpg: '\uD83D\uDDBC',     // 🖼
  jpeg: '\uD83D\uDDBC',    // 🖼
  gif: '\uD83D\uDDBC',     // 🖼
  webp: '\uD83D\uDDBC',    // 🖼
  ico: '\uD83D\uDDBC',     // 🖼
  // Lock / Package
  lock: '\uD83D\uDD12',    // 🔒
  // Testing
  test: '\uD83E\uDDEA',    // 🧪
  spec: '\uD83E\uDDEA',    // 🧪
  // Build
  wasm: '\u2699',           // ⚙
};

/** Map of specific file names to icon emoji/characters. */
const FILENAME_ICON_MAP: Record<string, string> = {
  'package.json': '\uD83D\uDCE6',     // 📦
  'package-lock.json': '\uD83D\uDD12',// 🔒
  'yarn.lock': '\uD83D\uDD12',        // 🔒
  'pnpm-lock.yaml': '\uD83D\uDD12',   // 🔒
  'tsconfig.json': '\uD83D\uDCD8',    // 📘
  'vite.config.ts': '\u26A1',          // ⚡
  'vite.config.js': '\u26A1',          // ⚡
  'webpack.config.js': '\uD83D\uDCE6',// 📦
  'rollup.config.js': '\uD83D\uDCE6', // 📦
  '.gitignore': '\uD83D\uDEAB',       // 🚫
  '.eslintrc': '\uD83D\uDCCF',        // 📏
  '.eslintrc.js': '\uD83D\uDCCF',     // 📏
  '.eslintrc.json': '\uD83D\uDCCF',   // 📏
  'eslint.config.mjs': '\uD83D\uDCCF',// 📏
  '.prettierrc': '\uD83D\uDCCF',      // 📏
  '.prettierrc.json': '\uD83D\uDCCF', // 📏
  'Dockerfile': '\uD83D\uDC33',       // 🐳
  'docker-compose.yml': '\uD83D\uDC33',// 🐳
  'docker-compose.yaml': '\uD83D\uDC33',// 🐳
  'Makefile': '\uD83D\uDD28',         // 🔨
  'CMakeLists.txt': '\uD83D\uDD28',   // 🔨
  'Cargo.toml': '\uD83E\uDD80',       // 🦀
  'Cargo.lock': '\uD83D\uDD12',       // 🔒
  'go.mod': '\uD83D\uDC39',           // 🐹
  'go.sum': '\uD83D\uDD12',           // 🔒
  'Gemfile': '\uD83D\uDC8E',          // 💎
  'Gemfile.lock': '\uD83D\uDD12',     // 🔒
  'requirements.txt': '\uD83D\uDC0D', // 🐍
  'setup.py': '\uD83D\uDC0D',         // 🐍
  'pyproject.toml': '\uD83D\uDC0D',   // 🐍
  'README.md': '\uD83D\uDCD6',        // 📖
  'LICENSE': '\uD83D\uDCDC',          // 📜
  'CHANGELOG.md': '\uD83D\uDCDD',     // 📝
  '.env': '\uD83D\uDD12',             // 🔒
  '.env.local': '\uD83D\uDD12',       // 🔒
  '.env.production': '\uD83D\uDD12',  // 🔒
  '.env.development': '\uD83D\uDD12', // 🔒
};

/** Default icon for unknown file types. */
const DEFAULT_FILE_ICON = '\uD83D\uDCC4'; // 📄

/** Default icon for folders. */
export const FOLDER_ICON_OPEN = '\uD83D\uDCC2';   // 📂
export const FOLDER_ICON_CLOSED = '\uD83D\uDCC1'; // 📁

/**
 * Get the appropriate icon for a file given its name.
 * Checks filename-specific mappings first, then extension-based mappings.
 *
 * @param filename - The file name (not full path), e.g., "index.ts"
 * @returns An emoji/character representing the file type
 */
export function getFileIcon(filename: string): string {
  // Check exact filename match first
  const lower = filename.toLowerCase();
  if (FILENAME_ICON_MAP[filename]) {
    return FILENAME_ICON_MAP[filename];
  }
  if (FILENAME_ICON_MAP[lower]) {
    return FILENAME_ICON_MAP[lower];
  }

  // Check for test/spec files (e.g., foo.test.ts, bar.spec.js)
  const parts = lower.split('.');
  if (parts.length >= 3) {
    const secondToLast = parts[parts.length - 2];
    if (secondToLast === 'test' || secondToLast === 'spec') {
      return '\uD83E\uDDEA'; // 🧪
    }
  }

  // Check extension
  const ext = parts.length > 1 ? parts[parts.length - 1] : '';
  if (ext && EXTENSION_ICON_MAP[ext]) {
    return EXTENSION_ICON_MAP[ext];
  }

  return DEFAULT_FILE_ICON;
}

/**
 * Get the folder icon based on expanded/collapsed state.
 *
 * @param expanded - Whether the folder is currently expanded
 * @returns An emoji/character representing the folder state
 */
export function getFolderIcon(expanded: boolean): string {
  return expanded ? FOLDER_ICON_OPEN : FOLDER_ICON_CLOSED;
}
