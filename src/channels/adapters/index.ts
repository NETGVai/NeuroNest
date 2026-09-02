// ─── Built-in Adapter Bootstrap ─────────────────────────────────
// Registers all 43 channel adapters (7 original + 36 fully implemented)
// into the AdapterRegistry in canonical activity-bar order.
// Called from the ChannelManager constructor inside a try/catch.
//
// Requirements: REQ 1.1, REQ 4.1, REQ 4.2, REQ 4.3, REQ 4.4, REQ 4.5, REQ 4.6,
// REQ 6.2, REQ 22.4, REQ 24.3, REQ 30.1, REQ 30.2, REQ 30.3

import type { AdapterRegistry } from '../registry';

// ─── Original 7 adapters ────────────────────────────────────────
import { WhatsAppAdapter } from './whatsapp';
import { TelegramAdapter } from './telegram';
import { DiscordAdapter } from './discord';
import { SlackAdapter } from './slack';
import { GitHubAdapter } from './github';
import { EmailAdapter } from './email';
import { MicrosoftTeamsAdapter } from './microsoft-teams';

// ─── Messaging adapters (11) ────────────────────────────────────
import { SignalAdapter } from './signal';
import { IMessageAdapter } from './imessage';
import { BlueBubblesAdapter } from './imessage-bluebubbles';
import { NextcloudTalkAdapter } from './nextcloud-talk';
import { MatrixAdapter } from './matrix';
import { NostrAdapter } from './nostr';
import { TlonMessengerAdapter } from './tlon-messenger';
import { ZaloAdapter } from './zalo';
import { ZaloPersonalAdapter } from './zalo-personal';
import { WebChatAdapter } from './webchat';
import { TwitterXAdapter } from './twitter-x';

// ─── Productivity adapters (7) ──────────────────────────────────
import { NotionAdapter } from './notion';
import { ObsidianAdapter } from './obsidian';
import { TrelloAdapter } from './trello';
import { AppleNotesAdapter } from './apple-notes';
import { AppleRemindersAdapter } from './apple-reminders';
import { Things3Adapter } from './things-3';
import { BearNotesAdapter } from './bear-notes';

// ─── IoT adapters (3) ───────────────────────────────────────────
import { PhilipsHueAdapter } from './philips-hue';
import { EightSleepAdapter } from './8sleep';
import { HomeAssistantAdapter } from './home-assistant';

// ─── Media adapters (3) ─────────────────────────────────────────
import { SpotifyAdapter } from './spotify';
import { SonosAdapter } from './sonos';
import { ShazamAdapter } from './shazam';

// ─── Utility adapters (12) ──────────────────────────────────────
import { WeatherAdapter } from './weather';
import { GmailAdapter } from './gmail';
import { CronAdapter } from './cron';
import { WebhooksAdapter } from './webhooks';
import { OnePasswordAdapter } from './1password';
import { BrowserAdapter } from './browser';
import { VoiceAdapter } from './voice';
import { ImageGenAdapter } from './image-gen';
import { GifSearchAdapter } from './gif-search';
import { PeekabooAdapter } from './peekaboo';
import { CameraAdapter } from './camera';
import { CanvasAdapter } from './canvas';

/**
 * Register all built-in adapters into the given registry.
 * Factories are registered — no SDK code executes at construction time.
 * All 36 previously-stub adapters now declare `implementationStatus: 'available'`.
 *
 * @satisfies REQ 1.1, REQ 4.1, REQ 4.2, REQ 4.3, REQ 4.4, REQ 4.5, REQ 4.6,
 *            REQ 6.2, REQ 22.4, REQ 24.3, REQ 30.1, REQ 30.2, REQ 30.3
 */
