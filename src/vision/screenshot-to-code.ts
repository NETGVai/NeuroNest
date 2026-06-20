/**
 * Screenshot-to-Code Generation Flow
 *
 * Orchestrates the full pipeline:
 *   1. VisionAnalyzerService.analyzeScreenshot() → detect UI components
 *   2. Construct structured prompt from component data
 *   3. Call LLM with analysis + code generation instructions
 *   4. Store result as a code-bundle artifact via ArtifactService
 *   5. Return generated code + artifact reference
 *
 * Supports output formats:
 *   - 'html-css': Semantic HTML + CSS
 *   - 'react': React JSX component
 *   - 'tailwind': HTML/React with Tailwind CSS classes
 *
 * Includes semantic HTML elements and ARIA attributes for accessibility.
 * Falls back to multimodal LLM when ONNX model is unavailable (Req 7.5).
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type { DetectedComponent, VisualAnalysisResult } from '../shared/feature-integration-types.js';
import { FeatureError } from '../shared/feature-integration-errors.js';
import type { VisionAnalyzerService } from './vision-analyzer-service.js';
import type { ArtifactService } from '../artifacts/artifact-service.js';

// ─── Interfaces ─────────────────────────────────────────────────

export type CodeOutputFormat = 'html-css' | 'react' | 'tailwind';

export interface ScreenshotToCodeOptions {
  format: CodeOutputFormat;
  sessionId: string;
  projectDir: string;
}

export interface ScreenshotToCodeResult {
  code: string;
  artifactId: string;
  format: string;
  components: DetectedComponent[];
}

/**
 * Interface for a multimodal LLM provider that can handle both text and images.
 * Used as fallback when ONNX model is unavailable, and as the code generation backend.
 */
export interface LLMProvider {
  /**
   * Generate a text completion from a prompt.
   */
  generateText(prompt: string): Promise<string>;

  /**
   * Generate a text completion from an image + text prompt (multimodal).
   * Used as fallback when ONNX vision model is unavailable.
   */
  generateFromImage(image: Buffer, prompt: string): Promise<string>;
}

// ─── Prompt Construction ────────────────────────────────────────

/**
 * Build a structured prompt for LLM code generation from detected components.
 */
export function buildCodeGenerationPrompt(
  components: DetectedComponent[],
  imageSize: { width: number; height: number },
  format: CodeOutputFormat,
): string {
  const componentList = components
    .map((c, i) => {
      const { type, boundingBox, confidence, label } = c;
      return `  ${i + 1}. type="${type}" bounds=(${boundingBox.x}, ${boundingBox.y}, ${boundingBox.width}x${boundingBox.height}) confidence=${confidence.toFixed(2)}${label ? ` label="${label}"` : ''}`;
    })
    .join('\n');

  const formatInstructions = getFormatInstructions(format);

  return `You are a UI code generator. Given the following detected UI components from a screenshot analysis, generate clean, production-ready code that recreates this layout.

## Image Dimensions
Width: ${imageSize.width}px, Height: ${imageSize.height}px

## Detected Components
${componentList}

## Output Format
${formatInstructions}

## Accessibility Requirements
- Use semantic HTML elements: <header>, <nav>, <main>, <section>, <article>, <footer>, <aside>
- Include ARIA attributes: aria-label, role, aria-describedby where appropriate
- Ensure proper heading hierarchy (h1 → h2 → h3)
- Add alt text placeholders for images
- Use landmark roles for major sections

## Instructions
1. Arrange components according to their bounding box positions (top-to-bottom, left-to-right)
2. Group related components into semantic containers
3. Use appropriate spacing and sizing based on the bounding box dimensions relative to the image size
4. Generate only the code — no explanations or markdown fences`;
}

/**
 * Get format-specific instructions for code generation.
 */
function getFormatInstructions(format: CodeOutputFormat): string {
  switch (format) {
    case 'html-css':
      return `Generate semantic HTML5 with a companion <style> block.
- Use CSS Grid or Flexbox for layout
- Use relative units (rem, %, vh/vw) for responsive sizing
- Include a CSS reset at the top
- Use BEM-style class naming`;

    case 'react':
      return `Generate a React functional component in JSX.
- Export a default component named "GeneratedPage"
- Use inline styles via a styles object or CSS modules pattern
- Include proper TypeScript-compatible prop types as JSDoc comments
- Use React.Fragment where appropriate to avoid unnecessary wrapper divs`;

    case 'tailwind':
      return `Generate HTML/JSX using Tailwind CSS utility classes.
- Use Tailwind's responsive prefixes (sm:, md:, lg:) for responsive layout
- Use Tailwind's spacing scale for consistent sizing
- Use semantic HTML elements with Tailwind classes
- Group related utilities logically (layout, spacing, typography, colors)`;
  }
}

/**
 * Build a multimodal fallback prompt for when ONNX model is unavailable.
 * Sends the raw image to an LLM that supports vision input.
 */
