/**
 * Local avatar generator — creates unique SVG robot avatars from any text input.
 * Implemented entirely in Node.js with no external dependencies or web services.
 *
 * Uses a SHA-256 hash of the input string to deterministically select colors,
 * body shapes, eyes, mouth, accessories, and background patterns.
 * The same input always produces the same avatar.
 */

import { createHash } from 'node:crypto';

// Color palettes derived from hash bytes
const BODY_COLORS = [
  '#4FC3F7', '#81C784', '#FFB74D', '#E57373', '#BA68C8',
  '#4DD0E1', '#AED581', '#FFD54F', '#F06292', '#7986CB',
  '#26C6DA', '#66BB6A', '#FFA726', '#EF5350', '#AB47BC',
  '#29B6F6', '#9CCC65', '#FFCA28', '#EC407A', '#5C6BC0',
];

const ACCENT_COLORS = [
  '#0288D1', '#388E3C', '#F57C00', '#D32F2F', '#7B1FA2',
  '#00838F', '#558B2F', '#FF8F00', '#C2185B', '#303F9F',
  '#0277BD', '#2E7D32', '#EF6C00', '#C62828', '#6A1B9A',
  '#00695C', '#33691E', '#E65100', '#AD1457', '#283593',
];

const BG_COLORS = [
  '#1a1a2e', '#16213e', '#0f3460', '#1b1b2f', '#162447',
  '#1f1f38', '#1a1a3e', '#0d1b2a', '#1b2838', '#1c1c3c',
  '#2d132c', '#1e1e30', '#0e1428', '#1a2332', '#1b1b35',
  '#1f2b3d', '#0f1923', '#1c2333', '#1a1f36', '#1e2a3a',
];

interface HashBytes {
  bytes: number[];
  at(i: number): number;
}

function hashInput(input: string): HashBytes {
  const hash = createHash('sha256').update(input).digest();
  const bytes = Array.from(hash);
  return {
    bytes,
    at(i: number) { return bytes[i % bytes.length]; },
  };
}

function pickFromArray<T>(arr: T[], byte: number): T {
  return arr[byte % arr.length];
}


// SVG shape generators — each uses hash bytes for variation

function generateBody(h: HashBytes, color: string, accent: string): string {
  const bodyType = h.at(4) % 4;
  const w = 200, cx = 100;

  switch (bodyType) {
    case 0: // Rounded rectangle body
      return `<rect x="45" y="70" width="110" height="90" rx="16" fill="${color}" stroke="${accent}" stroke-width="2"/>`;
    case 1: // Trapezoid body
      return `<polygon points="35,160 55,70 145,70 165,160" fill="${color}" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>`;
    case 2: // Oval body
      return `<ellipse cx="${cx}" cy="115" rx="60" ry="48" fill="${color}" stroke="${accent}" stroke-width="2"/>`;
    default: // Hexagonal body
      return `<polygon points="60,75 140,75 160,115 140,155 60,155 40,115" fill="${color}" stroke="${accent}" stroke-width="2"/>`;
  }
}

function generateHead(h: HashBytes, color: string, accent: string): string {
  const headType = h.at(5) % 4;
  const cx = 100;

  switch (headType) {
    case 0: // Round head
      return `<circle cx="${cx}" cy="42" r="32" fill="${color}" stroke="${accent}" stroke-width="2"/>`;
    case 1: // Square head with rounded corners
      return `<rect x="65" y="10" width="70" height="64" rx="10" fill="${color}" stroke="${accent}" stroke-width="2"/>`;
    case 2: // Dome head
      return `<path d="M68,74 L68,40 Q68,10 100,10 Q132,10 132,40 L132,74 Z" fill="${color}" stroke="${accent}" stroke-width="2"/>`;
    default: // Diamond head
      return `<polygon points="100,8 138,42 100,76 62,42" fill="${color}" stroke="${accent}" stroke-width="2"/>`;
  }
}

function generateEyes(h: HashBytes, accent: string): string {
  const eyeType = h.at(6) % 5;
  const eyeSpacing = 14 + (h.at(7) % 8);
  const lx = 100 - eyeSpacing, rx = 100 + eyeSpacing;
  const ey = 38 + (h.at(8) % 8);

  switch (eyeType) {
    case 0: // Circle eyes
      return `<circle cx="${lx}" cy="${ey}" r="6" fill="#fff"/><circle cx="${rx}" cy="${ey}" r="6" fill="#fff"/>` +
        `<circle cx="${lx}" cy="${ey}" r="3" fill="#111"/><circle cx="${rx}" cy="${ey}" r="3" fill="#111"/>`;
    case 1: // Glowing eyes
      return `<circle cx="${lx}" cy="${ey}" r="7" fill="${accent}" opacity="0.3"/><circle cx="${rx}" cy="${ey}" r="7" fill="${accent}" opacity="0.3"/>` +
        `<circle cx="${lx}" cy="${ey}" r="4" fill="#fff"/><circle cx="${rx}" cy="${ey}" r="4" fill="#fff"/>`;
    case 2: // Visor
      return `<rect x="${lx - 18}" y="${ey - 5}" width="${(rx - lx) + 36}" height="10" rx="5" fill="rgba(255,255,255,0.15)" stroke="${accent}" stroke-width="1.5"/>` +
        `<circle cx="${lx}" cy="${ey}" r="3.5" fill="#fff"/><circle cx="${rx}" cy="${ey}" r="3.5" fill="#fff"/>`;
    case 3: // Square eyes
      return `<rect x="${lx - 5}" y="${ey - 5}" width="10" height="10" rx="2" fill="#fff"/><rect x="${rx - 5}" y="${ey - 5}" width="10" height="10" rx="2" fill="#fff"/>` +
        `<rect x="${lx - 2}" y="${ey - 2}" width="4" height="4" fill="#111"/><rect x="${rx - 2}" y="${ey - 2}" width="4" height="4" fill="#111"/>`;
    default: // Dot eyes
      return `<circle cx="${lx}" cy="${ey}" r="4" fill="#fff"/><circle cx="${rx}" cy="${ey}" r="4" fill="#fff"/>`;
  }
}

