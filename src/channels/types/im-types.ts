// ─── IM_Gateway Types ───────────────────────────────────────────
// Type definitions for the instant-messaging channel gateway.

export interface IMConfig {
  platform: 'whatsapp' | 'telegram' | 'slack' | 'discord';
  credentials: Record<string, string>; // platform-specific
}

export interface IMTask {
  channelId: string;
  platform: string;
  from: string;
  content: string;
  threadId?: string;
}
