import {
  cpSync as uncheckedCpSync,
  existsSync as uncheckedExistsSync,
  mkdirSync,
  readFileSync as uncheckedReadFileSync,
  readdirSync as uncheckedReaddirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  existingArtifactCandidates,
  isPathWithin,
  quarantineArtifactCandidates,
  toPosixPath,
} from './compile-main.mjs';
import { loadQuarantinePolicy } from './lib/orphan-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Policy loading must precede every filesystem mutation. Missing, malformed,
// or expired quarantine data therefore fails closed before dist/ is touched.
const quarantinePolicy = loadQuarantinePolicy({ root });
const quarantineAbsoluteMembers = quarantinePolicy.members.map((member) => ({
  member,
  absolutePath: resolve(root, member),
}));

function assertCopySourceAllowed(source) {
  const sourcePath = resolve(source);
  const blocked = quarantineAbsoluteMembers.find(({ absolutePath }) =>
    isPathWithin(sourcePath, absolutePath),
  );
  if (blocked) {
    const requestedSource = toPosixPath(relative(root, sourcePath));
    throw new Error(
      `Refusing to copy or transform quarantined source '${blocked.member}' via '${requestedSource}'.`,
    );
  }
}

// Keep all copy/read/discovery routes fail-closed, including future explicit
// entries and recursive directory copies.
function cpSync(source, destination, options) {
  assertCopySourceAllowed(source);
  return uncheckedCpSync(source, destination, options);
}

function existsSync(source) {
  assertCopySourceAllowed(source);
  return uncheckedExistsSync(source);
}

function readFileSync(source, options) {
  assertCopySourceAllowed(source);
  return uncheckedReadFileSync(source, options);
}

function readdirSync(source, options) {
  assertCopySourceAllowed(source);
  return uncheckedReaddirSync(source, options);
}

mkdirSync(join(root, 'dist', 'renderer'), { recursive: true });

// Copy branding.json to dist root (used by src/branding.ts at runtime)
const brandingSrc = join(root, 'branding.json');
const brandingDst = join(root, 'dist', 'branding.json');
if (existsSync(brandingSrc)) {
  cpSync(brandingSrc, brandingDst);
  console.log('Copied branding.json');
}

cpSync(join(root, 'src', 'renderer', 'index.html'), join(root, 'dist', 'renderer', 'index.html'));
console.log('Copied renderer/index.html');

// Copy the restricted first-run route and point it at the parse-checked JS copy.
const modeSelectorHtmlSrc = join(root, 'src', 'renderer', 'first-run-mode-selector.html');
const modeSelectorHtmlDst = join(root, 'dist', 'renderer', 'first-run-mode-selector.html');
if (existsSync(modeSelectorHtmlSrc)) {
  const html = readFileSync(modeSelectorHtmlSrc, 'utf-8')
    .replace('./first-run-mode-selector.ts', './first-run-mode-selector.js');
  writeFileSync(modeSelectorHtmlDst, html, 'utf-8');
  console.log('Copied renderer/first-run-mode-selector.html');
}