function generateMouth(h: HashBytes, accent: string): string {
  const mouthType = h.at(9) % 5;
  const my = 52 + (h.at(10) % 6);

  switch (mouthType) {
    case 0: // Smile
      return `<path d="M88,${my} Q100,${my + 10} 112,${my}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`;
    case 1: // Line
      return `<line x1="88" y1="${my}" x2="112" y2="${my}" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`;
    case 2: // Grid/speaker
      return `<rect x="88" y="${my - 4}" width="24" height="8" rx="2" fill="rgba(255,255,255,0.2)" stroke="${accent}" stroke-width="1"/>` +
        `<line x1="94" y1="${my - 4}" x2="94" y2="${my + 4}" stroke="${accent}" stroke-width="0.5"/>` +
        `<line x1="100" y1="${my - 4}" x2="100" y2="${my + 4}" stroke="${accent}" stroke-width="0.5"/>` +
        `<line x1="106" y1="${my - 4}" x2="106" y2="${my + 4}" stroke="${accent}" stroke-width="0.5"/>`;
    case 3: // Zigzag
      return `<polyline points="86,${my} 92,${my - 3} 98,${my + 3} 104,${my - 3} 110,${my + 3} 114,${my}" fill="none" stroke="#fff" stroke-width="1.5"/>`;
    default: // Open mouth
      return `<ellipse cx="100" cy="${my}" rx="8" ry="4" fill="rgba(0,0,0,0.4)" stroke="#fff" stroke-width="1"/>`;
  }
}

function generateAntenna(h: HashBytes, accent: string): string {
  const antennaType = h.at(11) % 4;
  if (antennaType === 0) return ''; // No antenna

  switch (antennaType) {
    case 1: // Single antenna
      return `<line x1="100" y1="10" x2="100" y2="-8" stroke="${accent}" stroke-width="2"/><circle cx="100" cy="-10" r="4" fill="${accent}"/>`;
    case 2: // Double antenna
      return `<line x1="85" y1="12" x2="78" y2="-5" stroke="${accent}" stroke-width="1.5"/><circle cx="78" cy="-7" r="3" fill="${accent}"/>` +
        `<line x1="115" y1="12" x2="122" y2="-5" stroke="${accent}" stroke-width="1.5"/><circle cx="122" cy="-7" r="3" fill="${accent}"/>`;
    default: // Lightning bolt antenna
      return `<polyline points="100,10 97,-2 103,-2 100,-12" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round"/>`;
  }
}

