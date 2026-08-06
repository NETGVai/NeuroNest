// ─── Built-in Adapter Bootstrap ─────────────────────────────────
// Registers all 43 channel adapters (7 real + 36 stubs) into the
// AdapterRegistry in canonical activity-bar order.
// Called from the ChannelManager constructor inside a try/catch.
//
// Requirements: REQ 6.2, REQ 22.4, REQ 24.3, REQ 30.1, REQ 30.2, REQ 30.3

import type { AdapterRegistry } from '../registry';
import { WhatsAppAdapter } from './whatsapp';
import { TelegramAdapter } from './telegram';
import { DiscordAdapter } from './discord';
import { SlackAdapter } from './slack';
import { GitHubAdapter } from './github';
import { EmailAdapter } from './email';
import { MicrosoftTeamsAdapter } from './microsoft-teams';
import { stubFactories } from '../stubs-inventory';

/**
 * Register all built-in adapters into the given registry.
 * Factories are registered — no SDK code executes at construction time.
 *
 * @satisfies REQ 6.2, REQ 22.4, REQ 24.3, REQ 30.1, REQ 30.2, REQ 30.3
 */
export function registerBuiltIns(registry: AdapterRegistry): void {
  // 7 real adapters in activity-bar order (REQ 6.2)
  registry.registerAdapter('whatsapp', () => new WhatsAppAdapter());
  registry.registerAdapter('telegram', () => new TelegramAdapter());
  registry.registerAdapter('discord', () => new DiscordAdapter());
  registry.registerAdapter('slack', () => new SlackAdapter());
  registry.registerAdapter('github', () => new GitHubAdapter());
  registry.registerAdapter('email', () => new EmailAdapter());
  registry.registerAdapter('microsoft-teams', () => new MicrosoftTeamsAdapter());

  // 36 stub adapters from the inventory (REQ 30.1, REQ 30.3)
  for (const [channelId, factory] of stubFactories()) {
    registry.registerAdapter(channelId, factory);
  }
}