// Copy renderer JS — strip TypeScript-only lines and write as plain JS
const rendererSrc = join(root, 'src', 'renderer', 'index.ts');
const rendererDst = join(root, 'dist', 'renderer', 'index.js');
if (existsSync(rendererSrc)) {
  let js = readFileSync(rendererSrc, 'utf-8');
  
  // Remove @ts-nocheck directive
  js = js.replace(/\/\/\s*@ts-nocheck\s*\n?/g, '');
  
  // The TypeScript interfaces are now in a comment block, so they'll be preserved as comments
  // Just remove any remaining TypeScript syntax
  
  // Remove export statements that would break browser context
  js = js.replace(/^export\s+/gm, '');

  // ── Parse-check guardrail ─────────────────────────────────────────────
  // The renderer ships as raw text (this file performs only the two
  // transforms above). Any TypeScript-only syntax that survives — type
  // annotations, non-null `!` assertions, satisfies, generics, etc. —
  // becomes a SyntaxError at app boot, which crashes the renderer
  // silently before IPC/init can run. Symptom: dark theme + nothing
  // works.
  //
  // We catch this at build time by parsing the post-transform script
  // through `new Function(...)`. That's identical to how the browser
  // sees it. If parsing fails we abort the build with a precise error
  // pointing at the offending line.
  try {
    new Function(js);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // V8 attaches `<anonymous>:<line>:<col>` to the stack for new Function
    // parse errors — extract it for a friendly hint.
    const stack = String((err && err.stack) || '');
    const locMatch = stack.match(/<anonymous>:(\d+)(?::(\d+))?/);
    let context = '';
    if (locMatch) {
      const line = parseInt(locMatch[1], 10);
      const col = locMatch[2] ? parseInt(locMatch[2], 10) : 0;
      const lines = js.split(/\n/);
      const start = Math.max(1, line - 2);
      const end = Math.min(lines.length, line + 2);
      const padW = String(end).length;
      const lineList = [];
      for (let i = start; i <= end; i++) {
        const marker = i === line ? '>' : ' ';
        lineList.push(`  ${marker} ${String(i).padStart(padW, ' ')} | ${lines[i - 1]}`);
        if (i === line && col > 0) {
          lineList.push(`     ${' '.repeat(padW)} | ${' '.repeat(col - 1)}^`);
        }
      }
      context = `\n  at line ${line}${col ? `:${col}` : ''} (in transformed JS):\n` + lineList.join('\n');
    }
    console.error('');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('✘ Renderer parse-check FAILED');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('  ' + msg);
    if (context) console.error(context);
    console.error('');
    console.error('  src/renderer/index.ts must be valid JavaScript.');
    console.error('  copy-renderer.mjs only strips `// @ts-nocheck` and');
    console.error('  leading `export` keywords. Type annotations,');
    console.error('  non-null `!` assertions, generics, `satisfies`, etc.');
    console.error('  are NOT supported and will reach the browser as-is.');
    console.error('');
    console.error('  Fix the offending syntax above, then rebuild.');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('');
    process.exit(1);
  }

  writeFileSync(rendererDst, js, 'utf-8');
  console.log('Copied renderer/index.js (parse-checked)');
}

// ── metrics-panel.ts (Dashboard_Metrics_Panel renderer) ───────────
// Same plain-JS contract as `index.ts`: `var`, no type annotations,
// no non-null assertions. The file is excluded from tsconfig.main and
// copied straight through this script with a parse-check against the
// browser's expectations (via `new Function`). Gets exposed on the
// `window.MetricsPanel` / `window.renderMetricsPanel` globals so the
// inspector view in `index.ts` can attach it without ES modules.
const metricsPanelSrc = join(root, 'src', 'renderer', 'metrics-panel.ts');
const metricsPanelDst = join(root, 'dist', 'renderer', 'metrics-panel.js');
if (existsSync(metricsPanelSrc)) {
  let js = readFileSync(metricsPanelSrc, 'utf-8');

  // Same two transforms applied to index.ts: strip @ts-nocheck and any
  // `export` keywords that would break a non-module browser context.
  js = js.replace(/\/\/\s*@ts-nocheck\s*\n?/g, '');
  js = js.replace(/^export\s+/gm, '');

  // Parse-check guardrail (mirrors the one above for index.ts).
  try {
    new Function(js);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const stack = String((err && err.stack) || '');
    const locMatch = stack.match(/<anonymous>:(\d+)(?::(\d+))?/);
    let context = '';
    if (locMatch) {
      const line = parseInt(locMatch[1], 10);
      const col = locMatch[2] ? parseInt(locMatch[2], 10) : 0;
      const lines = js.split(/\n/);
      const start = Math.max(1, line - 2);
      const end = Math.min(lines.length, line + 2);
      const padW = String(end).length;
      const lineList = [];
      for (let i = start; i <= end; i++) {
        const marker = i === line ? '>' : ' ';
        lineList.push(`  ${marker} ${String(i).padStart(padW, ' ')} | ${lines[i - 1]}`);
        if (i === line && col > 0) {
          lineList.push(`     ${' '.repeat(padW)} | ${' '.repeat(col - 1)}^`);
        }
      }
      context = `\n  at line ${line}${col ? `:${col}` : ''} (in transformed JS):\n` + lineList.join('\n');
    }
    console.error('');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('✘ Renderer parse-check FAILED (metrics-panel.ts)');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('  ' + msg);
    if (context) console.error(context);
    console.error('');
    console.error('  src/renderer/metrics-panel.ts must be valid JavaScript.');
    console.error('  Plain-JS rules: `var`, no type annotations, no non-null');
    console.error('  `!` assertions, no generics, no `satisfies`.');
    console.error('');
    console.error('  Fix the offending syntax above, then rebuild.');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('');
    process.exit(1);
  }

  writeFileSync(metricsPanelDst, js, 'utf-8');
  console.log('Copied renderer/metrics-panel.js (parse-checked)');
}

