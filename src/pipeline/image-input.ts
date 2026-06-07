/**
 * Image Input — Accept images (screenshots, mockups, wireframes) in chat.
 *
 * Converts images to base64 for LLM vision APIs.
 * Supports: PNG, JPG, GIF, WebP, SVG
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ImageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  base64: string;
  width?: number;
  height?: number;
  sizeBytes: number;
}

const SUPPORTED_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Process an image file for LLM input.
 */
export function processImageFile(filePath: string): ImageAttachment | { error: string } {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = SUPPORTED_TYPES[ext];
  if (!mimeType) {
    return { error: `Unsupported image type: ${ext}. Supported: ${Object.keys(SUPPORTED_TYPES).join(', ')}` };
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SIZE) {
      return { error: `Image too large: ${Math.round(stat.size / 1024 / 1024)}MB. Max: 20MB` };
    }

    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');

    return {
      id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      fileName: path.basename(filePath),
      mimeType,
      base64,
      sizeBytes: stat.size,
    };
  } catch (e: any) {
    return { error: `Failed to read image: ${e.message}` };
  }
}

/**
 * Process a base64 data URL (from clipboard paste or drag-drop).
 */
export function processBase64Image(dataUrl: string, fileName?: string): ImageAttachment | { error: string } {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) {
    return { error: 'Invalid data URL format' };
  }

  const mimeType = match[1];
  const base64 = match[2];
  const sizeBytes = Math.ceil(base64.length * 3 / 4);

  if (sizeBytes > MAX_SIZE) {
    return { error: `Image too large: ${Math.round(sizeBytes / 1024 / 1024)}MB. Max: 20MB` };
  }

  return {
    id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    fileName: fileName || `image_${Date.now()}.png`,
    mimeType,
    base64,
    sizeBytes,
  };
}

/**
 * Build the LLM message content with image for vision APIs.
 */
export function buildVisionMessage(text: string, images: ImageAttachment[]): Array<{ type: string; text?: string; image_url?: { url: string } }> {
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  if (text) {
    content.push({ type: 'text', text });
  }

  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    });
  }

  return content;
}

/**
 * Check if a provider/model supports vision.
 */
export function supportsVision(providerType: string, model?: string): boolean {
  const visionProviders = ['openai', 'anthropic', 'gemini', 'grok'];
  if (visionProviders.includes(providerType)) return true;
  if (model && /vision|4o|gpt-4|claude-3|gemini/i.test(model)) return true;
  return false;
}
