/**
 * Auto-increment patch version on every build.
 *
 * Reads package.json, bumps the patch number (0.1.1 → 0.1.2),
 * writes it back. Run automatically as part of `npm run build`.
 *
 * Usage:
 *   node scripts/bump-version.mjs          # bump patch (default)
 *   node scripts/bump-version.mjs minor    # bump minor (0.1.2 → 0.2.0)
 *   node scripts/bump-version.mjs major    # bump major (0.2.0 → 1.0.0)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const bumpType = process.argv[2] || 'patch';

let newVersion;
switch (bumpType) {
  case 'major':
    newVersion = `${major + 1}.0.0`;
    break;
  case 'minor':
    newVersion = `${major}.${minor + 1}.0`;
    break;
  case 'patch':
  default:
    newVersion = `${major}.${minor}.${patch + 1}`;
    break;
}

pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`Version bumped: ${major}.${minor}.${patch} → ${newVersion}`);