export function registerBuiltIns(registry: AdapterRegistry): void {
  // ─── Original 7 adapters in activity-bar order (REQ 6.2) ──────
  registry.registerAdapter('whatsapp', () => new WhatsAppAdapter());
  registry.registerAdapter('telegram', () => new TelegramAdapter());
  registry.registerAdapter('discord', () => new DiscordAdapter());
  registry.registerAdapter('slack', () => new SlackAdapter());
  registry.registerAdapter('github', () => new GitHubAdapter());
  registry.registerAdapter('email', () => new EmailAdapter());
  registry.registerAdapter('microsoft-teams', () => new MicrosoftTeamsAdapter());

  // ─── Messaging adapters (REQ 4.1) ────────────────────────────
  registry.registerAdapter('signal', () => new SignalAdapter());
  registry.registerAdapter('imessage', () => new IMessageAdapter());
  registry.registerAdapter('imessage-bluebubbles', () => new BlueBubblesAdapter());
  registry.registerAdapter('nextcloud-talk', () => new NextcloudTalkAdapter());
  registry.registerAdapter('matrix', () => new MatrixAdapter());
  registry.registerAdapter('nostr', () => new NostrAdapter());
  registry.registerAdapter('tlon-messenger', () => new TlonMessengerAdapter());
  registry.registerAdapter('zalo', () => new ZaloAdapter());
  registry.registerAdapter('zalo-personal', () => new ZaloPersonalAdapter());
  registry.registerAdapter('webchat', () => new WebChatAdapter());
  registry.registerAdapter('twitter-x', () => new TwitterXAdapter());

  // ─── Productivity adapters (REQ 4.2) ─────────────────────────
  registry.registerAdapter('notion', () => new NotionAdapter());
  registry.registerAdapter('obsidian', () => new ObsidianAdapter());
  registry.registerAdapter('trello', () => new TrelloAdapter());
  registry.registerAdapter('apple-notes', () => new AppleNotesAdapter());
  registry.registerAdapter('apple-reminders', () => new AppleRemindersAdapter());
  registry.registerAdapter('things-3', () => new Things3Adapter());
  registry.registerAdapter('bear-notes', () => new BearNotesAdapter());

  // ─── IoT adapters (REQ 4.3) ──────────────────────────────────
  registry.registerAdapter('philips-hue', () => new PhilipsHueAdapter());
  registry.registerAdapter('8sleep', () => new EightSleepAdapter());
  registry.registerAdapter('home-assistant', () => new HomeAssistantAdapter());

  // ─── Media adapters (REQ 4.4) ────────────────────────────────
  registry.registerAdapter('spotify', () => new SpotifyAdapter());
  registry.registerAdapter('sonos', () => new SonosAdapter());
  registry.registerAdapter('shazam', () => new ShazamAdapter());

  // ─── Utility adapters (REQ 4.5, REQ 4.6) ─────────────────────
  registry.registerAdapter('weather', () => new WeatherAdapter());
  registry.registerAdapter('gmail', () => new GmailAdapter());
  registry.registerAdapter('cron', () => new CronAdapter());
  registry.registerAdapter('webhooks', () => new WebhooksAdapter());
  registry.registerAdapter('1password', () => new OnePasswordAdapter());
  registry.registerAdapter('browser', () => new BrowserAdapter());
  registry.registerAdapter('voice', () => new VoiceAdapter());
  registry.registerAdapter('image-gen', () => new ImageGenAdapter());
  registry.registerAdapter('gif-search', () => new GifSearchAdapter());
  registry.registerAdapter('peekaboo', () => new PeekabooAdapter());
  registry.registerAdapter('camera', () => new CameraAdapter());
  registry.registerAdapter('canvas', () => new CanvasAdapter());
}

// ─── Registry-derived availability (CD-014 resolution) ──────────
// Historically each of the 36 catalog-only adapters above declared
// `capabilities.implementationStatus: 'available'`, and this bootstrap
// registered all 43 as if connectable. That static per-adapter whitelist is a
// SUCCESS-SHAPED LIE for the catalog-only entries: the canonical
// ChannelRegistryAuthority (the single source of truth) keeps only the seven
// REAL adapters `available` and the 36 catalog-only entries `coming-soon`
// (UNAVAILABLE). Per FUT-PKG-09-RETIREMENT/T-005 (NN-INV-014, CD-014) the
// catalog-only/real distinction MUST be registry-derived, never taken from the
// static adapter whitelist. The helper below is the ONE availability query
// every consumer should use so a catalog-only id is never advertised
// `available`; it defers to the registry's REAL_CHANNEL_IDS rather than the
// adapter's self-declared status.

import { REAL_CHANNEL_IDS } from '../channel-registry-authority';

/**
 * The registry-derived set of REAL (connectable) channel ids. This is the
 * authoritative availability truth; the per-adapter `implementationStatus`
 * field is NOT consulted (NN-INV-014, CD-014).
 */
const REAL_CHANNEL_ID_SET: ReadonlySet<string> = new Set<string>(REAL_CHANNEL_IDS);

/**
 * Whether a channel id is a REAL, connectable adapter according to the CANONICAL
 * registry — NOT according to the static per-adapter whitelist. A catalog-only
 * id always returns `false` here even though its adapter self-declares
 * `implementationStatus: 'available'`, resolving the CD-014 false-success
 * (NN-INV-014). Consumers deriving availability MUST use this rather than
 * reading `adapter.capabilities.implementationStatus`.
 *
 * @satisfies NN-INV-014, CD-014
 */
export function isRegistryAvailableChannel(channelId: string): boolean {
  return REAL_CHANNEL_ID_SET.has(channelId);
}

/**
 * The registry-derived count of REAL, connectable channels (NN-DATA-013,
 * NN-IDENT-004). This is the authoritative "available" total; it is derived
 * from the registry baseline, never a static constant such as 43 (all-declared
 * available) or a historic count.
 */
export function registryAvailableChannelCount(): number {
  return REAL_CHANNEL_ID_SET.size;
}
