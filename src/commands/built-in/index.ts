/**
 * Built-in slash commands — wired to NeuroNest subsystems.
 */
import type { CommandDefinition, CommandContext, CommandResult } from '../command-system';

function ok(output: string): CommandResult { return { success: true, output }; }
function err(error: string): CommandResult { return { success: false, output: '', error }; }

/** Extract the value following a flag from an args array, or undefined if not present. */
function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export const builtInCommands: CommandDefinition[] = [
  {
    id: 'help', name: 'help', description: 'Show all available commands', usage: '/help',
    execute: async (args, ctx) => {
      return ok('Available commands:\n\n' +
        '/help — Show this help\n' +
        '/agents — List all agents by department\n' +
        '/agent <name> — Show agent details\n' +
        '/departments — List all departments\n' +
        '/projects — List all projects\n' +
        '/status — Show current project status\n' +
        '/providers — List configured model providers\n' +
        '/model [provider,model] — Switch active model\n' +
        '/theme <light|dark> — Switch UI theme\n' +
        '/clear — Clear chat history display\n' +
        '/cost — Show token usage and estimated cost\n' +
        '/swarm <task> — Run a multi-agent swarm on a task\n' +
        '/optimize <prompt> — Run ZERA optimizer on a prompt\n' +
        '/plan <task> — Show orchestrator plan without executing\n' +
        '/memory — Show long-term memory facts\n' +
        '/config — Show current configuration\n' +
        '/version — Show NeuroNest version\n' +
        '/doctor — Run system health diagnostics\n' +
        '/security <scan|doctor> — Security scanning tools\n' +
        '/skills — List loaded skills and token costs\n' +
        '/mode <flash|standard|pro|ultra> — Set execution mode\n' +
        '/remember <fact> — Store a fact in long-term memory\n' +
        '/forget <fact> — Delete a fact from long-term memory\n' +
        '/channel <platform> <config> — Configure IM channel\n' +
        '/sandbox <local|docker> — Set sandbox backend\n' +
        '/mcp <list|add|remove> — Manage MCP servers');
    }
  },
  {
    id: 'agents', name: 'agents', description: 'List all agents by department', usage: '/agents [department]',
    execute: async (args, ctx) => {
      const { AGENT_REGISTRY, DEPARTMENTS, getAgentsByDepartment } = require('../../agents/agent-registry');
      if (args.length > 0) {
        const dept = args.join(' ');
        const match = DEPARTMENTS.find((d: string) => d.toLowerCase().includes(dept.toLowerCase()));
        if (!match) return err('Department not found: ' + dept + '. Use /departments to see all.');
        const agents = getAgentsByDepartment(match);
        return ok(match + ' (' + agents.length + ' agents):\n\n' + agents.map((a: any) => a.emoji + ' ' + a.name + ' — ' + a.specialty.slice(0, 80)).join('\n'));
      }
      const counts: string[] = [];
      for (const d of DEPARTMENTS) {
        const agents = getAgentsByDepartment(d);
        counts.push(d + ': ' + agents.length + ' agents');
      }
      return ok(AGENT_REGISTRY.length + ' agents across ' + DEPARTMENTS.length + ' departments:\n\n' + counts.join('\n') + '\n\nUse /agents <department> to see agents in a department.');
    }
  },
  {
    id: 'agent', name: 'agent', description: 'Show agent details', usage: '/agent <name>',
    execute: async (args, ctx) => {
      if (!args.length) return err('Usage: /agent <name>');
      const { AGENT_REGISTRY } = require('../../agents/agent-registry');
      const query = args.join(' ').toLowerCase();
      const agent = AGENT_REGISTRY.find((a: any) => a.name.toLowerCase().includes(query) || a.id.includes(query));
      if (!agent) return err('Agent not found: ' + args.join(' '));
      return ok(agent.emoji + ' ' + agent.name + '\nDepartment: ' + agent.department + '\nSpecialty: ' + agent.specialty + '\n\nSystem Prompt:\n' + agent.systemPrompt);
    }
  },
  {
    id: 'departments', name: 'departments', description: 'List all departments', usage: '/departments',
    execute: async () => {
      const { DEPARTMENTS, getAgentsByDepartment } = require('../../agents/agent-registry');
      return ok(DEPARTMENTS.length + ' Departments:\n\n' + DEPARTMENTS.map((d: string) => {
        const agents = getAgentsByDepartment(d);
        return d + ' (' + agents.length + ' agents)';
      }).join('\n'));
    }
  },
  {
    id: 'projects', name: 'projects', description: 'List all projects', usage: '/projects',
    execute: async () => ok('Use the sidebar to view and manage projects.')
  },
  {
    id: 'status', name: 'status', description: 'Show current project status', usage: '/status',
    execute: async (args, ctx) => ok('Active project: ' + (ctx.sessionId || 'none') + '\nAgent: ' + (ctx.agentId || 'default'))
  },
  {
    id: 'providers', name: 'providers', description: 'List configured providers', usage: '/providers',
    execute: async () => ok('Use Settings to manage model providers. Click ⚙️ Settings in the navigation.')
  },
  {
    id: 'theme', name: 'theme', description: 'Switch UI theme', usage: '/theme <light|dark>',
    execute: async (args) => {
      const t = (args[0] || '').toLowerCase();
      if (t === 'light' || t === 'dark') return ok('Theme switched to ' + t + ' mode.');
      return err('Usage: /theme light or /theme dark');
    }
  },
  {
    id: 'clear', name: 'clear', description: 'Clear chat display', usage: '/clear',
    execute: async () => ok('__CLEAR__')
  },
  {
    id: 'cost', name: 'cost', description: 'Show token usage and cost', usage: '/cost',
    execute: async (_args, ctx) => {
      try {
        const { initDatabase } = require('../../storage/database');
        const db = initDatabase();
        const tokenRow = db.prepare("SELECT value FROM config WHERE key = 'total-tokens'").get() as any;
        const costRow = db.prepare("SELECT value FROM config WHERE key = 'total-cost'").get() as any;
        const tokens = tokenRow ? parseInt(tokenRow.value) || 0 : 0;
        const cost = costRow ? parseFloat(costRow.value) || 0 : 0;
        if (tokens === 0 && cost === 0) {
          return ok('💰 **Cost Tracking**\n\nNo usage recorded yet. Send a message to an AI provider to start tracking.\n\nCheck the Dashboard for detailed breakdowns by provider and project.');
        }
        return ok('💰 **Cost Tracking**\n\n**Total tokens:** ' + tokens.toLocaleString() + '\n**Estimated cost:** $' + cost.toFixed(4) + '\n\nCheck the Dashboard for detailed breakdowns by provider and project.');
      } catch {
        return ok('💰 Cost tracking is active. Check the Dashboard for detailed usage stats.');
      }
    }
  },
  {
    id: 'swarm', name: 'swarm', description: 'Run a multi-agent swarm', usage: '/swarm <task>',
    execute: async (args) => {
      if (!args.length) return err('Usage: /swarm <task description>');
      return ok('__SWARM__' + args.join(' '));
    }
  },
  {
    id: 'optimize', name: 'optimize', description: 'Run ZERA optimizer', usage: '/optimize <prompt>',
    execute: async (args) => {
      if (!args.length) return err('Usage: /optimize <prompt>');
      return ok('__OPTIMIZE__' + args.join(' '));
    }
  },
  {
    id: 'plan', name: 'plan', description: 'Show execution plan', usage: '/plan <task>',
    execute: async (args) => {
      if (!args.length) return err('Usage: /plan <task description>');
      return ok('__PLAN__' + args.join(' '));
    }
  },
  {
    id: 'memory', name: 'memory', description: 'Show long-term memory facts', usage: '/memory',
    execute: async () => ok('__MEMORY__')
  },
  {
    id: 'config', name: 'config', description: 'Show configuration', usage: '/config',
    execute: async () => ok('Use Settings (⚙️) to configure providers, agents, and preferences.')
  },
  {
    id: 'version', name: 'version', description: 'Show version', usage: '/version',
    execute: async () => {
      const { AGENT_REGISTRY, DEPARTMENTS } = require('../../agents/agent-registry');
      let version = '0.1.0';
      try { version = require('../../package.json').version || version; } catch {}
      try { const { app } = require('electron'); version = app.getVersion() || version; } catch {}
      return ok('NeuroNest v' + version + ' — Multi-Agent AI Workspace\n' + AGENT_REGISTRY.length + ' agents • ' + DEPARTMENTS.length + ' departments • ZERA optimizer • Swarm execution • Smart Router');
    }
  },
  {
    id: 'model',
    name: 'model',
    description: 'Switch the active model on-the-fly',
    usage: '/model [provider,model] — Switch model. No args shows current.',
    execute: async (args, ctx) => {
      if (args.length === 0) {
        return ok('__MODEL_STATUS__');
      }
      const input = args.join(' ');
      const parts = input.split(',').map(s => s.trim());
      if (parts.length < 2) {
        return err('Usage: /model provider,model — e.g. /model openai,gpt-4o');
      }
      return ok('__MODEL_SWITCH__' + parts[0] + ',' + parts[1]);
    }
  },
  {
    id: 'doctor',
    name: 'doctor',
    description: 'Run system health diagnostics',
    usage: '/doctor',
    execute: async (args, ctx) => {
      return ok('__DOCTOR__');
    }
  },
  {
    id: 'security',
    name: 'security',
    description: 'Security scanning tools',
    usage: '/security <scan|doctor> [options]',
    execute: async (args, ctx) => {
      const subcommand = args[0]?.toLowerCase();
      if (subcommand === 'scan') {
        const tier = parseFlag(args, '--tier') || 'extended';
        const baseline = parseFlag(args, '--baseline');
        const output = parseFlag(args, '--output');
        return ok(`__SECURITY_SCAN__${JSON.stringify({ tier, baseline, output })}`);
      }
      if (subcommand === 'doctor') {
        return ok('__SECURITY_DOCTOR__');
      }
      return ok(
        'Security scanning tools:\n\n' +
        '/security scan [--tier minimal|extended|paranoid] [--baseline <path>] [--output <path>]\n' +
        '/security doctor — Verify scanner health'
      );
    }
  },
  // ─── DeerFlow slash commands ────────────────────────────────────
  {
    id: 'skills', name: 'skills', description: 'List loaded skills and token costs', usage: '/skills',
    execute: async () => ok('__SKILLS__')
  },
  {
    id: 'mode', name: 'mode', description: 'Set execution mode', usage: '/mode <flash|standard|pro|ultra>',
    execute: async (args) => {
      const validModes = ['flash', 'standard', 'pro', 'ultra'];
      if (!args.length) return ok('__MODE__');
      const mode = args[0].toLowerCase();
      if (!validModes.includes(mode)) return err('Invalid mode: ' + mode + '. Valid modes: flash, standard, pro, ultra');
      return ok('__MODE__' + mode);
    }
  },
  {
    id: 'remember', name: 'remember', description: 'Store a fact in long-term memory', usage: '/remember <fact>',
    execute: async (args) => {
      if (!args.length) return err('Usage: /remember <fact>');
      return ok('__REMEMBER__' + args.join(' '));
    }
  },
  {
    id: 'forget', name: 'forget', description: 'Delete a fact from long-term memory', usage: '/forget <fact>',
    execute: async (args) => {
      if (!args.length) return err('Usage: /forget <fact>');
      return ok('__FORGET__' + args.join(' '));
    }
  },
  {
    id: 'channel', name: 'channel', description: 'Configure IM channel connection', usage: '/channel <platform> <config>',
    execute: async (args) => {
      if (args.length < 2) return err('Usage: /channel <whatsapp|telegram|slack|discord> <config>');
      const platform = args[0].toLowerCase();
      if (!['whatsapp', 'telegram', 'slack', 'discord'].includes(platform)) return err('Unsupported platform: ' + platform + '. Supported: whatsapp, telegram, slack, discord');
      return ok('__CHANNEL__' + JSON.stringify({ platform, config: args.slice(1).join(' ') }));
    }
  },
  {
    id: 'sandbox', name: 'sandbox', description: 'Set sandbox execution backend', usage: '/sandbox <local|docker>',
    execute: async (args) => {
      if (!args.length) return err('Usage: /sandbox <local|docker>');
      const backend = args[0].toLowerCase();
      if (backend !== 'local' && backend !== 'docker') return err('Invalid backend: ' + backend + '. Valid: local, docker');
      return ok('__SANDBOX__' + backend);
    }
  },
  {
    id: 'mcp', name: 'mcp', description: 'Manage MCP server configurations', usage: '/mcp <list|add|remove>',
    execute: async (args) => {
      if (!args.length) return ok('MCP server management:\n\n/mcp list — List configured servers\n/mcp add <name> <url> — Add a server\n/mcp remove <id> — Remove a server');
      const sub = args[0].toLowerCase();
      if (!['list', 'add', 'remove'].includes(sub)) return err('Unknown subcommand: ' + sub + '. Valid: list, add, remove');
      return ok('__MCP__' + JSON.stringify({ subcommand: sub, args: args.slice(1) }));
    }
  },
];
