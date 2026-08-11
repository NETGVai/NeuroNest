/**
 * CLI runner for the staged agent upgrade pipeline.
 * Discovers all agents, generates bodies, validates, and applies.
 */
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { discoverCatalog } from './catalog-discovery';
import { parseAgentFileDocument } from './agent-file-parser';
import { generateAgentBody } from './agent-body-generator';

async function main(): Promise<void> {
  const rootPath = resolve(
    process.argv[2] || 'src/data/agents',
  );
  console.log(`Discovering agents under: ${rootPath}`);

  const manifest = await discoverCatalog(rootPath);
  console.log(`Discovered ${manifest.entries.length} agent files`);

  let upgraded = 0;
  let skipped = 0;

  for (const entry of manifest.entries) {
    const source = await readFile(entry.absolutePath);
    const parseResult = parseAgentFileDocument(source);

    if (!parseResult.frontmatter.present || !parseResult.frontmatter.parseable) {
      console.warn(`SKIP ${entry.sourcePath}: unparseable frontmatter`);
      skipped++;
      continue;
    }

    const frontmatter = parseResult.frontmatter.values;
    const name = frontmatter['name'] || entry.sourcePath;
    const department = frontmatter['department'] || 'Specialized';
    const specialty = frontmatter['specialty'] || '';

    const newBody = generateAgentBody({ name, department, specialty });

    // Reconstruct file: original frontmatter + new body
    const frontmatterText = parseResult.frontmatter.rawText;
    const fullContent = frontmatterText + '\n' + newBody + '\n';

    await writeFile(entry.absolutePath, fullContent, 'utf8');
    upgraded++;
  }

  console.log(`Upgraded: ${upgraded}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error('Upgrade failed:', err);
  process.exit(1);
});