export function buildMultimodalFallbackPrompt(format: CodeOutputFormat): string {
  const formatInstructions = getFormatInstructions(format);

  return `You are a UI code generator. Analyze the provided screenshot image and generate code that recreates the visible UI layout.

## Output Format
${formatInstructions}

## Accessibility Requirements
- Use semantic HTML elements: <header>, <nav>, <main>, <section>, <article>, <footer>, <aside>
- Include ARIA attributes: aria-label, role, aria-describedby where appropriate
- Ensure proper heading hierarchy (h1 → h2 → h3)
- Add alt text placeholders for images
- Use landmark roles for major sections

## Instructions
1. Identify all visible UI components (buttons, inputs, text, images, navigation, cards)
2. Determine the layout structure (grid, flex, columns)
3. Generate production-ready code matching the visual layout
4. Include appropriate colors, spacing, and typography
5. Generate only the code — no explanations or markdown fences`;
}

// ─── Code Template Wrappers ─────────────────────────────────────

/**
 * Wrap raw generated code in a proper template based on format.
 * Ensures semantic HTML and ARIA attributes are present.
 */
export function wrapInTemplate(code: string, format: CodeOutputFormat): string {
  // If the code already contains a full document structure, return as-is
  if (format === 'html-css' && !code.includes('<!DOCTYPE')) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Generated UI</title>
</head>
<body>
  <main role="main" aria-label="Generated content">
${indentCode(code, 4)}
  </main>
</body>
</html>`;
  }

  if (format === 'react' && !code.includes('export')) {
    return `import React from 'react';

/**
 * Auto-generated React component from screenshot analysis.
 * Includes semantic HTML and ARIA attributes for accessibility.
 */
export default function GeneratedPage() {
  return (
    <main role="main" aria-label="Generated content">
${indentCode(code, 6)}
    </main>
  );
}
`;
  }

  if (format === 'tailwind' && !code.includes('<!DOCTYPE') && !code.includes('export')) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Generated UI</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-gray-50">
  <main role="main" aria-label="Generated content" class="container mx-auto px-4 py-8">
${indentCode(code, 4)}
  </main>
</body>
</html>`;
  }

  return code;
}

/**
 * Indent each line of code by the specified number of spaces.
 */
function indentCode(code: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return code
    .split('\n')
    .map((line) => (line.trim() ? `${indent}${line}` : line))
    .join('\n');
}

// ─── Screenshot-to-Code Service ─────────────────────────────────

export class ScreenshotToCodeService {
  constructor(
    private readonly visionAnalyzer: VisionAnalyzerService,
    private readonly artifactService: ArtifactService,
    private readonly llmProvider: LLMProvider,
  ) {}

  /**
   * Generate code from a screenshot image.
   *
   * Flow:
   *   1. Try VisionAnalyzerService.analyzeScreenshot() to detect UI components
   *   2. If model unavailable (FeatureError with MODEL_UNAVAILABLE): fall back to multimodal LLM
   *   3. From component analysis, construct a prompt for code generation
   *   4. Call LLM with the structured analysis + code generation instructions
   *   5. Store result as a code-bundle artifact via ArtifactService
   *   6. Return the generated code + artifact reference
   *
   * @param image - Raw RGBA pixel buffer of the screenshot
   * @param width - Image width in pixels
   * @param height - Image height in pixels
   * @param options - Output format, session, and project configuration
   * @returns Generated code, artifact ID, format, and detected components
   */
  async generate(
    image: Buffer,
    width: number,
    height: number,
    options: ScreenshotToCodeOptions,
  ): Promise<ScreenshotToCodeResult> {
    const { format, sessionId, projectDir } = options;

    let components: DetectedComponent[] = [];
    let code: string;

    try {
      // Step 1: Attempt ONNX-based vision analysis
      const analysisResult: VisualAnalysisResult = await this.visionAnalyzer.analyzeScreenshot(
        image,
        width,
        height,
      );
      components = analysisResult.components;

      // Step 2: Build a structured prompt from detected components
      const prompt = buildCodeGenerationPrompt(
        components,
        analysisResult.imageSize,
        format,
      );

      // Step 3: Generate code via LLM using the structured analysis
      const rawCode = await this.llmProvider.generateText(prompt);
      code = wrapInTemplate(rawCode, format);
    } catch (err) {
      // Step 2 (fallback): If ONNX model unavailable, fall back to multimodal LLM
      if (err instanceof FeatureError && err.code === 'MODEL_UNAVAILABLE') {
        const fallbackPrompt = buildMultimodalFallbackPrompt(format);
        const rawCode = await this.llmProvider.generateFromImage(image, fallbackPrompt);
        code = wrapInTemplate(rawCode, format);
      } else {
        // Re-throw unexpected errors
        throw err;
      }
    }

    // Step 4: Store the generated code as a code-bundle artifact
    const artifact = await this.artifactService.create({
      sessionId,
      projectDir,
      title: `Screenshot to Code (${format})`,
      type: 'code-bundle',
      content: code,
      metadata: {
        format,
        sourceType: 'screenshot-to-code',
        componentCount: components.length,
        imageWidth: width,
        imageHeight: height,
      },
    });

    // Step 5: Return the result
    return {
      code,
      artifactId: artifact.id,
      format,
      components,
    };
  }
}
