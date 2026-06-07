/**
 * Graph Manager - Handles knowledge graph generation and querying for projects
 * 
 * Integrates with Graphify to build persistent knowledge graphs from project files
 * without interfering with existing NeuroNest functionality.
 */

import { createLLMClient } from '../pipeline/llm-client';
import type { ConnectorNode, ConnectorEdge } from '../indexing/connectors/connector-interface';

export interface GraphNode {
  id: string;
  label: string;
  file_type?: 'code' | 'document' | 'paper' | 'image';
  source_file?: string;
  source_location?: string;
  community?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
  source_file?: string;
  source_location?: string;
  weight?: number;
}

export interface ProjectGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: { [key: number]: string };
  godNodes: string[];
  surprisingConnections: Array<{
    source: string;
    target: string;
    relation: string;
    reasoning: string;
  }>;
  suggestedQuestions?: Array<{
    type: string;
    question: string;
    why: string;
  }>;
  metadata: {
    projectId: string;
    generatedAt: string;
    fileCount: number;
    nodeCount?: number;
    edgeCount?: number;
    tokenReduction?: number;
    projectMetadata?: {
      agents: string[];
      skills: string[];
      templates: string[];
      llmProvider?: string;
      llmModel?: string;
    };
  };
}

export interface GraphQuery {
  question: string;
  context: string[];
  tokenCount: number;
}

export class GraphManager {
  private db: any;
  private graphCache: Map<string, ProjectGraph> = new Map();

  constructor(database: any) {
    this.db = database;
  }

