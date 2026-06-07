/**
 * Node.js implementation of Graphify functionality
 * Eliminates Python dependency by using tree-sitter Node.js bindings
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GraphNode, GraphEdge, ProjectGraph } from './graph-manager';

// Tree-sitter imports (these need to be installed)
// npm install tree-sitter tree-sitter-typescript tree-sitter-javascript tree-sitter-python

export interface GraphifyResult extends ProjectGraph {}

export enum FileType {
  CODE = 'code',
  DOCUMENT = 'document', 
  PAPER = 'paper',
  IMAGE = 'image'
}

// File extension mappings
const CODE_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', 
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.rb', '.swift', 
  '.kt', '.kts', '.cs', '.scala', '.php', '.lua', '.zig',
  '.vue', '.svelte', '.clj', '.hs', '.elm', '.dart', '.r',
  '.m', '.mm', '.f90', '.f95', '.pl', '.sh', '.bash', '.zsh',
  '.fish', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql',
  '.proto', '.thrift', '.avro'
]);

const DOC_EXTENSIONS = new Set([
  '.md', '.txt', '.rst', '.adoc', '.org', '.tex', '.rtf'
]);

const CONFIG_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.plist', '.properties', '.env'
]);

const WEB_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.styl'
]);

// Patterns to skip (node_modules, etc.)
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist/,
  /build/,
  /coverage/,
  /\.next/,
  /\.nuxt/,
  /target/,
  /vendor/,
  /\.vscode/,
  /\.idea/
];

export class NodeGraphify {
  private llmClient: any | null;
  private projectId: string;

  constructor(projectId: string) {
    this.projectId = projectId;
    // LLM client will be initialized when needed for document extraction
    this.llmClient = null;
  }

  /**
   * Main entry point - analyze a directory and generate knowledge graph
   */
  async generateGraph(projectPath: string): Promise<GraphifyResult> {
    try {
      console.log('[NodeGraphify] Starting graph generation for:', projectPath);
      
      // 1. Discover files (only user project files, not system files)
      const files = this.discoverFiles(projectPath);
      console.log(`[NodeGraphify] Found ${files.length} files to analyze`);
      
      if (files.length === 0) {
        throw new Error('No analyzable files found in project directory');
      }

      // 2. Extract project metadata (agents, skills, templates, LLM info)
      console.log(`[NodeGraphify] Extracting project metadata...`);
      const projectMetadata = await this.extractProjectMetadata(projectPath);

      // 3. Extract from code files (deterministic AST)
      const codeFiles = files.filter(f => f.type === FileType.CODE);
      console.log(`[NodeGraphify] Processing ${codeFiles.length} code files...`);
      const codeExtractions = await this.extractFromCodeFiles(codeFiles);
      
      // 4. Extract from documents (LLM-based)
      const docFiles = files.filter(f => f.type === FileType.DOCUMENT || f.type === FileType.PAPER);
      console.log(`[NodeGraphify] Processing ${docFiles.length} document files...`);
      const docExtractions = await this.extractFromDocuments(docFiles);
      
      // 5. Add project metadata nodes
      const metadataNodes = this.createMetadataNodes(projectMetadata);
      
      // 6. Merge extractions
      const allNodes = [...codeExtractions.nodes, ...docExtractions.nodes, ...metadataNodes.nodes];
      const allEdges = [...codeExtractions.edges, ...docExtractions.edges, ...metadataNodes.edges];
      
      console.log(`[NodeGraphify] Extracted ${allNodes.length} nodes and ${allEdges.length} edges`);
      
      // 7. Community detection (simplified)
      console.log(`[NodeGraphify] Detecting communities...`);
      const communities = this.detectCommunities(allNodes, allEdges);
      
      // 8. Analyze graph structure
      console.log(`[NodeGraphify] Analyzing graph structure...`);
      const analysis = this.analyzeGraph(allNodes, allEdges, communities);
      
      const result: GraphifyResult = {
        nodes: allNodes,
        edges: allEdges,
        communities: communities,
        godNodes: analysis.godNodes,
        surprisingConnections: analysis.surprisingConnections,
        suggestedQuestions: analysis.suggestedQuestions,
        metadata: {
          projectId: this.projectId,
          generatedAt: new Date().toISOString(),
          fileCount: files.length,
          nodeCount: allNodes.length,
          edgeCount: allEdges.length,
          tokenReduction: Math.max(0, files.length - allNodes.length), // Rough estimate of complexity reduction
          projectMetadata: projectMetadata
        }
      };

      console.log(`[NodeGraphify] Generated graph with ${allNodes.length} nodes and ${allEdges.length} edges`);
      console.log(`[NodeGraphify] Found ${Object.keys(communities).length} communities and ${analysis.godNodes.length} god nodes`);
      console.log(`[NodeGraphify] Project uses: ${projectMetadata.agents.length} agents, ${projectMetadata.skills.length} skills, ${projectMetadata.templates.length} templates`);
      
      return result;

    } catch (error: any) {
      console.error('[NodeGraphify] Error generating graph:', error);
      throw new Error(`Graph generation failed: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Discover and classify files in the project directory (user files only)
   */
  private discoverFiles(projectPath: string): Array<{ path: string; type: FileType }> {
    const files: Array<{ path: string; type: FileType }> = [];
    
    const walkDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            // Skip system directories and common build/dependency directories
            if (!SKIP_PATTERNS.some(pattern => pattern.test(entry.name)) && 
                !this.isSystemDirectory(entry.name)) {
              walkDir(fullPath);
            }
          } else if (entry.isFile()) {
            // Skip system files
            if (!this.isSystemFile(entry.name, fullPath, projectPath)) {
              const fileType = this.classifyFile(fullPath);
              if (fileType) {
                files.push({ path: fullPath, type: fileType });
              }
            }
          }
        }
      } catch (error) {
        // Skip directories we can't read
        console.warn(`[NodeGraphify] Skipping directory ${dir}:`, error);
      }
    };

    walkDir(projectPath);
    
    console.log(`[NodeGraphify] File discovery complete: found ${files.length} files in ${projectPath}`);
    if (files.length > 0) {
      const filesByType = files.reduce((acc, f) => {
        acc[f.type] = (acc[f.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log(`[NodeGraphify] Files by type:`, filesByType);
      console.log(`[NodeGraphify] Sample files: ${files.slice(0, 5).map(f => path.relative(projectPath, f.path)).join(', ')}${files.length > 5 ? '...' : ''}`);
    }
    
    return files;
  }

  /**
   * Check if directory should be skipped (system directories)
   */
  private isSystemDirectory(dirName: string): boolean {
    const systemDirs = new Set([
      '.kiro', '.neuronest', 'original-neuronest',
      'node_modules', 'dist', 'build', 'coverage', '.git', '.vscode', '.idea',
      'target', 'vendor', '.next', '.nuxt', '__pycache__', '.pytest_cache'
    ]);
    
    // Only skip directories that are definitely system directories
    return systemDirs.has(dirName) || 
           dirName.startsWith('.') ||
           dirName === 'neuronest-system' ||  // Very specific NeuroNest system directory
           dirName === 'neuronest-core';      // Very specific NeuroNest core directory
  }

  /**
   * Check if file should be skipped (system files)
   */
  private isSystemFile(fileName: string, fullPath: string, projectPath: string): boolean {
    const systemFiles = new Set([
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
      'tsconfig.json', 'webpack.config.js', 'vite.config.js', 'rollup.config.js',
      '.gitignore', '.eslintrc.js', '.prettierrc', '.env', '.env.local'
    ]);
    
    if (systemFiles.has(fileName)) {
      return true;
    }
    
    // Check if file path contains system indicators (very specific patterns only)
    const relativePath = path.relative(projectPath, fullPath);
    
    // Only exclude files that are definitely in NeuroNest system directories
    if (relativePath.includes('/.kiro/') || 
        relativePath.includes('/.neuronest/') ||
        relativePath.includes('/original-neuronest/')) {
      return true;
    }
    
    // Only exclude files with very specific NeuroNest system file patterns
    const definiteSystemPatterns = [
      /^neuronest-/i,           // Files starting with "neuronest-"
      /neuronest\.config\./i,   // NeuroNest config files
      /neuronest\.json$/i,      // NeuroNest JSON files
      /-neuronest\./i,          // Files ending with "-neuronest."
      /graph-manager\./i,       // Graph system files
      /node-graphify\./i,       // Graph implementation files
      /super-agent-manager\./i, // Super agent manager files
      /session-manager\./i,     // Session manager files
      /command-system\./i,      // Command system files
      /swarm-coordinator\./i,   // Swarm coordinator files
      /orchestrator-planner\./i,// Orchestrator planner files
      /firewall-engine\./i,     // Firewall engine files
      /channel-manager\./i,     // Channel manager files
      /llm-client\./i,          // LLM client files
      /skills-ipc\./i,          // Skills IPC files
      /file-event-emitter\./i,  // File event emitter files
      /event-batcher\./i        // Event batcher files
    ];
    
    return definiteSystemPatterns.some(pattern => pattern.test(relativePath)) ||
           definiteSystemPatterns.some(pattern => pattern.test(fileName));
  }

  /**
   * Extract project metadata (agents, skills, templates, LLM info)
   */
  private async extractProjectMetadata(projectPath: string): Promise<{
    agents: string[];
    skills: string[];
    templates: string[];
    llmProvider?: string;
    llmModel?: string;
  }> {
    const metadata = {
      agents: [] as string[],
      skills: [] as string[],
      templates: [] as string[],
      llmProvider: undefined as string | undefined,
      llmModel: undefined as string | undefined
    };

    try {
      // Look for NeuroNest project configuration files
      const configPaths = [
        path.join(projectPath, '.neuronest', 'config.json'),
        path.join(projectPath, '.kiro', 'config.json'),
        path.join(projectPath, 'neuronest.config.json'),
        path.join(projectPath, 'project.json')
      ];

      for (const configPath of configPaths) {
        if (fs.existsSync(configPath)) {
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            
            // Extract agents
            if (config.agents && Array.isArray(config.agents)) {
              metadata.agents.push(...config.agents);
            }
            
            // Extract skills
            if (config.skills && Array.isArray(config.skills)) {
              metadata.skills.push(...config.skills);
            }
            
            // Extract templates
            if (config.templates && Array.isArray(config.templates)) {
              metadata.templates.push(...config.templates);
            }
            
            // Extract LLM info
            if (config.llm) {
              metadata.llmProvider = config.llm.provider;
              metadata.llmModel = config.llm.model;
            }
            
          } catch (error) {
            console.warn(`[NodeGraphify] Could not parse config file ${configPath}:`, error);
          }
        }
      }

      // Look for agent references in code files
      const codeFiles = this.discoverFiles(projectPath).filter(f => f.type === FileType.CODE);
      for (const file of codeFiles.slice(0, 10)) { // Limit to avoid performance issues
        try {
          const content = fs.readFileSync(file.path, 'utf-8');
          
          // Look for agent imports/references
          const agentMatches = content.match(/import.*agent|createAgent|useAgent|Agent\w+/gi);
          if (agentMatches) {
            metadata.agents.push(...agentMatches.map(m => m.replace(/import|create|use/gi, '').trim()));
          }
          
          // Look for skill references
          const skillMatches = content.match(/skill\w+|useSkill|import.*skill/gi);
          if (skillMatches) {
            metadata.skills.push(...skillMatches.map(m => m.replace(/import|use/gi, '').trim()));
          }
          
        } catch (error) {
          // Skip files we can't read
        }
      }

      // Deduplicate and clean up
      metadata.agents = [...new Set(metadata.agents)].filter(Boolean).slice(0, 10);
      metadata.skills = [...new Set(metadata.skills)].filter(Boolean).slice(0, 10);
      metadata.templates = [...new Set(metadata.templates)].filter(Boolean).slice(0, 10);

    } catch (error) {
      console.warn(`[NodeGraphify] Error extracting project metadata:`, error);
    }

    return metadata;
  }

  /**
   * Create metadata nodes for project information
   */
  private createMetadataNodes(metadata: {
    agents: string[];
    skills: string[];
    templates: string[];
    llmProvider?: string;
    llmModel?: string;
  }): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    
    const projectId = this.makeId('project', this.projectId);
    
    // Create project root node
    nodes.push({
      id: projectId,
      label: `Project: ${this.projectId}`,
      file_type: 'document',
      source_file: 'project_metadata',
      source_location: 'metadata'
    });

    // Add agent nodes
    for (const agent of metadata.agents) {
      const agentId = this.makeId('agent', agent);
      nodes.push({
        id: agentId,
        label: `Agent: ${agent}`,
        file_type: 'document',
        source_file: 'project_metadata',
        source_location: 'agents'
      });
      
      edges.push({
        source: projectId,
        target: agentId,
        relation: 'uses_agent',
        confidence: 'EXTRACTED',
        source_file: 'project_metadata',
        source_location: 'agents',
        weight: 1.0
      });
    }

    // Add skill nodes
    for (const skill of metadata.skills) {
      const skillId = this.makeId('skill', skill);
      nodes.push({
        id: skillId,
        label: `Skill: ${skill}`,
        file_type: 'document',
        source_file: 'project_metadata',
        source_location: 'skills'
      });
      
      edges.push({
        source: projectId,
        target: skillId,
        relation: 'uses_skill',
        confidence: 'EXTRACTED',
        source_file: 'project_metadata',
        source_location: 'skills',
        weight: 1.0
      });
    }

    // Add template nodes
    for (const template of metadata.templates) {
      const templateId = this.makeId('template', template);
      nodes.push({
        id: templateId,
        label: `Template: ${template}`,
        file_type: 'document',
        source_file: 'project_metadata',
        source_location: 'templates'
      });
      
      edges.push({
        source: projectId,
        target: templateId,
        relation: 'uses_template',
        confidence: 'EXTRACTED',
        source_file: 'project_metadata',
        source_location: 'templates',
        weight: 1.0
      });
    }

    // Add LLM nodes
    if (metadata.llmProvider) {
      const llmId = this.makeId('llm', metadata.llmProvider);
      nodes.push({
        id: llmId,
        label: `LLM: ${metadata.llmProvider}${metadata.llmModel ? ` (${metadata.llmModel})` : ''}`,
        file_type: 'document',
        source_file: 'project_metadata',
        source_location: 'llm'
      });
      
      edges.push({
        source: projectId,
        target: llmId,
        relation: 'uses_llm',
        confidence: 'EXTRACTED',
        source_file: 'project_metadata',
        source_location: 'llm',
        weight: 1.0
      });
    }

    return { nodes, edges };
  }

  /**
   * Classify file type based on extension
   */
  private classifyFile(filePath: string): FileType | null {
    const ext = path.extname(filePath).toLowerCase();
    
    if (CODE_EXTENSIONS.has(ext)) {
      return FileType.CODE;
    }
    if (DOC_EXTENSIONS.has(ext)) {
      return FileType.DOCUMENT;
    }
    if (CONFIG_EXTENSIONS.has(ext)) {
      return FileType.CODE; // Treat config files as code for analysis
    }
    if (WEB_EXTENSIONS.has(ext)) {
      return FileType.CODE; // Treat web files as code for analysis
    }
    
    // Handle special cases
    const fileName = path.basename(filePath).toLowerCase();
    if (fileName === 'dockerfile' || fileName === 'makefile' || fileName === 'cmake' || fileName.endsWith('.cmake')) {
      return FileType.CODE;
    }
    
    return null;
  }

  /**
   * Extract nodes and edges from code files using AST analysis
   */
  private async extractFromCodeFiles(files: Array<{ path: string; type: FileType }>): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    
    for (const file of files) {
      try {
        const extraction = await this.extractFromCodeFile(file.path);
        nodes.push(...extraction.nodes);
        edges.push(...extraction.edges);
      } catch (error) {
        console.warn(`[NodeGraphify] Failed to extract from ${file.path}:`, error);
      }
    }
    
    return { nodes, edges };
  }

  /**
   * Extract from a single code file (simplified AST analysis)
   */
  private async extractFromCodeFile(filePath: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const fileName = path.basename(filePath);
      const fileId = this.makeId(path.basename(filePath, path.extname(filePath)));
      
      // Create file node
      nodes.push({
        id: fileId,
        label: fileName,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: 'L1'
      });

      // Enhanced regex-based extraction with better error handling
      const ext = path.extname(filePath).toLowerCase();
      
      try {
        if (ext === '.ts' || ext === '.js' || ext === '.tsx' || ext === '.jsx') {
          this.extractTypeScriptJavaScript(content, filePath, fileId, nodes, edges);
        } else if (ext === '.py') {
          this.extractPython(content, filePath, fileId, nodes, edges);
        } else if (ext === '.java') {
          this.extractJava(content, filePath, fileId, nodes, edges);
        } else if (ext === '.go') {
          this.extractGo(content, filePath, fileId, nodes, edges);
        } else if (ext === '.rs') {
          this.extractRust(content, filePath, fileId, nodes, edges);
        } else if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.c' || ext === '.h' || ext === '.hpp') {
          this.extractCpp(content, filePath, fileId, nodes, edges);
        }
        // Add more language extractors as needed
      } catch (extractError) {
        console.warn(`[NodeGraphify] Error extracting from ${filePath}:`, extractError);
        // Continue with just the file node if extraction fails
      }
      
    } catch (error) {
      console.warn(`[NodeGraphify] Error reading file ${filePath}:`, error);
    }
    
    return { nodes, edges };
  }

  /**
   * Extract TypeScript/JavaScript constructs
   */
  private extractTypeScriptJavaScript(content: string, filePath: string, fileId: string, nodes: GraphNode[], edges: GraphEdge[]) {
    const lines = content.split('\n');
    
    // Extract imports
    const importRegex = /^import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const moduleName = match[1];
      const moduleId = this.makeId(moduleName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      edges.push({
        source: fileId,
        target: moduleId,
        relation: 'imports',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract functions
    const functionRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/gm;
    while ((match = functionRegex.exec(content)) !== null) {
      const funcName = match[1] || match[2];
      const funcId = this.makeId(fileId, funcName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: funcId,
        label: funcName,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: funcId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract classes
    const classRegex = /(?:export\s+)?class\s+(\w+)/gm;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      const classId = this.makeId(fileId, className);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: classId,
        label: className,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: classId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract interfaces
    const interfaceRegex = /(?:export\s+)?interface\s+(\w+)/gm;
    while ((match = interfaceRegex.exec(content)) !== null) {
      const interfaceName = match[1];
      const interfaceId = this.makeId(fileId, interfaceName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: interfaceId,
        label: interfaceName,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: interfaceId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }
  }

  /**
   * Extract Python constructs
   */
  private extractPython(content: string, filePath: string, fileId: string, nodes: GraphNode[], edges: GraphEdge[]) {
    // Extract imports
    const importRegex = /^(?:from\s+(\S+)\s+)?import\s+([^#\n]+)/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const moduleName = match[1] || match[2].split(',')[0].trim();
      const moduleId = this.makeId(moduleName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      edges.push({
        source: fileId,
        target: moduleId,
        relation: 'imports',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract functions
    const functionRegex = /^def\s+(\w+)\s*\(/gm;
    while ((match = functionRegex.exec(content)) !== null) {
      const funcName = match[1];
      const funcId = this.makeId(fileId, funcName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: funcId,
        label: funcName,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: funcId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract classes
    const classRegex = /^class\s+(\w+)/gm;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      const classId = this.makeId(fileId, className);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: classId,
        label: className,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: classId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }
  }

  /**
   * Extract from documents using LLM
   */
  private async extractFromDocuments(files: Array<{ path: string; type: FileType }>): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    
    // For now, create simple document nodes
    // TODO: Implement LLM-based semantic extraction
    for (const file of files) {
      try {
        const fileName = path.basename(file.path);
        const fileId = this.makeId(path.basename(file.path, path.extname(file.path)));
        
        nodes.push({
          id: fileId,
          label: fileName,
          file_type: file.type,
          source_file: file.path,
          source_location: 'L1'
        });
      } catch (error) {
        console.warn(`[NodeGraphify] Failed to process document ${file.path}:`, error);
      }
    }
    
    return { nodes, edges };
  }

  /**
   * Simple community detection based on file structure
   */
  private detectCommunities(nodes: GraphNode[], edges: GraphEdge[]): { [key: number]: string } {
    const communities: { [key: number]: string } = {};
    
    // Group by directory structure
    const dirGroups = new Map<string, number>();
    let communityId = 0;
    
    for (const node of nodes) {
      if (node.source_file) {
        const dir = path.dirname(node.source_file);
        if (!dirGroups.has(dir)) {
          dirGroups.set(dir, communityId++);
          communities[dirGroups.get(dir)!] = path.basename(dir) || 'root';
        }
        node.community = dirGroups.get(dir);
      }
    }
    
    return communities;
  }

  /**
   * Analyze graph structure to find god nodes and surprising connections
   */
  private analyzeGraph(nodes: GraphNode[], edges: GraphEdge[], communities: { [key: number]: string }) {
    // Build adjacency and degree maps
    const degrees = new Map<string, number>();
    const neighbors = new Map<string, Set<string>>();
    const nodeMap = new Map<string, GraphNode>();
    
    for (const node of nodes) {
      nodeMap.set(node.id, node);
      degrees.set(node.id, 0);
      neighbors.set(node.id, new Set());
    }
    
    for (const edge of edges) {
      degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
      neighbors.get(edge.source)?.add(edge.target);
      neighbors.get(edge.target)?.add(edge.source);
    }
    
    // Helper: check if a node is a file-level hub (not a real entity)
    const isFileNode = (nodeId: string): boolean => {
      const node = nodeMap.get(nodeId);
      if (!node) return false;
      const label = node.label || '';
      const codeExts = ['py','ts','js','go','rs','java','rb','cpp','c','h','tsx','jsx'];
      const ext = label.split('.').pop() || '';
      if (codeExts.includes(ext)) return true;
      if (label.startsWith('.') && label.endsWith('()')) return true;
      if (label.endsWith('()') && (degrees.get(nodeId) || 0) <= 1) return true;
      return false;
    };
    
    // God nodes: highest-degree real entities (exclude file hubs)
    const sortedByDegree = Array.from(degrees.entries())
      .filter(([nodeId]) => !isFileNode(nodeId))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([nodeId]) => nodeId);
    
    // Build node→community map
    const nodeCommunity = new Map<string, number>();
    for (const node of nodes) {
      if (node.community !== undefined) {
        nodeCommunity.set(node.id, node.community);
      }
    }
    
    // File category helper
    const fileCategory = (filePath: string): string => {
      const ext = (filePath.split('.').pop() || '').toLowerCase();
      const codeExts = new Set(['py','ts','tsx','js','go','rs','java','rb','cpp','c','h','cs','kt','scala','php']);
      const docExts = new Set(['md','txt','rst']);
      if (codeExts.has(ext)) return 'code';
      if (docExts.has(ext)) return 'doc';
      return 'other';
    };
    
    // Surprising connections with composite scoring (Graphify algorithm)
    const candidates: Array<{
      score: number;
      source: string;
      target: string;
      relation: string;
      reasoning: string;
    }> = [];
    
    for (const edge of edges) {
      // Skip structural edges
      if (['imports', 'imports_from', 'contains', 'method'].includes(edge.relation)) continue;
      if (isFileNode(edge.source) || isFileNode(edge.target)) continue;
      
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) continue;
      
      let score = 0;
      const reasons: string[] = [];
      
      // 1. Confidence weight
      const confBonus: Record<string, number> = { AMBIGUOUS: 3, INFERRED: 2, EXTRACTED: 1 };
      score += confBonus[edge.confidence] || 1;
      if (edge.confidence === 'AMBIGUOUS' || edge.confidence === 'INFERRED') {
        reasons.push(`${edge.confidence.toLowerCase()} connection`);
      }
      
      // 2. Cross file-type bonus
      const srcFile = sourceNode.source_file || '';
      const tgtFile = targetNode.source_file || '';
      if (srcFile && tgtFile) {
        const catSrc = fileCategory(srcFile);
        const catTgt = fileCategory(tgtFile);
        if (catSrc !== catTgt) {
          score += 2;
          reasons.push(`crosses file types (${catSrc} ↔ ${catTgt})`);
        }
        // Cross-directory bonus
        const dirSrc = srcFile.split('/')[0];
        const dirTgt = tgtFile.split('/')[0];
        if (dirSrc !== dirTgt) {
          score += 2;
          reasons.push('connects across different directories');
        }
      }
      
      // 3. Cross-community bonus
      const cidSrc = nodeCommunity.get(edge.source);
      const cidTgt = nodeCommunity.get(edge.target);
      if (cidSrc !== undefined && cidTgt !== undefined && cidSrc !== cidTgt) {
        score += 1;
        reasons.push(`bridges community "${communities[cidSrc] || cidSrc}" → "${communities[cidTgt] || cidTgt}"`);
      }
      
      // 4. Peripheral→hub bonus
      const degSrc = degrees.get(edge.source) || 0;
      const degTgt = degrees.get(edge.target) || 0;
      if (Math.min(degSrc, degTgt) <= 2 && Math.max(degSrc, degTgt) >= 5) {
        const peripheral = degSrc <= 2 ? sourceNode.label : targetNode.label;
        const hub = degSrc <= 2 ? targetNode.label : sourceNode.label;
        score += 1;
        reasons.push(`peripheral "${peripheral}" reaches hub "${hub}"`);
      }
      
      if (score > 1) {
        candidates.push({
          score,
          source: edge.source,
          target: edge.target,
          relation: edge.relation,
          reasoning: reasons.join('; ') || `Cross-community connection`
        });
      }
    }
    
    // Sort by score descending, deduplicate by community pair
    candidates.sort((a, b) => b.score - a.score);
    const seenPairs = new Set<string>();
    const surprisingConnections = candidates
      .filter(c => {
        const cidA = nodeCommunity.get(c.source);
        const cidB = nodeCommunity.get(c.target);
        const pair = [cidA, cidB].sort().join('-');
        if (seenPairs.has(pair)) return false;
        seenPairs.add(pair);
        return true;
      })
      .slice(0, 7);
    
    // Suggested questions
    const suggestedQuestions: Array<{ type: string; question: string; why: string }> = [];
    
    // 1. God node architecture questions
    if (sortedByDegree.length >= 2) {
      const top1 = nodeMap.get(sortedByDegree[0])?.label || sortedByDegree[0];
      const top2 = nodeMap.get(sortedByDegree[1])?.label || sortedByDegree[1];
      suggestedQuestions.push({
        type: 'god_node',
        question: `How do "${top1}" and "${top2}" interact, and what would break if either changed?`,
        why: `Top 2 most-connected nodes — core architectural coupling`
      });
    }
    
    // 2. Cross-community bridge questions
    if (surprisingConnections.length > 0) {
      const sc = surprisingConnections[0];
      const srcLabel = nodeMap.get(sc.source)?.label || sc.source;
      const tgtLabel = nodeMap.get(sc.target)?.label || sc.target;
      suggestedQuestions.push({
        type: 'bridge',
        question: `Why does "${srcLabel}" connect to "${tgtLabel}" across module boundaries?`,
        why: sc.reasoning
      });
    }
    
    // 3. Community cohesion questions
    const communityEntries = Object.entries(communities);
    if (communityEntries.length >= 2) {
      const commSizes = communityEntries.map(([cid, name]) => ({
        name,
        count: nodes.filter(n => String(n.community) === cid).length
      })).sort((a, b) => b.count - a.count);
      if (commSizes[0].count > commSizes[commSizes.length - 1].count * 3) {
        suggestedQuestions.push({
          type: 'community_imbalance',
          question: `Should "${commSizes[0].name}" (${commSizes[0].count} nodes) be split into smaller modules?`,
          why: `Largest community is ${Math.round(commSizes[0].count / commSizes[commSizes.length - 1].count)}x bigger than the smallest`
        });
      }
    }
    
    // 4. AMBIGUOUS edges → unresolved relationship questions
    for (const edge of edges) {
      if (edge.confidence === 'AMBIGUOUS' && suggestedQuestions.length < 5) {
        const srcLabel = nodeMap.get(edge.source)?.label || edge.source;
        const tgtLabel = nodeMap.get(edge.target)?.label || edge.target;
        suggestedQuestions.push({
          type: 'ambiguous_edge',
          question: `What is the exact relationship between "${srcLabel}" and "${tgtLabel}"?`,
          why: `Edge tagged AMBIGUOUS (relation: ${edge.relation})`
        });
      }
    }
    
    // 5. Isolated nodes → exploration questions
    const isolated = nodes.filter(n => (degrees.get(n.id) || 0) <= 1 && !isFileNode(n.id));
    if (isolated.length > 0 && isolated.length <= 20) {
      const labels = isolated.slice(0, 3).map(n => n.label);
      suggestedQuestions.push({
        type: 'isolated_nodes',
        question: `What connects ${labels.map(l => `"${l}"`).join(', ')} to the rest of the system?`,
        why: `${isolated.length} weakly-connected nodes — possible documentation gaps`
      });
    }
    
    // 6. Dependency depth question
    if (sortedByDegree.length > 0) {
      const topNode = nodeMap.get(sortedByDegree[0]);
      if (topNode) {
        const topDeg = degrees.get(sortedByDegree[0]) || 0;
        suggestedQuestions.push({
          type: 'dependency_risk',
          question: `What is the blast radius if "${topNode.label}" changes? (${topDeg} direct connections)`,
          why: `Highest-degree node — changes here ripple through the system`
        });
      }
    }
    
    return {
      godNodes: sortedByDegree,
      surprisingConnections,
      suggestedQuestions: suggestedQuestions.slice(0, 5)
    };
  }

  /**
   * Extract Java constructs
   */
  private extractJava(content: string, filePath: string, fileId: string, nodes: GraphNode[], edges: GraphEdge[]) {
    // Extract imports
    const importRegex = /^import\s+(?:static\s+)?([^;]+);/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const moduleName = match[1].split('.').pop() || match[1];
      const moduleId = this.makeId(moduleName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      edges.push({
        source: fileId,
        target: moduleId,
        relation: 'imports',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract classes
    const classRegex = /(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?class\s+(\w+)/gm;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      const classId = this.makeId(fileId, className);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: classId,
        label: className,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: classId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract methods
    const methodRegex = /(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*\{/gm;
    while ((match = methodRegex.exec(content)) !== null) {
      const methodName = match[1];
      if (methodName !== 'if' && methodName !== 'for' && methodName !== 'while') { // Filter out control structures
        const methodId = this.makeId(fileId, methodName);
        const lineNum = content.substring(0, match.index).split('\n').length;
        
        nodes.push({
          id: methodId,
          label: methodName,
          file_type: FileType.CODE,
          source_file: filePath,
          source_location: `L${lineNum}`
        });
        
        edges.push({
          source: fileId,
          target: methodId,
          relation: 'contains',
          confidence: 'EXTRACTED',
          source_file: filePath,
          source_location: `L${lineNum}`,
          weight: 1.0
        });
      }
    }
  }

  /**
   * Extract Go constructs
   */
  private extractGo(content: string, filePath: string, fileId: string, nodes: GraphNode[], edges: GraphEdge[]) {
    // Extract imports
    const importRegex = /^import\s+(?:"([^"]+)"|`([^`]+)`|\(([^)]+)\))/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const moduleName = match[1] || match[2] || match[3];
      if (moduleName) {
        const moduleId = this.makeId(moduleName.split('/').pop() || moduleName);
        const lineNum = content.substring(0, match.index).split('\n').length;
        
        edges.push({
          source: fileId,
          target: moduleId,
          relation: 'imports',
          confidence: 'EXTRACTED',
          source_file: filePath,
          source_location: `L${lineNum}`,
          weight: 1.0
        });
      }
    }

    // Extract functions
    const functionRegex = /^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/gm;
    while ((match = functionRegex.exec(content)) !== null) {
      const funcName = match[1];
      const funcId = this.makeId(fileId, funcName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: funcId,
        label: funcName,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: funcId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract structs
    const structRegex = /^type\s+(\w+)\s+struct/gm;
    while ((match = structRegex.exec(content)) !== null) {
      const structName = match[1];
      const structId = this.makeId(fileId, structName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: structId,
        label: structName,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: structId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }
  }

  /**
   * Extract Rust constructs
   */
  private extractRust(content: string, filePath: string, fileId: string, nodes: GraphNode[], edges: GraphEdge[]) {
    // Extract use statements
    const useRegex = /^use\s+([^;]+);/gm;
    let match;
    while ((match = useRegex.exec(content)) !== null) {
      const moduleName = match[1].split('::').pop() || match[1];
      const moduleId = this.makeId(moduleName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      edges.push({
        source: fileId,
        target: moduleId,
        relation: 'imports',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract functions
    const functionRegex = /^(?:pub\s+)?fn\s+(\w+)\s*\(/gm;
    while ((match = functionRegex.exec(content)) !== null) {
      const funcName = match[1];
      const funcId = this.makeId(fileId, funcName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: funcId,
        label: funcName,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: funcId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract structs
    const structRegex = /^(?:pub\s+)?struct\s+(\w+)/gm;
    while ((match = structRegex.exec(content)) !== null) {
      const structName = match[1];
      const structId = this.makeId(fileId, structName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: structId,
        label: structName,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: structId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }
  }

  /**
   * Extract C/C++ constructs
   */
  private extractCpp(content: string, filePath: string, fileId: string, nodes: GraphNode[], edges: GraphEdge[]) {
    // Extract includes
    const includeRegex = /^#include\s+[<"]([^>"]+)[>"]/gm;
    let match;
    while ((match = includeRegex.exec(content)) !== null) {
      const moduleName = match[1];
      const moduleId = this.makeId(moduleName);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      edges.push({
        source: fileId,
        target: moduleId,
        relation: 'imports',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }

    // Extract functions
    const functionRegex = /^(?:static\s+|inline\s+|extern\s+)?(?:\w+\s+)*(\w+)\s*\([^)]*\)\s*\{/gm;
    while ((match = functionRegex.exec(content)) !== null) {
      const funcName = match[1];
      if (funcName !== 'if' && funcName !== 'for' && funcName !== 'while' && funcName !== 'switch') {
        const funcId = this.makeId(fileId, funcName);
        const lineNum = content.substring(0, match.index).split('\n').length;
        
        nodes.push({
          id: funcId,
          label: funcName,
          file_type: FileType.CODE,
          source_file: filePath,
          source_location: `L${lineNum}`
        });
        
        edges.push({
          source: fileId,
          target: funcId,
          relation: 'contains',
          confidence: 'EXTRACTED',
          source_file: filePath,
          source_location: `L${lineNum}`,
          weight: 1.0
        });
      }
    }

    // Extract classes (C++)
    const classRegex = /^(?:template\s*<[^>]*>\s*)?class\s+(\w+)/gm;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      const classId = this.makeId(fileId, className);
      const lineNum = content.substring(0, match.index).split('\n').length;
      
      nodes.push({
        id: classId,
        label: className,
        file_type: FileType.CODE,
        source_file: filePath,
        source_location: `L${lineNum}`
      });
      
      edges.push({
        source: fileId,
        target: classId,
        relation: 'contains',
        confidence: 'EXTRACTED',
        source_file: filePath,
        source_location: `L${lineNum}`,
        weight: 1.0
      });
    }
  }

  /**
   * Create stable node ID from name parts
   */
  private makeId(...parts: string[]): string {
    const combined = parts
      .filter(p => p)
      .join('_')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
    
    return combined || 'unknown';
  }
}