// ── Panel Registry and Panel Registrations ────────────────────────
// These files follow the same plain-JS contract as metrics-panel.ts.
// They are copied with the same parse-check guardrail.
const panelRendererFiles = [
  'event-stream-bus.ts',
  'workspace-ui-kit.ts',
  'panel-registry.ts',
  'panel-registrations.ts',
  'interactive-terminal-panel.ts',
  'network-activity-panel.ts',
  'plugin-panel.ts',
  'worktree-panel.ts',
  'cost-controls-panel.ts',
  'diff-viewer-panel.ts',
  'checkpoint-timeline-panel.ts',
  'marketplace-panel.ts',
  'process-manager-panel.ts',
  'analytics-dashboard-panel.ts',
  'notebook-panel.ts',
  'memory-panel.ts',
  'automation-workspace-panel.ts',
  'drift-intelligence-workspace-panel.ts',
  'extensions-workspace-panel.ts',
  'quality-review-security-workspace-panel.ts',
  'management-surfaces-panel.ts',
  'agent-dashboard-v2-base.ts',
  'agent-dashboard-v2-panel.ts',
  // Task 13.3 (enhanced-chat-ui) retired the following legacy renderer helpers.
  // Markdown, code, copy, streaming, scroll, empty-state, and action-bar behaviour
  // now flow through the canonical structured-response surfaces mounted by
  // `panels/chat/index.ts` via `createProjectionChatIntegration`:
  //   chat-enhancements.ts, chat-streaming.ts, chat-scroll-controller.ts,
  //   chat-empty-state.ts, chat-message-actions.ts
  'chat-input-enhanced.ts',
  'agent-state-bar.ts',
  'chat-theming.ts',
  'first-run-mode-selector.ts',
  'launch-mode-settings-control.ts',
  'legacy-provider-key-panel.ts',
  // Advanced-only Inspector factory. Owns the previously-static
  // `<aside id="inspector">` markup and the `#drag-inspector` handle so
  // Classic mode can omit both without any CSS-based hiding. Must be
  // loaded before `index.js` so `window.InspectorFactory` is available
  // to the DOMContentLoaded initializer.
  'inspector-factory.ts',
  'diff-viewer-component.ts',
  'terminal-output-component.ts',
  'channels-view.ts',
];

for (const fileName of panelRendererFiles) {
  const src = join(root, 'src', 'renderer', fileName);
  const dst = join(root, 'dist', 'renderer', fileName.replace(/\.ts$/, '.js'));
  if (existsSync(src)) {
    let js = readFileSync(src, 'utf-8');
    js = js.replace(/\/\/\s*@ts-nocheck\s*\n?/g, '');
    js = js.replace(/^export\s+/gm, '');
    // Remove TypeScript type casts: (window as any)
    js = js.replace(/\((\w+)\s+as\s+\w+\)/g, '$1');

    try {
      new Function(js);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`✘ Renderer parse-check FAILED (${fileName}): ${msg}`);
      process.exit(1);
    }

    writeFileSync(dst, js, 'utf-8');
    console.log(`Copied renderer/${fileName.replace(/\.ts$/, '.js')} (parse-checked)`);
  } else {
    console.warn(`${fileName} not found, skipping`);
  }
}

// Copy bundled data files (skills catalog and design templates)
const dataSrc = join(root, 'src', 'data');
const dataDst = join(root, 'dist', 'data');