  /**
   * Check if a project has a knowledge graph
   */
  hasGraph(projectId: string): boolean {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');
      
      // Graph is stored in NeuroNest data directory, not in the actual project
      const graphPath = path.join(os.homedir(), '.neuronest', 'projects', projectId, 'graph', 'graph.json');
      return fs.existsSync(graphPath);
    } catch {
      return false;
    }
  }

  /**
   * Get project metadata including actual project path
   */
  private getProjectMetadata(projectId: string): { path?: string; name?: string } | null {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');
      
      const metadataPath = path.join(os.homedir(), '.neuronest', 'projects', projectId, 'project.json');
      if (fs.existsSync(metadataPath)) {
        return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      }
    } catch (error) {
      console.warn(`[GraphManager] Could not read project metadata for ${projectId}:`, error);
    }
    return null;
  }

  /**
   * Generate a knowledge graph for a project using Node.js implementation
   */
  async generateGraph(projectId: string, projectPath?: string): Promise<{ success: boolean; message: string }> {
    try {
      console.log(`[GraphManager] Starting graph generation for project: ${projectId}`);
      
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');
      
      // Use provided project path or try to get it from project metadata
      let actualProjectPath = projectPath;
      
      if (!actualProjectPath) {
        // Try to get project path from project metadata
        const projectMetadataPath = path.join(os.homedir(), '.neuronest', 'projects', projectId, 'project.json');
        if (fs.existsSync(projectMetadataPath)) {
          try {
            const metadata = JSON.parse(fs.readFileSync(projectMetadataPath, 'utf-8'));
            actualProjectPath = metadata.path || metadata.projectPath;
          } catch (error) {
            console.warn(`[GraphManager] Could not read project metadata: ${error}`);
          }
        }
      }
      
      if (!actualProjectPath) {
        // Fallback: try using the NeuroNest project directory (old behavior)
        const neuronestProjectDir = path.join(os.homedir(), '.neuronest', 'projects', projectId);
        if (fs.existsSync(neuronestProjectDir)) {
          console.warn(`[GraphManager] No project path found, falling back to NeuroNest directory: ${neuronestProjectDir}`);
          actualProjectPath = neuronestProjectDir;
        } else {
          console.error(`[GraphManager] No project path found and NeuroNest directory doesn't exist: ${neuronestProjectDir}`);
          return { success: false, message: 'Project path not found. Please ensure the project is properly configured with a valid directory path.' };
        }
      }

      // At this point, actualProjectPath is guaranteed to be a string
      const projectPathToAnalyze = actualProjectPath as string;

      // Validate actual project directory exists
      if (!fs.existsSync(projectPathToAnalyze)) {
        console.error(`[GraphManager] Project directory not found: ${projectPathToAnalyze}`);
        return { success: false, message: `Project directory not found: ${projectPathToAnalyze}` };
      }

      // Create graph storage directory in NeuroNest data folder
      const neuronestProjectDir = path.join(os.homedir(), '.neuronest', 'projects', projectId);
      const graphDir = path.join(neuronestProjectDir, 'graph');
      
      if (!fs.existsSync(graphDir)) {
        console.log(`[GraphManager] Creating graph directory: ${graphDir}`);
        fs.mkdirSync(graphDir, { recursive: true });
      }

      // Check if project has files to analyze (scan actual project directory)
      const files = this.getProjectFiles(projectPathToAnalyze);
      if (files.length === 0) {
        console.warn(`[GraphManager] No analyzable files found in: ${projectPathToAnalyze}`);
        return { success: false, message: 'No files found to analyze. Make sure your project contains code files (.ts, .js, .py, etc.)' };
      }

      console.log(`[GraphManager] Found ${files.length} files to analyze in ${projectPathToAnalyze}`);

      // Use Node.js implementation instead of Python
      const { NodeGraphify } = await import('./node-graphify');
      const graphify = new NodeGraphify(projectId);
      
      console.log('[GraphManager] Starting Node.js graph generation...');
      const graphData = await graphify.generateGraph(projectPathToAnalyze);
      
      // Validate generated graph data
      if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
        console.error('[GraphManager] Graph generation produced no nodes');
        return { success: false, message: 'Graph generation failed: no nodes were extracted from the project files' };
      }

      console.log(`[GraphManager] Graph generated successfully: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);
      
      // Save graph to JSON file (in NeuroNest data directory)
      const graphPath = path.join(graphDir, 'graph.json');
      const graphJson = JSON.stringify(graphData, null, 2);
      fs.writeFileSync(graphPath, graphJson);
      
      console.log(`[GraphManager] Graph saved to: ${graphPath}`);
      
      // Cache the graph
      this.graphCache.set(projectId, graphData);
      
      return { 
        success: true, 
        message: `Graph generated with ${graphData.nodes.length} nodes and ${graphData.edges.length} edges` 
      };

    } catch (error: any) {
      console.error('[GraphManager] Generate graph error:', error);
      const errorMessage = error.message || 'Unknown error occurred during graph generation';
      return { success: false, message: `Graph generation failed: ${errorMessage}` };
    }
  }

  /**
   * Load a project's knowledge graph
   */
  async loadGraph(projectId: string): Promise<ProjectGraph | null> {
    try {
      console.log(`[GraphManager] Loading graph for project: ${projectId}`);
      
      // Check cache first
      if (this.graphCache.has(projectId)) {
        console.log(`[GraphManager] Graph found in cache for project: ${projectId}`);
        return this.graphCache.get(projectId)!;
      }

      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');
      
      // Graph is stored in NeuroNest data directory
      const graphPath = path.join(os.homedir(), '.neuronest', 'projects', projectId, 'graph', 'graph.json');
      
      if (!fs.existsSync(graphPath)) {
        console.log(`[GraphManager] Graph file not found: ${graphPath}`);
        return null;
      }

      console.log(`[GraphManager] Reading graph from: ${graphPath}`);
      const graphContent = fs.readFileSync(graphPath, 'utf-8');
      
      let graphData: ProjectGraph;
      try {
        graphData = JSON.parse(graphContent);
      } catch (parseError) {
        console.error(`[GraphManager] Failed to parse graph JSON:`, parseError);
        return null;
      }

      // Validate graph data structure
      if (!graphData || typeof graphData !== 'object') {
        console.error(`[GraphManager] Invalid graph data structure`);
        return null;
      }

      if (!Array.isArray(graphData.nodes)) {
        console.error(`[GraphManager] Graph data missing nodes array`);
        return null;
      }

      if (!Array.isArray(graphData.edges)) {
        console.error(`[GraphManager] Graph data missing edges array`);
        return null;
      }

      console.log(`[GraphManager] Graph loaded successfully: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);
      
      // Cache the graph
      this.graphCache.set(projectId, graphData);
      
      return graphData;
    } catch (error) {
      console.error('[GraphManager] Load graph error:', error);
      return null;
    }
  }

  /**
   * Query the knowledge graph for relevant context
   */
  async queryGraph(projectId: string, question: string, maxTokens: number = 2000): Promise<GraphQuery | null> {
    try {
      const graph = await this.loadGraph(projectId);
      if (!graph) {
        return null;
      }

      // Simple graph querying - find nodes related to the question
      const questionLower = question.toLowerCase();
      const relevantNodes = graph.nodes.filter(node => 
        node.label.toLowerCase().includes(questionLower) ||
        (node.source_file && questionLower.includes(node.source_file.toLowerCase()))
      );

      // If no direct matches, use god nodes as fallback
      if (relevantNodes.length === 0 && graph.godNodes.length > 0) {
        const godNodeIds = graph.godNodes.slice(0, 5); // Top 5 god nodes
        relevantNodes.push(...graph.nodes.filter(node => godNodeIds.includes(node.id)));
      }

      // Build context from relevant nodes and their connections
      const context: string[] = [];
      let tokenCount = 0;

      for (const node of relevantNodes.slice(0, 10)) { // Limit to 10 nodes
        const nodeContext = `${node.label}${node.source_file ? ` (${node.source_file})` : ''}`;
        
        // Find connected nodes
        const connections = graph.edges
          .filter(edge => edge.source === node.id || edge.target === node.id)
          .slice(0, 3) // Limit connections per node
          .map(edge => {
            const otherNodeId = edge.source === node.id ? edge.target : edge.source;
            const otherNode = graph.nodes.find(n => n.id === otherNodeId);
            return otherNode ? `${edge.relation} ${otherNode.label}` : '';
          })
          .filter(Boolean);

        const fullContext = connections.length > 0 
          ? `${nodeContext}: ${connections.join(', ')}`
          : nodeContext;

        const contextTokens = Math.ceil(fullContext.length / 4); // Rough token estimate
        if (tokenCount + contextTokens > maxTokens) {
          break;
        }

        context.push(fullContext);
        tokenCount += contextTokens;
      }

      return {
        question,
        context,
        tokenCount
      };

    } catch (error) {
      console.error('[GraphManager] Query graph error:', error);
      return null;
    }
  }

  /**
   * Get project files for analysis (only user project files, not NeuroNest system files)
   */
  private getProjectFiles(projectPath: string): string[] {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      
      const files: string[] = [];
      const extensions = [
        '.ts', '.js', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.md', '.txt', '.json', '.jsx', '.tsx',
        '.vue', '.svelte', '.php', '.rb', '.swift', '.kt', '.cs', '.scala', '.clj', '.hs', '.elm',
        '.dart', '.lua', '.r', '.m', '.mm', '.h', '.hpp', '.cc', '.cxx', '.f90', '.f95', '.pl',
        '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.yaml', '.yml', '.toml', '.ini',
        '.cfg', '.conf', '.xml', '.html', '.css', '.scss', '.sass', '.less', '.styl', '.sql',
        '.graphql', '.gql', '.proto', '.thrift', '.avro', '.dockerfile', '.makefile', '.cmake'
      ];
      
      // Directories to skip (NeuroNest system directories and common build/dependency directories)
      const skipDirs = new Set([
        'node_modules', 'dist', 'build', 'coverage', '.git', '.vscode', '.idea',
        'target', 'vendor', '.next', '.nuxt', '__pycache__', '.pytest_cache',
        '.kiro', '.neuronest', 'electron', 'renderer', 'main'
      ]);
      
      // Files to skip (NeuroNest system files and common config files)
      const skipFiles = new Set([
        'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
        'tsconfig.json', 'webpack.config.js', 'vite.config.js',
        'electron.js', 'main.js', 'preload.js',
        '.gitignore', '.eslintrc.js', '.prettierrc'
      ]);
      
      const walkDir = (dir: string) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
              // Skip system directories and hidden directories
              if (!entry.name.startsWith('.') && !skipDirs.has(entry.name)) {
                walkDir(fullPath);
              }
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              
              // Only include files with relevant extensions and not system files
              if (extensions.includes(ext) && !skipFiles.has(entry.name)) {
                // Additional check: skip files that look like NeuroNest system files
                const relativePath = path.relative(projectPath, fullPath);
                if (!this.isNeuroNestSystemFile(relativePath, entry.name)) {
                  files.push(fullPath);
                }
              }
            }
          }
        } catch (error) {
          // Skip directories we can't read
          console.warn(`[GraphManager] Cannot read directory: ${dir}`, error);
        }
      };

      walkDir(projectPath);
      
      console.log(`[GraphManager] File discovery complete: found ${files.length} files in ${projectPath}`);
      if (files.length > 0) {
        console.log(`[GraphManager] Sample files: ${files.slice(0, 5).map(f => path.relative(projectPath, f)).join(', ')}${files.length > 5 ? '...' : ''}`);
      }
      
      return files;
    } catch {
      return [];
    }
  }

  /**
   * Check if a file path indicates it's a NeuroNest system file
   */
  private isNeuroNestSystemFile(relativePath: string, fileName: string): boolean {
    // Only skip files that are definitely in NeuroNest system directories
    if (relativePath.includes('/.kiro/') || 
        relativePath.includes('/.neuronest/') ||
        relativePath.includes('/original-neuronest/')) {
      return true;
    }
    
    // Only skip files that are definitely NeuroNest system files (very specific patterns)
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
    
    // Check if filename matches very specific system patterns
    if (definiteSystemPatterns.some(pattern => pattern.test(fileName))) {
      return true;
    }
    
    // Check if relative path matches very specific system patterns
    if (definiteSystemPatterns.some(pattern => pattern.test(relativePath))) {
      return true;
    }
    
    return false;
  }

  /**
   * Clear graph cache for a project
   */
  clearCache(projectId: string): void {
    this.graphCache.delete(projectId);
  }

  /**
   * Get graph statistics for a project
   */
  async getGraphStats(projectId: string): Promise<{ nodes: number; edges: number; communities: number } | null> {
    try {
      const graph = await this.loadGraph(projectId);
      if (!graph) {
        return null;
      }

      return {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        communities: Object.keys(graph.communities).length
      };
    } catch {
      return null;
    }
  }

  /**
   * Merge incremental nodes from connectors into the existing Knowledge Graph
   * without triggering a full regeneration.
   *
   * - Deduplicates by node ID: if a node with the same ID already exists,
   *   it is updated only if its content (label) has changed.
   * - New edges are appended; duplicate edges (same source+target+relation) are skipped.
   * - The merged graph is persisted to the JSON file and the in-memory cache is updated.
   *
   * Requirements: 6.4, 1.7
   */
  async mergeIncrementalNodes(
    projectId: string,
    nodes: ConnectorNode[],
    edges: ConnectorEdge[]
  ): Promise<{ added: number; updated: number; edgesAdded: number }> {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');

    // Load or initialize the existing graph
    let graph = await this.loadGraph(projectId);
    if (!graph) {
      // Initialize an empty graph structure if none exists yet
      graph = {
        nodes: [],
        edges: [],
        communities: {},
        godNodes: [],
        surprisingConnections: [],
        metadata: {
          projectId,
          generatedAt: new Date().toISOString(),
          fileCount: 0,
        },
      };
    }

    // Build a lookup map for existing nodes by ID for O(1) deduplication
    const existingNodeMap = new Map<string, number>();
    for (let i = 0; i < graph.nodes.length; i++) {
      existingNodeMap.set(graph.nodes[i].id, i);
    }

    let added = 0;
    let updated = 0;

    for (const connectorNode of nodes) {
      const existingIndex = existingNodeMap.get(connectorNode.id);

      if (existingIndex !== undefined) {
        // Node exists — update only if content (label) has changed
        const existing = graph.nodes[existingIndex];
        if (existing.label !== connectorNode.label) {
          graph.nodes[existingIndex] = {
            ...existing,
            label: connectorNode.label,
            source_file: connectorNode.metadata?.source_file || existing.source_file,
          };
          updated++;
        }
      } else {
        // New node — convert ConnectorNode to GraphNode and append
        const graphNode: GraphNode = {
          id: connectorNode.id,
          label: connectorNode.label,
          file_type: connectorNode.type === 'section' || connectorNode.type === 'heading'
            ? 'document'
            : undefined,
          source_file: connectorNode.metadata?.source_file,
        };
        graph.nodes.push(graphNode);
        existingNodeMap.set(connectorNode.id, graph.nodes.length - 1);
        added++;
      }
    }

    // Build a set of existing edges for deduplication (source+target+relation)
    const existingEdgeKeys = new Set<string>();
    for (const edge of graph.edges) {
      existingEdgeKeys.add(`${edge.source}|${edge.target}|${edge.relation}`);
    }

    let edgesAdded = 0;

    for (const connectorEdge of edges) {
      const edgeKey = `${connectorEdge.source}|${connectorEdge.target}|${connectorEdge.relation}`;
      if (!existingEdgeKeys.has(edgeKey)) {
        const graphEdge: GraphEdge = {
          source: connectorEdge.source,
          target: connectorEdge.target,
          relation: connectorEdge.relation,
          confidence: 'INFERRED',
        };
        graph.edges.push(graphEdge);
        existingEdgeKeys.add(edgeKey);
        edgesAdded++;
      }
    }

    // Update metadata
    graph.metadata.generatedAt = new Date().toISOString();
    graph.metadata.nodeCount = graph.nodes.length;
    graph.metadata.edgeCount = graph.edges.length;

    // Persist the merged graph to the JSON file
    const graphDir = path.join(os.homedir(), '.neuronest', 'projects', projectId, 'graph');
    if (!fs.existsSync(graphDir)) {
      fs.mkdirSync(graphDir, { recursive: true });
    }
    const graphPath = path.join(graphDir, 'graph.json');
    fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));

    // Update the in-memory cache
    this.graphCache.set(projectId, graph);

    console.log(
      `[GraphManager] mergeIncrementalNodes: added=${added}, updated=${updated}, edgesAdded=${edgesAdded} for project ${projectId}`
    );

    return { added, updated, edgesAdded };
  }
}