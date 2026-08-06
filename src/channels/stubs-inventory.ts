// ─── Stub Inventory ─────────────────────────────────────────────
// Static catalogue of the 36 planned-but-not-yet-implemented channels.
// Each entry carries enough tile metadata for the UI panel to render
// a "coming soon" tile without instantiating any real SDK.

import { StubAdapter } from './stub-adapter';
import type { AdapterFactory } from './types/adapter';
import type { TileMetadata } from './types/tile-metadata';

/**
 * Shape of a single stub inventory entry.
 * @satisfies REQ 30.3
 */
export interface StubEntry {
  readonly channelId: string;
  readonly tileMetadata: Omit<TileMetadata, 'sortOrder'>;
}

/**
 * The full 36-entry stub inventory in the order specified by REQ 30.3.
 * Each entry provides the channelId and complete tileMetadata (displayName,
 * emoji, description, actionTags) matching the requirements table verbatim.
 *
 * @satisfies REQ 30.1, REQ 30.3, REQ 30.4
 */
export const STUB_INVENTORY: readonly StubEntry[] = [
  { channelId: 'signal', tileMetadata: { displayName: 'Signal', emoji: '🔒', description: 'Privacy-focused via signal-cli', actionTags: ['send message', 'receive message', 'send media'] } },
  { channelId: 'imessage', tileMetadata: { displayName: 'iMessage', emoji: '🍎', description: 'Via AppleScript bridge', actionTags: ['send message', 'receive message', 'send media'] } },
  { channelId: 'imessage-bluebubbles', tileMetadata: { displayName: 'iMessage BlueBubbles', emoji: '🫧', description: 'Via BlueBubbles server', actionTags: ['send message', 'receive message', 'group chat'] } },
  { channelId: 'nextcloud-talk', tileMetadata: { displayName: 'Nextcloud Talk', emoji: '☁️', description: 'Self-hosted messaging', actionTags: ['send message', 'receive message', 'file sharing'] } },
  { channelId: 'matrix', tileMetadata: { displayName: 'Matrix', emoji: '🔗', description: 'Decentralized protocol', actionTags: ['send message', 'receive message', 'rooms', 'encryption'] } },
  { channelId: 'nostr', tileMetadata: { displayName: 'Nostr', emoji: '🌐', description: 'Decentralized DMs', actionTags: ['send message', 'receive message', 'publish notes'] } },
  { channelId: 'tlon-messenger', tileMetadata: { displayName: 'Tlon Messenger', emoji: '🛸', description: 'P2P messaging', actionTags: ['send message', 'receive message'] } },
  { channelId: 'zalo', tileMetadata: { displayName: 'Zalo', emoji: '🇻🇳', description: 'Bot API', actionTags: ['send message', 'receive message', 'send media'] } },
  { channelId: 'zalo-personal', tileMetadata: { displayName: 'Zalo Personal', emoji: '🇻🇳', description: 'QR login', actionTags: ['send message', 'receive message'] } },
  { channelId: 'webchat', tileMetadata: { displayName: 'WebChat', emoji: '🌍', description: 'Browser UI', actionTags: ['send message', 'receive message', 'file upload'] } },
  { channelId: 'apple-notes', tileMetadata: { displayName: 'Apple Notes', emoji: '📝', description: 'Native macOS notes', actionTags: ['create note', 'search notes', 'append to note'] } },
  { channelId: 'apple-reminders', tileMetadata: { displayName: 'Apple Reminders', emoji: '⏰', description: 'Native macOS reminders', actionTags: ['create reminder', 'list reminders', 'complete reminder'] } },
  { channelId: 'things-3', tileMetadata: { displayName: 'Things 3', emoji: '✅', description: 'GTD task manager', actionTags: ['create task', 'list tasks', 'complete task', 'create project'] } },
  { channelId: 'notion', tileMetadata: { displayName: 'Notion', emoji: '📓', description: 'All-in-one workspace', actionTags: ['create page', 'query database', 'update page', 'search'] } },
  { channelId: 'obsidian', tileMetadata: { displayName: 'Obsidian', emoji: '💎', description: 'Knowledge base and notes', actionTags: ['create note', 'search vault', 'link notes', 'read note'] } },
  { channelId: 'bear-notes', tileMetadata: { displayName: 'Bear Notes', emoji: '🐻', description: 'Markdown notes for Apple', actionTags: ['create note', 'search notes', 'tag notes'] } },
  { channelId: 'trello', tileMetadata: { displayName: 'Trello', emoji: '📌', description: 'Kanban boards', actionTags: ['create card', 'move card', 'list boards', 'add comment'] } },
  { channelId: 'spotify', tileMetadata: { displayName: 'Spotify', emoji: '🎵', description: 'Music streaming control', actionTags: ['play track', 'pause', 'skip', 'search', 'get queue'] } },
  { channelId: 'sonos', tileMetadata: { displayName: 'Sonos', emoji: '🔊', description: 'Multi-room audio', actionTags: ['play', 'pause', 'volume', 'group rooms'] } },
  { channelId: 'shazam', tileMetadata: { displayName: 'Shazam', emoji: '🎤', description: 'Music recognition', actionTags: ['identify song', 'get lyrics'] } },
  { channelId: 'philips-hue', tileMetadata: { displayName: 'Philips Hue', emoji: '💡', description: 'Smart lighting control', actionTags: ['set light', 'set scene', 'list rooms', 'toggle'] } },
  { channelId: '8sleep', tileMetadata: { displayName: '8Sleep', emoji: '🛏️', description: 'Smart mattress control', actionTags: ['set temperature', 'get status', 'set schedule'] } },
  { channelId: 'home-assistant', tileMetadata: { displayName: 'Home Assistant', emoji: '🏠', description: 'Open-source home automation', actionTags: ['call service', 'get state', 'trigger automation'] } },
  { channelId: 'browser', tileMetadata: { displayName: 'Browser', emoji: '🌐', description: 'Chrome control', actionTags: ['open URL', 'screenshot', 'click element', 'extract text'] } },
  { channelId: 'canvas', tileMetadata: { displayName: 'Canvas', emoji: '🎨', description: 'Visual workspace', actionTags: ['create canvas', 'add element', 'export'] } },
  { channelId: 'voice', tileMetadata: { displayName: 'Voice', emoji: '🎙️', description: 'Wake word and speech', actionTags: ['transcribe', 'speak', 'wake word'] } },
  { channelId: 'gmail', tileMetadata: { displayName: 'Gmail', emoji: '📧', description: 'Pub/sub email triggers', actionTags: ['send email', 'read inbox', 'search', 'watch'] } },
  { channelId: 'cron', tileMetadata: { displayName: 'Cron', emoji: '⏱️', description: 'Scheduled tasks', actionTags: ['create schedule', 'list schedules', 'delete schedule'] } },
  { channelId: 'webhooks', tileMetadata: { displayName: 'Webhooks', emoji: '🪝', description: 'External triggers', actionTags: ['create webhook', 'list webhooks', 'trigger'] } },
  { channelId: '1password', tileMetadata: { displayName: '1Password', emoji: '🔑', description: 'Credential management', actionTags: ['get credential', 'list vaults', 'create item'] } },
  { channelId: 'weather', tileMetadata: { displayName: 'Weather', emoji: '🌤️', description: 'Weather data', actionTags: ['get forecast', 'get current', 'get alerts'] } },
  { channelId: 'image-gen', tileMetadata: { displayName: 'Image Gen', emoji: '🖼️', description: 'AI image generation', actionTags: ['generate image', 'edit image', 'upscale'] } },
  { channelId: 'gif-search', tileMetadata: { displayName: 'GIF Search', emoji: '🎞️', description: 'GIF discovery', actionTags: ['search GIFs', 'trending', 'random'] } },
  { channelId: 'peekaboo', tileMetadata: { displayName: 'Peekaboo', emoji: '👀', description: 'Screen capture', actionTags: ['screenshot', 'record', 'OCR'] } },
  { channelId: 'camera', tileMetadata: { displayName: 'Camera', emoji: '📷', description: 'Camera capture', actionTags: ['capture photo', 'record video', 'scan QR'] } },
  { channelId: 'twitter-x', tileMetadata: { displayName: 'Twitter/X', emoji: '🐦', description: 'Social media posting', actionTags: ['post tweet', 'reply', 'search', 'get timeline'] } },
] as const;

/**
 * Generator that yields `[channelId, AdapterFactory]` pairs for every stub
 * in the inventory. Each factory lazily creates a `StubAdapter` with the
 * full tile metadata and a deterministic `sortOrder` of `1000 + index`.
 *
 * Used by the AdapterRegistry bootstrap to bulk-register all placeholder
 * channels without eagerly constructing adapter instances.
 *
 * @satisfies REQ 30.1, REQ 31.6
 */
export function* stubFactories(): IterableIterator<[string, AdapterFactory]> {
  for (let i = 0; i < STUB_INVENTORY.length; i++) {
    const entry = STUB_INVENTORY[i]!;
    yield [
      entry.channelId,
      () => new StubAdapter(entry.channelId, { ...entry.tileMetadata, sortOrder: 1000 + i }),
    ];
  }
}