// Copy markdown-it browser build
const markdownItSrc = join(root, 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js');
const markdownItDst = join(root, 'dist', 'renderer', 'markdown-it.min.js');
if (existsSync(markdownItSrc)) {
  cpSync(markdownItSrc, markdownItDst);
  console.log('Copied markdown-it.min.js');
} else {
  console.warn('markdown-it.min.js not found, skipping');
}

// Copy highlight.js browser bundle
const hljsSrc = join(root, 'src', 'renderer', 'hljs-common.min.js');
const hljsDst = join(root, 'dist', 'renderer', 'hljs-common.min.js');
if (existsSync(hljsSrc)) {
  cpSync(hljsSrc, hljsDst);
  console.log('Copied hljs-common.min.js');
} else {
  console.warn('hljs-common.min.js not found, skipping');
}

// Copy chat-ui.css
const chatUiCssSrc = join(root, 'src', 'renderer', 'chat-ui.css');
const chatUiCssDst = join(root, 'dist', 'renderer', 'chat-ui.css');
if (existsSync(chatUiCssSrc)) {
  cpSync(chatUiCssSrc, chatUiCssDst);
  console.log('Copied chat-ui.css');
} else {
  console.warn('chat-ui.css not found, skipping');
}

// Copy semantic-tokens.css (loaded before chat-ui.css in index.html and
// referenced by every rendered-content stylesheet via `var(--nn-color-*)`).
const semanticTokensCssSrc = join(root, 'src', 'renderer', 'semantic-tokens.css');
const semanticTokensCssDst = join(root, 'dist', 'renderer', 'semantic-tokens.css');
if (existsSync(semanticTokensCssSrc)) {
  cpSync(semanticTokensCssSrc, semanticTokensCssDst);
  console.log('Copied semantic-tokens.css');
} else {
  console.warn('semantic-tokens.css not found, skipping');
}
if (existsSync(dataSrc)) {
  mkdirSync(dataDst, { recursive: true });
  cpSync(dataSrc, dataDst, { recursive: true });
  console.log('Copied src/data to dist/data/');
} else {
  console.warn('src/data not found, skipping');
}

// Harness SQL migrations are runtime-critical assets. TypeScript does not emit
// them, so require the exact canonical 14-file set at both ends and verify
// every byte before any platform package is assembled from dist/.
const harnessMigrationFiles = Object.freeze([
  '001_create_events.sql',
  '002_create_lineage.sql',
  '003_create_prompts_completions.sql',
  '004_create_tools.sql',
  '005_create_turns_queues.sql',
  '006_create_attachments.sql',
  '007_create_projections.sql',
  '008_create_outbox_checkpoints.sql',
  '009_create_jobs_workflows.sql',
  '010_create_operational_bounds.sql',
  '011_create_schema_contracts.sql',
  '012_create_migrations.sql',
  '013_create_fenced_lease.sql',
  '014_create_goals_feedback.sql',
]);
const harnessMigrationsSrc = join(root, 'src', 'harness', 'database', 'migrations');
const harnessMigrationsDst = join(root, 'dist', 'harness', 'database', 'migrations');

function assertCanonicalMigrationDirectory(directory, label) {
  if (!existsSync(directory)) {
    throw new Error(`Required ${label} harness migrations directory is missing: ${directory}`);
  }

  const entries = readdirSync(directory, { withFileTypes: true });
  const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  const actualNames = entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  const expectedNames = [...harnessMigrationFiles];
  const exactNames =
    actualNames.length === 14 &&
    expectedNames.length === 14 &&
    actualNames.every((name, index) => name === expectedNames[index]);

  if (!exactNames || nonFiles.length > 0) {
    const missing = expectedNames.filter((name) => !actualNames.includes(name));
    const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
    const details = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      unexpected.length > 0 ? `unexpected: ${unexpected.join(', ')}` : '',
      nonFiles.length > 0 ? `not regular files: ${nonFiles.join(', ')}` : '',
      `found ${actualNames.length}, expected exactly 14`,
    ].filter(Boolean);
    throw new Error(`Invalid ${label} harness migration filenames (${details.join('; ')})`);
  }
}

// Validate and snapshot every source before replacing the destination, so a
// bad source inventory cannot leave a partially refreshed migration set.
assertCanonicalMigrationDirectory(harnessMigrationsSrc, 'source');
const harnessMigrationBytes = new Map();
for (const fileName of harnessMigrationFiles) {
  const sourcePath = join(harnessMigrationsSrc, fileName);
  const sourceBytes = readFileSync(sourcePath);
  if (sourceBytes.length === 0) {
    throw new Error(`Required harness migration is empty: ${sourcePath}`);
  }
  harnessMigrationBytes.set(fileName, sourceBytes);
}

rmSync(harnessMigrationsDst, { recursive: true, force: true });
mkdirSync(harnessMigrationsDst, { recursive: true });
for (const fileName of harnessMigrationFiles) {
  cpSync(
    join(harnessMigrationsSrc, fileName),
    join(harnessMigrationsDst, fileName),
  );
}

