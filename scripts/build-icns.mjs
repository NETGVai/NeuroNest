#!/usr/bin/env node
/**
 * Generate build/icon.icns from assets/icon.png using sharp + macOS iconutil.
 * Creates all required icon sizes for a proper macOS .icns file.
 */
import sharp from 'sharp';
import { mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcIcon = join(root, 'assets', 'icon.png');
const iconsetDir = join(root, 'build', 'NeuroNest.iconset');
const outIcns = join(root, 'build', 'icon.icns');

// macOS iconset requires these exact filenames and sizes
const sizes = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 },
];

mkdirSync(iconsetDir, { recursive: true });
mkdirSync(join(root, 'build'), { recursive: true });

// Generate each size from the source PNG
for (const { name, size } of sizes) {
  await sharp(srcIcon)
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toFile(join(iconsetDir, name));
}

// Convert iconset to icns using macOS iconutil
execSync(`iconutil -c icns -o "${outIcns}" "${iconsetDir}"`);

// Clean up the iconset directory
rmSync(iconsetDir, { recursive: true });

console.log(`Generated ${outIcns}`);
