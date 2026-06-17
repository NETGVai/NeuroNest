/**
 * Project Templates Module
 *
 * Provides a registry of project templates and scaffolding functionality.
 * Templates are defined inline as code — no separate subdirectories needed.
 *
 * Validates: Requirements 18.1, 18.2, 18.3, 18.4
 */
import * as fs from 'fs/promises';
import * as path from 'path';

// ─── Template Types ──────────────────────────────────────────

export interface TemplateFile {
  /** Relative path within the project directory */
  relativePath: string;
  /** File content */
  content: string;
}

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  files: TemplateFile[];
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
}

// ─── Template Definitions ────────────────────────────────────

const reactTemplate: TemplateDefinition = {
  id: 'react',
  name: 'React + TypeScript',
  description: 'Vite + React + TypeScript setup with modern tooling',
  files: [
    {
      relativePath: 'package.json',
      content: JSON.stringify(
        {
          name: 'my-react-app',
          private: true,
          version: '0.1.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'tsc && vite build',
            preview: 'vite preview',
          },
          dependencies: {
            react: '^18.3.1',
            'react-dom': '^18.3.1',
          },
          devDependencies: {
            '@types/react': '^18.3.3',
            '@types/react-dom': '^18.3.0',
            '@vitejs/plugin-react': '^4.3.1',
            typescript: '^5.5.0',
            vite: '^5.4.0',
          },
        },
        null,
        2,
      ),
    },
    {
      relativePath: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            useDefineForClassFields: true,
            lib: ['ES2020', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            skipLibCheck: true,
            moduleResolution: 'bundler',
            allowImportingTsExtensions: true,
            isolatedModules: true,
            moduleDetection: 'force',
            noEmit: true,
            jsx: 'react-jsx',
            strict: true,
            noUnusedLocals: true,
            noUnusedParameters: true,
            noFallthroughCasesInSwitch: true,
          },
          include: ['src'],
        },
        null,
        2,
      ),
    },
    {
      relativePath: 'index.html',
      content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      relativePath: 'src/main.tsx',
      content: `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
    },
    {
      relativePath: 'src/App.tsx',
      content: `import React, { useState } from 'react';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <h1>React + TypeScript</h1>
      <button onClick={() => setCount((c) => c + 1)}>
        Count: {count}
      </button>
    </div>
  );
}

export default App;
`,
    },
    {
      relativePath: 'vite.config.ts',
      content: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
    },
    {
      relativePath: 'README.md',
      content: `# React + TypeScript Project

A modern React application built with Vite and TypeScript.

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

## Project Structure

- \`src/\` — Application source code
  - \`main.tsx\` — Entry point
  - \`App.tsx\` — Root component
- \`index.html\` — HTML template
- \`vite.config.ts\` — Vite configuration
- \`tsconfig.json\` — TypeScript configuration

## Scripts

- \`npm run dev\` — Start development server
- \`npm run build\` — Build for production
- \`npm run preview\` — Preview production build
`,
    },
  ],
};

const nextjsTemplate: TemplateDefinition = {
  id: 'nextjs',
  name: 'Next.js 14 App Router',
  description: 'Next.js 14 App Router + TypeScript project',
  files: [
    {
      relativePath: 'package.json',
      content: JSON.stringify(
        {
          name: 'my-nextjs-app',
          version: '0.1.0',
          private: true,
          scripts: {
            dev: 'next dev',
            build: 'next build',
            start: 'next start',
            lint: 'next lint',
          },
          dependencies: {
            next: '^14.2.0',
            react: '^18.3.1',
            'react-dom': '^18.3.1',
          },
          devDependencies: {
            '@types/node': '^20.0.0',
            '@types/react': '^18.3.3',
            '@types/react-dom': '^18.3.0',
            typescript: '^5.5.0',
          },
        },
        null,
        2,
      ),
    },
    {
      relativePath: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2017',
            lib: ['dom', 'dom.iterable', 'esnext'],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: 'preserve',
            incremental: true,
            plugins: [{ name: 'next' }],
            paths: { '@/*': ['./src/*'] },
          },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
          exclude: ['node_modules'],
        },
        null,
        2,
      ),
    },
    {
      relativePath: 'next.config.mjs',
      content: `/** @type {import('next').NextConfig} */
const nextConfig = {};

export default nextConfig;
`,
    },
    {
      relativePath: 'src/app/layout.tsx',
      content: `import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'My Next.js App',
  description: 'Created with NeuroNest',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
    {
      relativePath: 'src/app/page.tsx',
      content: `export default function Home() {
  return (
    <main>
      <h1>Welcome to Next.js</h1>
      <p>Get started by editing <code>src/app/page.tsx</code></p>
    </main>
  );
}
`,
    },
    {
      relativePath: 'README.md',
      content: `# Next.js 14 App Router Project

A Next.js application using the App Router with TypeScript.

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

## Project Structure

- \`src/app/\` — App Router pages and layouts
  - \`layout.tsx\` — Root layout
  - \`page.tsx\` — Home page
- \`next.config.mjs\` — Next.js configuration
- \`tsconfig.json\` — TypeScript configuration

## Scripts

- \`npm run dev\` — Start development server
- \`npm run build\` — Build for production
- \`npm run start\` — Start production server
- \`npm run lint\` — Run ESLint
`,
    },
  ],
};