assertCanonicalMigrationDirectory(harnessMigrationsDst, 'destination');
for (const fileName of harnessMigrationFiles) {
  const destinationBytes = readFileSync(join(harnessMigrationsDst, fileName));
  if (!harnessMigrationBytes.get(fileName).equals(destinationBytes)) {
    throw new Error(`Harness migration copy verification failed: ${fileName}`);
  }
}
console.log(`Copied and verified the exact ${harnessMigrationFiles.length} harness SQL migrations`);

const legacyMonacoDst = join(root, 'dist', 'renderer', 'monaco');
if (existsSync(legacyMonacoDst)) {
  rmSync(legacyMonacoDst, { recursive: true, force: true });
  console.log('Removed legacy Monaco AMD assets');
}

const modernMonacoSrc = join(root, 'node_modules', 'modern-monaco', 'dist');
const modernMonacoDst = join(root, 'dist', 'renderer', 'modern-monaco');
const modernMonacoAdapterSrc = join(root, 'src', 'renderer', 'modern-monaco-adapter.mjs');
const modernMonacoAdapterDst = join(root, 'dist', 'renderer', 'modern-monaco-adapter.mjs');
const modernMonacoBootstrapSrc = join(root, 'src', 'renderer', 'modern-monaco-bootstrap.js');
const modernMonacoBootstrapDst = join(root, 'dist', 'renderer', 'modern-monaco-bootstrap.js');
const modernMonacoOfflineDst = join(root, 'dist', 'renderer', 'modern-monaco-offline.mjs');