function generateArms(h: HashBytes, accent: string): string {
  const armType = h.at(12) % 4;

  switch (armType) {
    case 0: // Straight arms
      return `<line x1="45" y1="90" x2="20" y2="110" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>` +
        `<line x1="155" y1="90" x2="180" y2="110" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>`;
    case 1: // Bent arms
      return `<polyline points="45,85 25,100 30,125" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<polyline points="155,85 175,100 170,125" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 2: // Claw arms
      return `<line x1="45" y1="95" x2="18" y2="105" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>` +
        `<line x1="18" y1="105" x2="12" y2="98" stroke="${accent}" stroke-width="2"/><line x1="18" y1="105" x2="12" y2="112" stroke="${accent}" stroke-width="2"/>` +
        `<line x1="155" y1="95" x2="182" y2="105" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>` +
        `<line x1="182" y1="105" x2="188" y2="98" stroke="${accent}" stroke-width="2"/><line x1="182" y1="105" x2="188" y2="112" stroke="${accent}" stroke-width="2"/>`;
    default: // No arms
      return '';
  }
}

function generateLegs(h: HashBytes, color: string, accent: string): string {
  const legType = h.at(13) % 4;

  switch (legType) {
    case 0: // Straight legs
      return `<rect x="78" y="155" width="14" height="28" rx="4" fill="${color}" stroke="${accent}" stroke-width="1.5"/>` +
        `<rect x="108" y="155" width="14" height="28" rx="4" fill="${color}" stroke="${accent}" stroke-width="1.5"/>`;
    case 1: // Wheel base
      return `<rect x="55" y="155" width="90" height="12" rx="6" fill="${accent}"/>` +
        `<circle cx="72" cy="175" r="8" fill="${color}" stroke="${accent}" stroke-width="2"/>` +
        `<circle cx="128" cy="175" r="8" fill="${color}" stroke="${accent}" stroke-width="2"/>`;
    case 2: // Treads
      return `<rect x="60" y="155" width="80" height="18" rx="9" fill="${accent}" opacity="0.6"/>` +
        `<rect x="65" y="158" width="70" height="12" rx="6" fill="${color}"/>`;
    default: // Single pedestal
      return `<rect x="88" y="155" width="24" height="8" rx="3" fill="${accent}"/>` +
        `<rect x="78" y="163" width="44" height="10" rx="5" fill="${color}" stroke="${accent}" stroke-width="1.5"/>`;
  }
}

function generateDecoration(h: HashBytes, accent: string): string {
  const decoType = h.at(14) % 5;

  switch (decoType) {
    case 0: // Chest light
      return `<circle cx="100" cy="110" r="6" fill="${accent}" opacity="0.6"/><circle cx="100" cy="110" r="3" fill="#fff" opacity="0.8"/>`;
    case 1: // Chest panel
      return `<rect x="80" y="95" width="40" height="25" rx="4" fill="rgba(255,255,255,0.08)" stroke="${accent}" stroke-width="1"/>` +
        `<line x1="80" y1="105" x2="120" y2="105" stroke="${accent}" stroke-width="0.5" opacity="0.5"/>` +
        `<line x1="80" y1="112" x2="120" y2="112" stroke="${accent}" stroke-width="0.5" opacity="0.5"/>`;
    case 2: // Bolts
      return `<circle cx="60" cy="100" r="3" fill="${accent}" opacity="0.5"/><circle cx="140" cy="100" r="3" fill="${accent}" opacity="0.5"/>` +
        `<circle cx="60" cy="130" r="3" fill="${accent}" opacity="0.5"/><circle cx="140" cy="130" r="3" fill="${accent}" opacity="0.5"/>`;
    case 3: // Badge
      return `<polygon points="100,92 106,104 120,106 110,116 112,130 100,124 88,130 90,116 80,106 94,104" fill="${accent}" opacity="0.3"/>`;
    default:
      return '';
  }
}

function generateBackground(h: HashBytes, bgColor: string): string {
  const bgType = h.at(15) % 4;
  const patternOpacity = 0.06;

  let pattern = '';
  switch (bgType) {
    case 0: // Grid
      for (let i = 0; i < 200; i += 20) {
        pattern += `<line x1="${i}" y1="0" x2="${i}" y2="200" stroke="#fff" stroke-width="0.5" opacity="${patternOpacity}"/>`;
        pattern += `<line x1="0" y1="${i}" x2="200" y2="${i}" stroke="#fff" stroke-width="0.5" opacity="${patternOpacity}"/>`;
      }
      break;
    case 1: // Circles
      pattern += `<circle cx="30" cy="30" r="40" fill="none" stroke="#fff" stroke-width="0.5" opacity="${patternOpacity}"/>`;
      pattern += `<circle cx="170" cy="170" r="50" fill="none" stroke="#fff" stroke-width="0.5" opacity="${patternOpacity}"/>`;
      pattern += `<circle cx="160" cy="40" r="30" fill="none" stroke="#fff" stroke-width="0.5" opacity="${patternOpacity}"/>`;
      break;
    case 2: // Dots
      for (let x = 10; x < 200; x += 20) {
        for (let y = 10; y < 200; y += 20) {
          pattern += `<circle cx="${x}" cy="${y}" r="1" fill="#fff" opacity="${patternOpacity * 2}"/>`;
        }
      }
      break;
    default: // Plain
      break;
  }

  return `<rect width="200" height="200" fill="${bgColor}" rx="16"/>` + pattern;
}

/**
 * Generate a unique SVG avatar from an input string.
 * Returns the SVG as a string.
 */
export function generateAvatar(input: string): string {
  const h = hashInput(input);

  const bodyColor = pickFromArray(BODY_COLORS, h.at(0));
  const accentColor = pickFromArray(ACCENT_COLORS, h.at(1));
  const bgColor = pickFromArray(BG_COLORS, h.at(2));

  const bg = generateBackground(h, bgColor);
  const body = generateBody(h, bodyColor, accentColor);
  const head = generateHead(h, bodyColor, accentColor);
  const eyes = generateEyes(h, accentColor);
  const mouth = generateMouth(h, accentColor);
  const antenna = generateAntenna(h, accentColor);
  const arms = generateArms(h, accentColor);
  const legs = generateLegs(h, bodyColor, accentColor);
  const deco = generateDecoration(h, accentColor);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
${bg}
<g transform="translate(0,8)">
${legs}
${body}
${arms}
${deco}
${head}
${antenna}
${eyes}
${mouth}
</g>
</svg>`;

  return svg;
}

/**
 * Generate a data URI for the avatar (for use in <img src="...">).
 */
export function generateAvatarDataUri(input: string): string {
  const svg = generateAvatar(input);
  const encoded = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${encoded}`;
}