const expressApiTemplate: TemplateDefinition = {
  id: 'express-api',
  name: 'Express API',
  description: 'Express + TypeScript REST API with basic routing',
  files: [
    {
      relativePath: 'package.json',
      content: JSON.stringify(
        {
          name: 'my-express-api',
          version: '0.1.0',
          private: true,
          scripts: {
            dev: 'tsx watch src/index.ts',
            build: 'tsc',
            start: 'node dist/index.js',
          },
          dependencies: {
            express: '^4.19.0',
          },
          devDependencies: {
            '@types/express': '^4.17.21',
            '@types/node': '^20.0.0',
            tsx: '^4.16.0',
            typescript: '^5.5.0',
          },
        },
        null,
        2,
      ),
    },
    {
      relativePath: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            module: 'commonjs',
            lib: ['ES2020'],
            outDir: './dist',
            rootDir: './src',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            resolveJsonModule: true,
            declaration: true,
          },
          include: ['src/**/*'],
          exclude: ['node_modules', 'dist'],
        },
        null,
        2,
      ),
    },
    {
      relativePath: 'src/index.ts',
      content: `import express from 'express';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Welcome to the API' });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(\`Server running at http://localhost:\${port}\`);
});

export default app;
`,
    },
    {
      relativePath: 'README.md',
      content: `# Express API Project

A TypeScript REST API built with Express.

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

## Project Structure

- \`src/\` — Application source code
  - \`index.ts\` — Server entry point with basic routes
- \`tsconfig.json\` — TypeScript configuration

## Scripts

- \`npm run dev\` — Start development server with hot-reload
- \`npm run build\` — Compile TypeScript to JavaScript
- \`npm run start\` — Start production server

## API Endpoints

- \`GET /\` — Welcome message
- \`GET /health\` — Health check endpoint
`,
    },
  ],
};

const typescriptBlankTemplate: TemplateDefinition = {
  id: 'typescript-blank',
  name: 'TypeScript Blank',
  description: 'Plain TypeScript project with minimal configuration',
  files: [
    {
      relativePath: 'package.json',
      content: JSON.stringify(
        {
          name: 'my-typescript-project',
          version: '0.1.0',
          private: true,
          scripts: {
            dev: 'tsx watch src/index.ts',
            build: 'tsc',
            start: 'node dist/index.js',
          },
          devDependencies: {
            '@types/node': '^20.0.0',
            tsx: '^4.16.0',
            typescript: '^5.5.0',
          },
        },
        null,
        2,
      ),
    },
    {
      relativePath: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            module: 'commonjs',
            lib: ['ES2020'],
            outDir: './dist',
            rootDir: './src',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            resolveJsonModule: true,
            declaration: true,
          },
          include: ['src/**/*'],
          exclude: ['node_modules', 'dist'],
        },
        null,
        2,
      ),
    },
    {
      relativePath: 'src/index.ts',
      content: `function main(): void {
  console.log('Hello, TypeScript!');
}

main();
`,
    },
    {
      relativePath: 'README.md',
      content: `# TypeScript Project

A minimal TypeScript project ready for development.

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

## Project Structure

- \`src/\` — Source code
  - \`index.ts\` — Entry point
- \`tsconfig.json\` — TypeScript configuration

## Scripts

- \`npm run dev\` — Run with hot-reload (tsx)
- \`npm run build\` — Compile TypeScript
- \`npm run start\` — Run compiled output
`,
    },
  ],
};

// ─── Template Registry ───────────────────────────────────────

const TEMPLATE_REGISTRY: Map<string, TemplateDefinition> = new Map([
  ['react', reactTemplate],
  ['nextjs', nextjsTemplate],
  ['express-api', expressApiTemplate],
  ['typescript-blank', typescriptBlankTemplate],
]);

// ─── Public API ──────────────────────────────────────────────

/**
 * Returns a list of available template IDs with their names and descriptions.
 */
export function listTemplates(): TemplateInfo[] {
  return Array.from(TEMPLATE_REGISTRY.values()).map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));
}

/**
 * Returns a template definition by ID, or undefined if not found.
 */
export function getTemplate(templateId: string): TemplateDefinition | undefined {
  return TEMPLATE_REGISTRY.get(templateId);
}

/**
 * Scaffolds a project from a template into the specified directory.
 *
 * Creates the project directory structure and writes all template files
 * (package.json, tsconfig.json, README.md, starter code).
 *
 * Does NOT run `npm install` — that is the caller's responsibility
 * (typically submitted via BashTool with user approval).
 *
 * @param templateId - The template identifier (e.g., 'react', 'nextjs')
 * @param projectDir - The target directory to scaffold into
 * @throws Error if templateId is not found in the registry
 * @throws Error if projectDir already contains files (non-empty directory)
 */
export async function scaffoldProject(templateId: string, projectDir: string): Promise<void> {
  const template = TEMPLATE_REGISTRY.get(templateId);
  if (!template) {
    const available = Array.from(TEMPLATE_REGISTRY.keys()).join(', ');
    throw new Error(
      `Unknown template "${templateId}". Available templates: ${available}`,
    );
  }

  // Ensure the project directory exists
  await fs.mkdir(projectDir, { recursive: true });

  // Write each template file
  for (const file of template.files) {
    const filePath = path.join(projectDir, file.relativePath);
    const fileDir = path.dirname(filePath);

    // Create parent directories if needed
    await fs.mkdir(fileDir, { recursive: true });

    // Write file content
    await fs.writeFile(filePath, file.content, 'utf-8');
  }
}
