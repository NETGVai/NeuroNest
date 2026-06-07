/**
 * Project Templates — Scaffold entire projects from templates.
 *
 * Templates define file structures, dependencies, and configuration.
 * The swarm can be used to have different agents handle different parts.
 */

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'web' | 'api' | 'mobile' | 'cli' | 'library' | 'fullstack';
  stack: string[];
  files: Array<{ path: string; content: string }>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  postCreate?: string; // Command to run after scaffolding
}

export const BUILT_IN_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'nextjs-app',
    name: 'Next.js App',
    description: 'Next.js 14 with App Router, TypeScript, and Tailwind CSS',
    icon: '▲',
    category: 'fullstack',
    stack: ['Next.js', 'TypeScript', 'Tailwind CSS'],
    files: [
      { path: 'src/app/layout.tsx', content: 'import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = { title: "My App", description: "Built with NeuroNest" };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n' },
      { path: 'src/app/page.tsx', content: 'export default function Home() {\n  return <main className="flex min-h-screen flex-col items-center justify-center p-24">\n    <h1 className="text-4xl font-bold">Welcome</h1>\n  </main>;\n}\n' },
      { path: 'src/app/globals.css', content: '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' },
      { path: 'tsconfig.json', content: '{\n  "compilerOptions": {\n    "target": "es5",\n    "lib": ["dom", "dom.iterable", "esnext"],\n    "allowJs": true,\n    "skipLibCheck": true,\n    "strict": true,\n    "noEmit": true,\n    "esModuleInterop": true,\n    "module": "esnext",\n    "moduleResolution": "bundler",\n    "resolveJsonModule": true,\n    "isolatedModules": true,\n    "jsx": "preserve",\n    "incremental": true,\n    "paths": { "@/*": ["./src/*"] }\n  },\n  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],\n  "exclude": ["node_modules"]\n}\n' },
    ],
    dependencies: { 'next': '^14.0.0', 'react': '^18.0.0', 'react-dom': '^18.0.0' },
    devDependencies: { 'typescript': '^5.0.0', '@types/react': '^18.0.0', 'tailwindcss': '^3.0.0', 'autoprefixer': '^10.0.0', 'postcss': '^8.0.0' },
    scripts: { 'dev': 'next dev', 'build': 'next build', 'start': 'next start' },
    postCreate: 'npm install',
  },
  {
    id: 'express-api',
    name: 'Express API',
    description: 'Express.js REST API with TypeScript and Zod validation',
    icon: '🚀',
    category: 'api',
    stack: ['Express', 'TypeScript', 'Zod'],
    files: [
      { path: 'src/index.ts', content: 'import express from "express";\n\nconst app = express();\napp.use(express.json());\n\napp.get("/health", (req, res) => res.json({ status: "ok" }));\n\nconst PORT = process.env.PORT || 3000;\napp.listen(PORT, () => console.log(`Server running on port ${PORT}`));\n' },
      { path: 'tsconfig.json', content: '{\n  "compilerOptions": {\n    "target": "ES2020",\n    "module": "commonjs",\n    "outDir": "./dist",\n    "rootDir": "./src",\n    "strict": true,\n    "esModuleInterop": true\n  }\n}\n' },
    ],
    dependencies: { 'express': '^4.18.0', 'zod': '^3.22.0' },
    devDependencies: { 'typescript': '^5.0.0', '@types/express': '^4.17.0', 'tsx': '^4.0.0' },
    scripts: { 'dev': 'tsx watch src/index.ts', 'build': 'tsc', 'start': 'node dist/index.js' },
    postCreate: 'npm install',
  },
  {
    id: 'python-fastapi',
    name: 'FastAPI',
    description: 'Python FastAPI with Pydantic models and SQLAlchemy',
    icon: '🐍',
    category: 'api',
    stack: ['FastAPI', 'Python', 'SQLAlchemy'],
    files: [
      { path: 'main.py', content: 'from fastapi import FastAPI\n\napp = FastAPI(title="My API")\n\n@app.get("/health")\ndef health():\n    return {"status": "ok"}\n' },
      { path: 'requirements.txt', content: 'fastapi>=0.100.0\nuvicorn>=0.23.0\npydantic>=2.0.0\nsqlalchemy>=2.0.0\n' },
    ],
    scripts: { 'dev': 'uvicorn main:app --reload', 'start': 'uvicorn main:app' },
    postCreate: 'pip install -r requirements.txt',
  },
  {
    id: 'react-vite',
    name: 'React + Vite',
    description: 'React 18 with Vite, TypeScript, and CSS Modules',
    icon: '⚛️',
    category: 'web',
    stack: ['React', 'Vite', 'TypeScript'],
    files: [
      { path: 'src/App.tsx', content: 'function App() {\n  return <div><h1>Hello from NeuroNest</h1></div>;\n}\nexport default App;\n' },
      { path: 'src/main.tsx', content: 'import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App";\n\nReactDOM.createRoot(document.getElementById("root")!).render(\n  <React.StrictMode><App /></React.StrictMode>\n);\n' },
      { path: 'index.html', content: '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>My App</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n' },
    ],
    dependencies: { 'react': '^18.0.0', 'react-dom': '^18.0.0' },
    devDependencies: { 'vite': '^5.0.0', '@vitejs/plugin-react': '^4.0.0', 'typescript': '^5.0.0', '@types/react': '^18.0.0', '@types/react-dom': '^18.0.0' },
    scripts: { 'dev': 'vite', 'build': 'vite build', 'preview': 'vite preview' },
    postCreate: 'npm install',
  },
  {
    id: 'cli-tool',
    name: 'CLI Tool',
    description: 'Node.js CLI tool with Commander.js and TypeScript',
    icon: '⌨️',
    category: 'cli',
    stack: ['Node.js', 'Commander.js', 'TypeScript'],
    files: [
      { path: 'src/index.ts', content: 'import { Command } from "commander";\n\nconst program = new Command();\nprogram.name("mycli").description("My CLI tool").version("1.0.0");\n\nprogram.command("hello").description("Say hello").argument("<name>", "Name to greet")\n  .action((name) => console.log(`Hello, ${name}!`));\n\nprogram.parse();\n' },
      { path: 'tsconfig.json', content: '{\n  "compilerOptions": { "target": "ES2020", "module": "commonjs", "outDir": "./dist", "rootDir": "./src", "strict": true, "esModuleInterop": true }\n}\n' },
    ],
    dependencies: { 'commander': '^12.0.0' },
    devDependencies: { 'typescript': '^5.0.0', '@types/node': '^20.0.0' },
    scripts: { 'build': 'tsc', 'start': 'node dist/index.js' },
    postCreate: 'npm install',
  },
];

/**
 * Get all available templates.
 */
export function getTemplates(): ProjectTemplate[] {
  return BUILT_IN_TEMPLATES;
}

/**
 * Get a template by ID.
 */
export function getTemplate(id: string): ProjectTemplate | null {
  return BUILT_IN_TEMPLATES.find(t => t.id === id) || null;
}