if (existsSync(modernMonacoSrc) && existsSync(modernMonacoAdapterSrc) && existsSync(modernMonacoBootstrapSrc)) {
  mkdirSync(modernMonacoDst, { recursive: true });
  cpSync(modernMonacoSrc, modernMonacoDst, { recursive: true });
  cpSync(modernMonacoAdapterSrc, modernMonacoAdapterDst);
  cpSync(modernMonacoBootstrapSrc, modernMonacoBootstrapDst);

  // modern-monaco defaults to esm.sh unless an inline import map overrides
  // these URLs. Inline import maps are blocked by NeuroNest's production CSP,
  // so patch the pinned package copy to resolve editor/LSP modules beside
  // core.mjs. This makes local loading unconditional and CSP-safe.
  const modernMonacoCoreDst = join(modernMonacoDst, 'core.mjs');
  const remoteModuleResolution = `  let cdnUrl = \`https://esm.sh/modern-monaco@\${version}\`;
  let editorCoreModuleUrl = \`\${cdnUrl}/es2022/editor-core.mjs\`;
  let lspModuleUrl = \`\${cdnUrl}/es2022/lsp.mjs\`;
  let importmapEl = null;
  if (importmapEl = document.querySelector("script[type='importmap']")) {
    try {
      const { imports = {} } = JSON.parse(importmapEl.textContent);
      if (imports["modern-monaco/editor-core"]) {
        editorCoreModuleUrl = imports["modern-monaco/editor-core"];
      }
      if (imports["modern-monaco/lsp"]) {
        lspModuleUrl = imports["modern-monaco/lsp"];
      }
    } catch (error) {
    }
  }`;
  const localModuleResolution = `  const editorCoreModuleUrl = new URL("./editor-core.mjs", import.meta.url).href;
  const lspModuleUrl = new URL("./lsp/index.mjs", import.meta.url).href;`;
  const modernMonacoCore = readFileSync(modernMonacoCoreDst, 'utf-8');
  if (!modernMonacoCore.includes(remoteModuleResolution)) {
    throw new Error('modern-monaco core module resolution changed; refusing to emit a CDN-dependent renderer');
  }
  writeFileSync(
    modernMonacoCoreDst,
    modernMonacoCore.replace(remoteModuleResolution, localModuleResolution),
    'utf-8',
  );

  // The renderer maps only these language IDs. Their transitive TextMate
  // dependencies are bundled as direct objects so modern-monaco never calls
  // its esm.sh grammar fallback, including Markdown fenced-code grammars.
  const offlineGrammarIds = [
    'abap', 'bat', 'bibtex', 'c', 'clojure', 'cmake', 'coffee', 'cpp',
    'cpp-macro', 'csharp', 'dart', 'diff', 'docker', 'dotenv', 'elixir',
    'erlang', 'fsharp', 'git-commit', 'git-rebase', 'glsl', 'gnuplot', 'go',
    'graphql', 'groovy', 'haml', 'handlebars', 'haskell', 'html-derivative',
    'ini', 'java', 'jsonc', 'jsonl', 'julia', 'kotlin', 'latex', 'less',
    'log', 'lua', 'make', 'markdown', 'objective-c', 'perl', 'php',
    'powershell', 'proto', 'pug', 'python', 'r', 'raku', 'regexp', 'rst',
    'ruby', 'rust', 'sass', 'scala', 'scss', 'shellscript', 'sql', 'stylus',
    'swift', 'tex', 'toml', 'vb', 'xml', 'xsl', 'yaml',
  ];
  const grammarDir = join(root, 'node_modules', 'tm-grammars', 'grammars');
  const themeDir = join(root, 'node_modules', 'tm-themes', 'themes');
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));
  const offlineGrammars = offlineGrammarIds.map((id) => {
    const path = join(grammarDir, `${id}.json`);
    if (!existsSync(path)) throw new Error(`Missing offline Monaco grammar: ${id}`);
    return readJson(path);
  });
  const loadEditorTheme = (filename, name, colorOverrides) => {
    const theme = readJson(join(themeDir, `${filename}.json`));
    return {
      ...theme,
      name,
      colors: { ...(theme.colors || {}), ...(colorOverrides || {}) },
    };
  };
  const neuronestThemes = [
    loadEditorTheme('tokyo-night', 'neuronest-dark', {
      'editor.background': '#161821',
      'editorGutter.background': '#161821',
      'editor.lineHighlightBackground': '#1e2233',
      'editorStickyScroll.background': '#191c29',
      'editorStickyScroll.border': '#2a3046',
    }),
    loadEditorTheme('github-light', 'neuronest-light', {
      'editor.background': '#f8fafc',
      'editorGutter.background': '#f1f5f9',
      'editor.lineHighlightBackground': '#eaf2ff',
    }),
    loadEditorTheme('poimandres', 'neuronest-midnight', {
      'editor.background': '#10131c',
      'editorGutter.background': '#10131c',
      'editor.lineHighlightBackground': '#171c28',
    }),
    loadEditorTheme('gruvbox-light-medium', 'neuronest-sepia', {
      'editor.background': '#f5edda',
      'editorGutter.background': '#eee3ca',
      'editor.lineHighlightBackground': '#eadfc5',
    }),
    loadEditorTheme('vitesse-black', 'neuronest-terminal', {
      'editor.background': '#050806',
      'editorGutter.background': '#050806',
      'editor.foreground': '#b7f7c2',
      'editorCursor.foreground': '#58f07f',
      'editor.lineHighlightBackground': '#0b160f',
      'editorLineNumber.activeForeground': '#58f07f',
    }),
    loadEditorTheme('rose-pine-dawn', 'neuronest-zen', {
      'editor.background': '#faf4ed',
      'editorGutter.background': '#f4ede8',
      'editor.lineHighlightBackground': '#f0e7e2',
    }),
  ];
  const offlineModule = [
    '// Generated by scripts/copy-renderer.mjs from pinned local packages.',
    `export const offlineGrammars = ${JSON.stringify(offlineGrammars)};`,
    `export const neuronestThemes = ${JSON.stringify(neuronestThemes)};`,
    '',
  ].join('\n');
  writeFileSync(modernMonacoOfflineDst, offlineModule, 'utf-8');
  console.log(`Copied modern-monaco with ${offlineGrammars.length} offline grammars and ${neuronestThemes.length} themes`);
} else {
  console.warn('modern-monaco runtime or adapter not found, skipping');
}

// Copy Cytoscape.js libraries for graph visualization
const cytoscapeSrc = join(root, 'src', 'renderer', 'cytoscape');
const cytoscapeDst = join(root, 'dist', 'renderer', 'cytoscape');
if (existsSync(cytoscapeSrc)) {
  mkdirSync(cytoscapeDst, { recursive: true });
  cpSync(cytoscapeSrc, cytoscapeDst, { recursive: true });
  console.log('Copied cytoscape libraries to dist/renderer/cytoscape/');
} else {
  console.warn('cytoscape directory not found, skipping');
}

