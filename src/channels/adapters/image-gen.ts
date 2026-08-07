// ─── Image Gen Adapter ───────────────────────────────────────────
// Full ChannelAdapter implementation for AI image generation via the
// OpenAI DALL-E API. Supports generating images from text prompts.
// This is a SEND-ONLY adapter — no inbound messages.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 4.6, REQ 10.13

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Image Gen adapter configuration.
 * Requires an OpenAI API key. Optionally specify model and default size.
 */
export const ImageGenConfigSchema = z.object({
  /** OpenAI API key (obtain from https://platform.openai.com/api-keys) */
  apiKey: z.string().min(1),
  /** Model to use for generation (default: dall-e-3) */
  model: z.enum(['dall-e-3', 'dall-e-2']).optional().default('dall-e-3'),
  /** Default image size */
  size: z
    .enum(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'])
    .optional()
    .default('1024x1024'),
  /** Image quality (only applicable to dall-e-3) */
  quality: z.enum(['standard', 'hd']).optional().default('standard'),
  /** Response format: url returns a temporary URL, b64_json returns base64 data */
  responseFormat: z.enum(['url', 'b64_json']).optional().default('url'),
});

export type ImageGenConfig = z.infer<typeof ImageGenConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Parsed generation command */
interface ImageGenCommand {
  /** The text prompt describing the image to generate */
  prompt: string;
  /** Override size for this request */
  size?: '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792';
  /** Override quality for this request */
  quality?: 'standard' | 'hd';
  /** Number of images to generate (1-10 for dall-e-2, always 1 for dall-e-3) */
  n?: number;
}

/** Individual generated image result */
interface GeneratedImage {
  /** Temporary URL to the generated image (when responseFormat is 'url') */
  url?: string;
  /** Base64-encoded image data (when responseFormat is 'b64_json') */
  b64Json?: string;
  /** The revised prompt used by DALL-E 3 (may differ from input) */
  revisedPrompt?: string;
}

/** Full generation result */
interface ImageGenResult {
  prompt: string;
  model: string;
  size: string;
  images: GeneratedImage[];
}

// ─── Image Gen Adapter ───────────────────────────────────────────

export class ImageGenAdapter extends BaseChannelAdapter {
  readonly channelId = 'image-gen';

  readonly capabilities: AdapterCapabilities = {
    direction: 'send-only',
    supportsTyping: false,
    supportsRichMedia: true,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Image Gen',
    emoji: '🎨',
    description: 'AI image generation from text prompts',
    actionTags: ['generate image', 'DALL-E', 'text-to-image'],
    sortOrder: 1050,
  };

  readonly configSchema = ImageGenConfigSchema;

  private config: ImageGenConfig | null = null;

  /** OpenAI API base URL */
  private readonly apiBase = 'https://api.openai.com';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Image Gen adapter requires an OpenAI API key.\n\n' +
        'Setup steps:\n' +
        '1. Sign up at https://platform.openai.com/\n' +
        '2. Create an API key at https://platform.openai.com/api-keys\n' +
        '3. Provide the key in the adapter configuration\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify API access with a models list request
    try {
      const testResult = await this.verifyApiAccess();
      if (!testResult.success) {
        return testResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to OpenAI API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', {
      channelId: 'image-gen',
      model: this.config.model,
      size: this.config.size,
    });

    return {
      success: true,
      message: `Image Gen adapter connected (model: ${this.config.model}, size: ${this.config.size})`,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Image Gen adapter is not connected' };
    }

    // Parse the outbound message content as a generation command
    const command = this.parseCommand(message.content);
    if (!command) {
      return {
        success: false,
        message:
          'Could not parse image generation command. Provide a text prompt or JSON: { "prompt": "...", "size": "1024x1024" }',
      };
    }

    // Execute image generation
    try {
      return await this.generateImage(command);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `Image generation failed: ${errMsg}` };
    }
  }

  // ─── Private: API verification ──────────────────────────────────

  /**
   * Verify API access by fetching the models endpoint.
   * Confirms the API key is valid and has access.
   */
  private async verifyApiAccess(): Promise<ConnectResult> {
    const response = await fetch(`${this.apiBase}/v1/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.config!.apiKey}`,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return this.authFailed(
          'Invalid OpenAI API key. Please verify your key at https://platform.openai.com/api-keys',
        );
      }
      if (response.status === 403) {
        return this.authFailed(
          'API key does not have access to image generation. Check your OpenAI account permissions.',
        );
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `OpenAI API verification failed (${response.status}): ${errorBody}`,
        error: { code: 'PROVIDER_ERROR', message: errorBody },
      };
    }

    return { success: true, message: 'API access verified' };
  }

  // ─── Private: Image Generation ────────────────────────────────

  /**
   * Generate images using the OpenAI Images API.
   * @satisfies REQ 10.13
   */
  private async generateImage(command: ImageGenCommand): Promise<SendResult> {
    if (!command.prompt.trim()) {
      return { success: false, message: 'Image generation prompt cannot be empty.' };
    }

    const model = this.config!.model;
    const size = command.size ?? this.config!.size;
    const quality = command.quality ?? this.config!.quality;

    // DALL-E 3 only supports n=1
    const n = model === 'dall-e-3' ? 1 : Math.min(command.n ?? 1, 10);

    // Validate size compatibility with model
    const validSizes = this.getValidSizes(model);
    if (!validSizes.includes(size)) {
      return {
        success: false,
        message: `Size "${size}" is not supported by ${model}. Valid sizes: ${validSizes.join(', ')}`,
      };
    }

    const body: Record<string, unknown> = {
      model,
      prompt: command.prompt,
      n,
      size,
      response_format: this.config!.responseFormat,
    };

    // Quality is only applicable to dall-e-3
    if (model === 'dall-e-3') {
      body.quality = quality;
    }

    const response = await fetch(`${this.apiBase}/v1/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config!.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage = errorJson.error?.message ?? errorBody;
      } catch {
        errorMessage = errorBody;
      }

      // Handle specific error codes
      if (response.status === 400) {
        return {
          success: false,
          message: `Image generation request rejected: ${errorMessage}`,
        };
      }
      if (response.status === 429) {
        return {
          success: false,
          message: `Rate limited by OpenAI. Please wait before trying again. ${errorMessage}`,
        };
      }

      return {
        success: false,
        message: `Image generation failed (${response.status}): ${errorMessage}`,
      };
    }

    const data = (await response.json()) as {
      data?: Array<OpenAIImageObject>;
    };

    if (!data.data || data.data.length === 0) {
      return { success: false, message: 'No images were generated.' };
    }

    const images: GeneratedImage[] = data.data.map((img) => ({
      url: img.url,
      b64Json: img.b64_json,
      revisedPrompt: img.revised_prompt,
    }));

    const result: ImageGenResult = {
      prompt: command.prompt,
      model,
      size,
      images,
    };

    return {
      success: true,
      message: JSON.stringify(result, null, 2),
    };
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured image generation command.
   * Supports JSON-format commands and plain text prompts:
   * - Plain text: treated as the prompt directly
   * - JSON: { "prompt": "...", "size": "...", "quality": "...", "n": 1 }
   */
  parseCommand(content: string): ImageGenCommand | null {
    const trimmed = content.trim();
    if (!trimmed) return null;

    // Try JSON parsing first
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.prompt === 'string') {
        return {
          prompt: parsed.prompt,
          size: parsed.size,
          quality: parsed.quality,
          n: parsed.n,
        };
      }
    } catch {
      // Not JSON — treat the entire content as a prompt
    }

    // Plain text is treated as the generation prompt
    return { prompt: trimmed };
  }

  // ─── Private: Helpers ─────────────────────────────────────────

  /**
   * Get valid image sizes for a given model.
   */
  private getValidSizes(model: string): string[] {
    if (model === 'dall-e-3') {
      return ['1024x1024', '1792x1024', '1024x1792'];
    }
    // dall-e-2
    return ['256x256', '512x512', '1024x1024'];
  }
}

// ─── OpenAI API types (internal) ────────────────────────────────

/** Simplified OpenAI image response object */
interface OpenAIImageObject {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}
