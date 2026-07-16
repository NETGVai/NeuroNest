import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

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
if (existsSync(dataSrc)) {
  mkdirSync(dataDst, { recursive: true });
  cpSync(dataSrc, dataDst, { recursive: true });
  console.log('Copied src/data to dist/data/');
} else {
  console.warn('src/data not found, skipping');
}

const monacoSrc = join(root, 'node_modules', 'monaco-editor', 'min');
const monacoDst = join(root, 'dist', 'renderer', 'monaco');
if (existsSync(monacoSrc)) {
  mkdirSync(monacoDst, { recursive: true });
  cpSync(monacoSrc, monacoDst, { recursive: true });
  console.log('Copied monaco-editor/min to dist/renderer/monaco/');
} else {
  console.warn('monaco-editor not found, skipping');
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