// Copy graph visualization JavaScript files
const graphVisualizationSrc = join(root, 'src', 'renderer', 'graph-visualization.js');
const graphVisualizationDst = join(root, 'dist', 'renderer', 'graph-visualization.js');
if (existsSync(graphVisualizationSrc)) {
  cpSync(graphVisualizationSrc, graphVisualizationDst);
  console.log('Copied graph-visualization.js');
} else {
  console.warn('graph-visualization.js not found, skipping');
}

const graphControlsSrc = join(root, 'src', 'renderer', 'graph-controls.js');
const graphControlsDst = join(root, 'dist', 'renderer', 'graph-controls.js');
if (existsSync(graphControlsSrc)) {
  cpSync(graphControlsSrc, graphControlsDst);
  console.log('Copied graph-controls.js');
} else {
  console.warn('graph-controls.js not found, skipping');
}

const graphTreemapSrc = join(root, 'src', 'renderer', 'graph-treemap.js');
const graphTreemapDst = join(root, 'dist', 'renderer', 'graph-treemap.js');
if (existsSync(graphTreemapSrc)) {
  cpSync(graphTreemapSrc, graphTreemapDst);
  console.log('Copied graph-treemap.js');
} else {
  console.warn('graph-treemap.js not found, skipping');
}

// Copy tippy.js bundle and Popper.js for tooltips
const popperSrc = join(root, 'node_modules', '@popperjs', 'core', 'dist', 'umd', 'popper.min.js');
const popperDst = join(root, 'dist', 'renderer', 'popper.min.js');
if (existsSync(popperSrc)) {
  cpSync(popperSrc, popperDst);
  console.log('Copied popper.min.js');
} else {
  console.warn('popper.min.js not found, skipping');
}

const tippySrc = join(root, 'node_modules', 'tippy.js', 'dist', 'tippy-bundle.umd.min.js');
const tippyDst = join(root, 'dist', 'renderer', 'tippy-bundle.umd.min.js');
if (existsSync(tippySrc)) {
  cpSync(tippySrc, tippyDst);
  console.log('Copied tippy-bundle.umd.min.js');
} else {
  console.warn('tippy.js bundle not found, skipping');
}

// Copy cross-platform emoji renderer (Twemoji)
const emojiRendererSrc = join(root, 'src', 'renderer', 'emoji-renderer.js');
const emojiRendererDst = join(root, 'dist', 'renderer', 'emoji-renderer.js');
if (existsSync(emojiRendererSrc)) {
  cpSync(emojiRendererSrc, emojiRendererDst);
  console.log('Copied emoji-renderer.js');
} else {
  console.warn('emoji-renderer.js not found, skipping');
}

// Copy local Twemoji SVG assets
const twemojiSrc = join(root, 'src', 'renderer', 'twemoji');
const twemojiDst = join(root, 'dist', 'renderer', 'twemoji');
if (existsSync(twemojiSrc)) {
  mkdirSync(twemojiDst, { recursive: true });
  cpSync(twemojiSrc, twemojiDst, { recursive: true });
  console.log('Copied twemoji SVGs to dist/renderer/twemoji/');
} else {
  console.warn('twemoji directory not found, skipping');
}

// Copy Lucide icons for UI chrome
const lucideIconsSrc = join(root, 'src', 'renderer', 'lucide-icons.js');
const lucideIconsDst = join(root, 'dist', 'renderer', 'lucide-icons.js');
if (existsSync(lucideIconsSrc)) {
  cpSync(lucideIconsSrc, lucideIconsDst);
  console.log('Copied lucide-icons.js');
} else {
  console.warn('lucide-icons.js not found, skipping');
}

// Final packaging boundary: no exact compiler, declaration, source-map, or
// source-preserving copy candidate for a quarantined member may remain.
const quarantineOutputs = quarantineArtifactCandidates(quarantinePolicy.members, {
  repoRoot: root,
  sourceRoot: join(root, 'src'),
  artifactRoot: join(root, 'dist'),
});
const remainingQuarantineOutputs = existingArtifactCandidates(quarantineOutputs);
if (remainingQuarantineOutputs.length > 0) {
  throw new Error(
    `Quarantine output verification failed:\n${remainingQuarantineOutputs
      .map((artifact) => `  - ${toPosixPath(relative(root, artifact))}`)
      .join('\n')}`,
  );
}
console.log('Verified production dist contains no quarantined artifacts');