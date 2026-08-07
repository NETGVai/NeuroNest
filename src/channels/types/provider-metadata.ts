// ─── Provider Metadata ──────────────────────────────────────────
// Discriminated-union type keyed on `channelId` carrying provider-specific
// fields for incoming and outgoing messages.

/**
 * All 36 stub channelIds from the tile-inventory table (REQ 30.3).
 * Used as the discriminator value in the shared no-op stub variant of
 * `ProviderMetadata` so stubs type-check without leaking provider-specific fields.
 *
 * @satisfies REQ 30.3
 */
export type StubChannelId =
  | 'signal'
  | 'imessage'
  | 'imessage-bluebubbles'
  | 'matrix'
  | 'nostr'
  | 'tlon-messenger'
  | 'zalo'
  | 'zalo-personal'
  | 'webchat'
  | 'apple-notes'
  | 'apple-reminders'
  | 'things-3'
  | 'notion'
  | 'obsidian'
  | 'bear-notes'
  | 'trello'
  | 'spotify'
  | 'sonos'
  | 'shazam'
  | 'philips-hue'
  | '8sleep'
  | 'home-assistant'
  | 'browser'
  | 'canvas'
  | 'voice'
  | 'gmail'
  | 'cron'
  | 'webhooks'
  | '1password'
  | 'weather'
  | 'image-gen'
  | 'gif-search'
  | 'peekaboo'
  | 'camera'
  | 'twitter-x';

/**
 * Discriminated union keyed on `channelId` for provider-specific metadata
 * attached to `IncomingMessage.providerMetadata` and `OutgoingMessage.providerMetadata`.
 *
 * Each real adapter variant carries typed fields specific to that provider.
 * The final variant covers all 36 stub channelIds with a minimal shape so
 * stubs type-check without leaking provider-specific fields.
 *
 * @satisfies REQ 2.3, REQ 3.3, REQ 3.5
 */
export type ProviderMetadata =
  | { channelId: 'whatsapp'; waMessageId?: string; timestamp?: number }
  | {
      channelId: 'telegram';
      chatId: number | string;
      messageId?: number;
      parseMode?: 'Markdown' | 'HTML';
    }
  | {
      channelId: 'discord';
      guildId?: string;
      /** Discord channel snowflake. Named `channelId_` to avoid clash with the discriminator. */
      channelId_: string;
      messageId?: string;
    }
  | {
      channelId: 'slack';
      ts: string;
      thread_ts?: string;
      teamId?: string;
    }
  | {
      channelId: 'github';
      owner: string;
      repo: string;
      issueNumber?: number;
    }
  | {
      channelId: 'email';
      messageId?: string;
      subject?: string;
    }
  | {
      channelId: 'microsoft-teams';
      /** Opaque handle into the in-memory conversation-reference Map. */
      conversationRef?: string;
      activityType?: 'message' | 'typing' | 'other';
      aadObjectId?: string;
    }
  | {
      channelId: 'nextcloud-talk';
      messageId?: number;
      conversationToken?: string;
      actorDisplayName?: string;
    }
  | { channelId: StubChannelId };
