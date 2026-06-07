/**
 * WorkflowCLI — Text-based DAG visualization and command-based editing.
 *
 * Provides a simplified CLI representation of workflow designs
 * for terminal-based interaction.
 *
 * Requirements: 23.16
 */

import type { WorkflowDesign, WorkflowNode, WorkflowEdge } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CLICommand {
  name: string;
  args: string[];
}

// ─── WorkflowCLI ────────────────────────────────────────────────

export class WorkflowCLI {
  /**
   * Render a text-based DAG visualization of a workflow.
   * Requirements: 23.16
   */
  renderDAG(design: WorkflowDesign): string {
    const lines: string[] = [];
    lines.push(`Workflow: ${design.metadata.name}`);
    lines.push(`Nodes: ${design.nodes.length} | Edges: ${design.edges.length}`);
    lines.push('─'.repeat(50));

    // Build adjacency for topological display
    const childMap = new Map<string, string[]>();
    const parentMap = new Map<string, string[]>();
    for (const edge of design.edges) {
      if (!childMap.has(edge.from)) childMap.set(edge.from, []);
      childMap.get(edge.from)!.push(edge.to);
      if (!parentMap.has(edge.to)) parentMap.set(edge.to, []);
      parentMap.get(edge.to)!.push(edge.from);
    }

    // Find root nodes (no parents)
    const roots = design.nodes.filter((n) => !parentMap.has(n.id) || parentMap.get(n.id)!.length === 0);

    // BFS render
    const visited = new Set<string>();
    const queue = [...roots];
    let depth = 0;

    while (queue.length > 0) {
      const levelSize = queue.length;
      for (let i = 0; i < levelSize; i++) {
        const node = queue.shift()!;
        if (visited.has(node.id)) continue;
        visited.add(node.id);

        const indent = '  '.repeat(depth);
        const status = node.status ? `[${node.status}]` : '[pending]';
        const agent = node.assignedAgentId ? ` (${node.assignedAgentId})` : '';
        lines.push(`${indent}├─ ${node.description} ${status}${agent}`);

        const children = childMap.get(node.id) ?? [];
        for (const childId of children) {
          const child = design.nodes.find((n) => n.id === childId);
          if (child && !visited.has(child.id)) {
            queue.push(child);
          }
        }
      }
      depth++;
    }

    // Render any unvisited nodes
    for (const node of design.nodes) {
      if (!visited.has(node.id)) {
        const status = node.status ? `[${node.status}]` : '[pending]';
        lines.push(`├─ ${node.description} ${status}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Parse a CLI command string.
   */
  parseCommand(input: string): CLICommand {
    const parts = input.trim().split(/\s+/);
    return {
      name: parts[0] ?? '',
      args: parts.slice(1),
    };
  }

  /**
   * Get available CLI commands for workflow editing.
   */
  getAvailableCommands(): Array<{ name: string; description: string; usage: string }> {
    return [
      { name: 'add', description: 'Add a task node', usage: 'add <description>' },
      { name: 'remove', description: 'Remove a node by ID', usage: 'remove <nodeId>' },
      { name: 'connect', description: 'Connect two nodes', usage: 'connect <fromId> <toId> [pattern]' },
      { name: 'assign', description: 'Assign agent to node', usage: 'assign <nodeId> <agentId>' },
      { name: 'finalize', description: 'Finalize workflow for execution', usage: 'finalize' },
      { name: 'show', description: 'Show current workflow DAG', usage: 'show' },
      { name: 'list', description: 'List all nodes', usage: 'list' },
    ];
  }
}
