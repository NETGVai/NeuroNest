// OpenClaw Integration Registry
// All integrations excluding AI Models, Platforms, and Community Showcase

export interface ConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select' | 'toggle';
  placeholder?: string;
  options?: string[];
  required?: boolean;
  envVar?: string;
}

export interface Integration {
  id: string;
  name: string;
  emoji: string;
  category: string;
  description: string;
  actions: string[];
  configFields: ConfigField[];
}

export const INTEGRATION_CATEGORIES: string[] = [
  'Chat Providers',
  'Productivity',
  'Music & Audio',
  'Smart Home',
  'Tools & Automation',
  'Media & Creative',
  'Social',
];

export const INTEGRATIONS: Integration[] = [
  // ── Chat Providers ──────────────────────────────────────────────
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    emoji: '💬',
    category: 'Chat Providers',
    description: 'WhatsApp Business Cloud API or Baileys (Web protocol)',
    actions: ['send message', 'receive message', 'send media'],
    configFields: [
      { key: 'mode', label: 'Connection Mode', type: 'select', options: ['baileys', 'cloud'] },
      { key: 'accessToken', label: 'Access Token (Cloud API)', type: 'password', placeholder: 'EAAx...' },
      { key: 'phoneNumberId', label: 'Phone Number ID (Cloud API)', type: 'text', placeholder: '1234567890' },
    ],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    emoji: '✈️',
    category: 'Chat Providers',
    description: 'Bot API via grammY',
    actions: ['send message', 'receive message', 'inline queries', 'send media'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'botToken', label: 'Bot Token', type: 'password', placeholder: '123456:ABC...', envVar: 'TELEGRAM_BOT_TOKEN' }, { key: 'dmPolicy', label: 'DM Policy', type: 'select', options: ['pairing', 'allowlist', 'open', 'disabled'] }, { key: 'allowFrom', label: 'Allowed User IDs', type: 'text', placeholder: '123456789' }],
  },
  {
    id: 'discord',
    name: 'Discord',
    emoji: '🎮',
    category: 'Chat Providers',
    description: 'Servers, channels, and DMs',
    actions: ['send message', 'receive message', 'manage channels', 'reactions'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'token', label: 'Bot Token', type: 'password', placeholder: 'Discord bot token', envVar: 'DISCORD_BOT_TOKEN' }, { key: 'groupPolicy', label: 'Group Policy', type: 'select', options: ['allowlist', 'open', 'disabled'] }, { key: 'guildId', label: 'Guild/Server ID', type: 'text', placeholder: 'Server ID' }],
  },
  {
    id: 'slack',
    name: 'Slack',
    emoji: '📋',
    category: 'Chat Providers',
    description: 'Workspace apps via Bolt',
    actions: ['send message', 'receive message', 'slash commands', 'blocks'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'botToken', label: 'Bot Token', type: 'password', placeholder: 'xoxb-...', envVar: 'SLACK_BOT_TOKEN' }, { key: 'appToken', label: 'App Token', type: 'password', placeholder: 'xapp-...', envVar: 'SLACK_APP_TOKEN' }, { key: 'groupPolicy', label: 'Group Policy', type: 'select', options: ['allowlist', 'open', 'disabled'] }],
  },
  {
    id: 'signal',
    name: 'Signal',
    emoji: '🔒',
    category: 'Chat Providers',
    description: 'Privacy-focused via signal-cli',
    actions: ['send message', 'receive message', 'send media'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'dmPolicy', label: 'DM Policy', type: 'select', options: ['pairing', 'allowlist', 'open', 'disabled'] }, { key: 'allowFrom', label: 'Allowed Numbers', type: 'text', placeholder: '+1234567890' }],
  },
  {
    id: 'imessage',
    name: 'iMessage',
    emoji: '🍎',
    category: 'Chat Providers',
    description: 'Via AppleScript bridge',
    actions: ['send message', 'receive message', 'send media'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'dmPolicy', label: 'DM Policy', type: 'select', options: ['pairing', 'allowlist', 'open'] }],
  },
  {
    id: 'imessage-bluebubbles',
    name: 'iMessage BlueBubbles',
    emoji: '🫧',
    category: 'Chat Providers',
    description: 'Via BlueBubbles server',
    actions: ['send message', 'receive message', 'group chat'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'serverUrl', label: 'Server URL', type: 'text', placeholder: 'http://localhost:1234' }, { key: 'password', label: 'Password', type: 'password', placeholder: 'BlueBubbles password' }],
  },
  {
    id: 'microsoft-teams',
    name: 'Microsoft Teams',
    emoji: '🏢',
    category: 'Chat Providers',
    description: 'Enterprise messaging',
    actions: ['send message', 'receive message', 'adaptive cards'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'appId', label: 'App ID', type: 'text', placeholder: 'Teams app ID' }, { key: 'appPassword', label: 'App Password', type: 'password', placeholder: 'Teams app password' }],
  },
  {
    id: 'nextcloud-talk',
    name: 'Nextcloud Talk',
    emoji: '☁️',
    category: 'Chat Providers',
    description: 'Self-hosted messaging',
    actions: ['send message', 'receive message', 'file sharing'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'serverUrl', label: 'Server URL', type: 'text', placeholder: 'https://cloud.example.com' }, { key: 'username', label: 'Username', type: 'text' }, { key: 'password', label: 'Password', type: 'password' }],
  },
  {
    id: 'matrix',
    name: 'Matrix',
    emoji: '🔗',
    category: 'Chat Providers',
    description: 'Decentralized protocol',
    actions: ['send message', 'receive message', 'rooms', 'encryption'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'homeserver', label: 'Homeserver', type: 'text', placeholder: 'https://matrix.org' }, { key: 'userId', label: 'User ID', type: 'text', placeholder: '@bot:matrix.org' }, { key: 'accessToken', label: 'Access Token', type: 'password' }],
  },
  {
    id: 'nostr',
    name: 'Nostr',
    emoji: '🌐',
    category: 'Chat Providers',
    description: 'Decentralized DMs',
    actions: ['send message', 'receive message', 'publish notes'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'privateKey', label: 'Private Key (nsec)', type: 'password' }, { key: 'relays', label: 'Relay URLs', type: 'text', placeholder: 'wss://relay.damus.io' }],
  },
  {
    id: 'tlon-messenger',
    name: 'Tlon Messenger',
    emoji: '🛸',
    category: 'Chat Providers',
    description: 'P2P messaging',
    actions: ['send message', 'receive message'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'shipUrl', label: 'Ship URL', type: 'text', placeholder: 'http://localhost:8080' }],
  },
  {
    id: 'zalo',
    name: 'Zalo',
    emoji: '🇻🇳',
    category: 'Chat Providers',
    description: 'Bot API',
    actions: ['send message', 'receive message', 'send media'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'appId', label: 'App ID', type: 'text' }, { key: 'secretKey', label: 'Secret Key', type: 'password' }],
  },
  {
    id: 'zalo-personal',
    name: 'Zalo Personal',
    emoji: '🇻🇳',
    category: 'Chat Providers',
    description: 'QR login',
    actions: ['send message', 'receive message'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },
  {
    id: 'webchat',
    name: 'WebChat',
    emoji: '🌍',
    category: 'Chat Providers',
    description: 'Browser UI',
    actions: ['send message', 'receive message', 'file upload'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'port', label: 'Port', type: 'text', placeholder: '18789' }],
  },
  // ── Productivity ─────────────────────────────────────────────────
  {
    id: 'apple-notes',
    name: 'Apple Notes',
    emoji: '📝',
    category: 'Productivity',
    description: 'Native macOS notes',
    actions: ['create note', 'search notes', 'append to note'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },
  {
    id: 'apple-reminders',
    name: 'Apple Reminders',
    emoji: '⏰',
    category: 'Productivity',
    description: 'Native macOS reminders',
    actions: ['create reminder', 'list reminders', 'complete reminder'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },
  {
    id: 'things-3',
    name: 'Things 3',
    emoji: '✅',
    category: 'Productivity',
    description: 'GTD task manager',
    actions: ['create task', 'list tasks', 'complete task', 'create project'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },
  {
    id: 'notion',
    name: 'Notion',
    emoji: '📓',
    category: 'Productivity',
    description: 'All-in-one workspace',
    actions: ['create page', 'query database', 'update page', 'search'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'secret_...' }, { key: 'databaseId', label: 'Database ID', type: 'text' }],
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    emoji: '💎',
    category: 'Productivity',
    description: 'Knowledge base and notes',
    actions: ['create note', 'search vault', 'link notes', 'read note'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'vaultPath', label: 'Vault Path', type: 'text', placeholder: '~/Documents/Obsidian' }],
  },
  {
    id: 'bear-notes',
    name: 'Bear Notes',
    emoji: '🐻',
    category: 'Productivity',
    description: 'Markdown notes for Apple',
    actions: ['create note', 'search notes', 'tag notes'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },
  {
    id: 'trello',
    name: 'Trello',
    emoji: '📌',
    category: 'Productivity',
    description: 'Kanban boards',
    actions: ['create card', 'move card', 'list boards', 'add comment'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'apiKey', label: 'API Key', type: 'password' }, { key: 'token', label: 'Token', type: 'password' }, { key: 'boardId', label: 'Board ID', type: 'text' }],
  },
  {
    id: 'github',
    name: 'GitHub',
    emoji: '<svg width="20" height="20" viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;"><path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/></svg>',
    category: 'Productivity',
    description: 'Code hosting and collaboration',
    actions: ['create issue', 'create PR', 'list repos', 'search code'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'username', label: 'GitHub Username', type: 'text', placeholder: 'your-github-username' }, { key: 'token', label: 'Personal Access Token', type: 'password', placeholder: 'ghp_...' }, { key: 'owner', label: 'Owner/Org', type: 'text' }, { key: 'repo', label: 'Default Repository', type: 'text' }],
  },
  // ── Music & Audio ────────────────────────────────────────────────
  {
    id: 'spotify',
    name: 'Spotify',
    emoji: '🎵',
    category: 'Music & Audio',
    description: 'Music streaming control',
    actions: ['play track', 'pause', 'skip', 'search', 'get queue'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'clientId', label: 'Client ID', type: 'text' }, { key: 'clientSecret', label: 'Client Secret', type: 'password' }],
  },
  {
    id: 'sonos',
    name: 'Sonos',
    emoji: '🔊',
    category: 'Music & Audio',
    description: 'Multi-room audio',
    actions: ['play', 'pause', 'volume', 'group rooms'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'roomName', label: 'Room Name', type: 'text', placeholder: 'Living Room' }],
  },
  {
    id: 'shazam',
    name: 'Shazam',
    emoji: '🎤',
    category: 'Music & Audio',
    description: 'Music recognition',
    actions: ['identify song', 'get lyrics'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },

  // ── Smart Home ──────────────────────────────────────────────────
  {
    id: 'philips-hue',
    name: 'Philips Hue',
    emoji: '💡',
    category: 'Smart Home',
    description: 'Smart lighting control',
    actions: ['set light', 'set scene', 'list rooms', 'toggle'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'bridgeIp', label: 'Bridge IP', type: 'text', placeholder: '192.168.1.x' }, { key: 'username', label: 'API Username', type: 'text' }],
  },
  {
    id: '8sleep',
    name: '8Sleep',
    emoji: '🛏️',
    category: 'Smart Home',
    description: 'Smart mattress control',
    actions: ['set temperature', 'get status', 'set schedule'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'email', label: 'Email', type: 'text' }, { key: 'password', label: 'Password', type: 'password' }],
  },
  {
    id: 'home-assistant',
    name: 'Home Assistant',
    emoji: '🏠',
    category: 'Smart Home',
    description: 'Open-source home automation',
    actions: ['call service', 'get state', 'trigger automation'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'url', label: 'HA URL', type: 'text', placeholder: 'http://homeassistant.local:8123' }, { key: 'token', label: 'Long-Lived Token', type: 'password' }],
  },
  // ── Tools & Automation ───────────────────────────────────────────
  {
    id: 'browser',
    name: 'Browser',
    emoji: '🌐',
    category: 'Tools & Automation',
    description: 'Chrome control',
    actions: ['open URL', 'screenshot', 'click element', 'extract text'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'headless', label: 'Headless Mode', type: 'toggle' }],
  },
  {
    id: 'canvas',
    name: 'Canvas',
    emoji: '🎨',
    category: 'Tools & Automation',
    description: 'Visual workspace',
    actions: ['create canvas', 'add element', 'export'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },
  {
    id: 'voice',
    name: 'Voice',
    emoji: '🎙️',
    category: 'Tools & Automation',
    description: 'Wake word and speech',
    actions: ['transcribe', 'speak', 'wake word'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'wakeWord', label: 'Wake Word', type: 'text', placeholder: 'hey neuronest' }],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    emoji: '📧',
    category: 'Tools & Automation',
    description: 'Pub/sub email triggers',
    actions: ['send email', 'read inbox', 'search', 'watch'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'email', label: 'Gmail Address', type: 'text' }, { key: 'appPassword', label: 'App Password', type: 'password' }],
  },
  {
    id: 'cron',
    name: 'Cron',
    emoji: '⏱️',
    category: 'Tools & Automation',
    description: 'Scheduled tasks',
    actions: ['create schedule', 'list schedules', 'delete schedule'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    emoji: '🪝',
    category: 'Tools & Automation',
    description: 'External triggers',
    actions: ['create webhook', 'list webhooks', 'trigger'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'port', label: 'Webhook Port', type: 'text', placeholder: '18790' }, { key: 'secret', label: 'Webhook Secret', type: 'password' }],
  },
  {
    id: '1password',
    name: '1Password',
    emoji: '🔑',
    category: 'Tools & Automation',
    description: 'Credential management',
    actions: ['get credential', 'list vaults', 'create item'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'serviceAccountToken', label: 'Service Account Token', type: 'password' }],
  },
  {
    id: 'weather',
    name: 'Weather',
    emoji: '🌤️',
    category: 'Tools & Automation',
    description: 'Weather data',
    actions: ['get forecast', 'get current', 'get alerts'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'apiKey', label: 'OpenWeather API Key', type: 'password' }, { key: 'location', label: 'Default Location', type: 'text', placeholder: 'San Francisco, CA' }],
  },
  // ── Media & Creative ─────────────────────────────────────────────
  {
    id: 'image-gen',
    name: 'Image Gen',
    emoji: '🖼️',
    category: 'Media & Creative',
    description: 'AI image generation',
    actions: ['generate image', 'edit image', 'upscale'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'provider', label: 'Provider', type: 'select', options: ['dall-e', 'stable-diffusion', 'midjourney'] }],
  },
  {
    id: 'gif-search',
    name: 'GIF Search',
    emoji: '🎞️',
    category: 'Media & Creative',
    description: 'GIF discovery',
    actions: ['search GIFs', 'trending', 'random'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'apiKey', label: 'Giphy API Key', type: 'password' }],
  },
  {
    id: 'peekaboo',
    name: 'Peekaboo',
    emoji: '👀',
    category: 'Media & Creative',
    description: 'Screen capture',
    actions: ['screenshot', 'record', 'OCR'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },
  {
    id: 'camera',
    name: 'Camera',
    emoji: '📷',
    category: 'Media & Creative',
    description: 'Camera capture',
    actions: ['capture photo', 'record video', 'scan QR'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }],
  },

  // ── Social ──────────────────────────────────────────────────────
  {
    id: 'twitter-x',
    name: 'Twitter/X',
    emoji: '🐦',
    category: 'Social',
    description: 'Social media posting',
    actions: ['post tweet', 'reply', 'search', 'get timeline'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'apiKey', label: 'API Key', type: 'password' }, { key: 'apiSecret', label: 'API Secret', type: 'password' }, { key: 'accessToken', label: 'Access Token', type: 'password' }, { key: 'accessSecret', label: 'Access Token Secret', type: 'password' }],
  },
  {
    id: 'email',
    name: 'Email',
    emoji: '✉️',
    category: 'Social',
    description: 'Email communication',
    actions: ['send email', 'read inbox', 'search', 'draft'],
    configFields: [{ key: 'enabled', label: 'Enabled', type: 'toggle' }, { key: 'smtpHost', label: 'SMTP Host', type: 'text', placeholder: 'smtp.gmail.com' }, { key: 'smtpPort', label: 'SMTP Port', type: 'text', placeholder: '587' }, { key: 'username', label: 'Username', type: 'text' }, { key: 'password', label: 'Password', type: 'password' }],
  },
];

// ── Lookup helpers ──────────────────────────────────────────────────

export function getIntegrationsByCategory(category: string): Integration[] {
  return INTEGRATIONS.filter((i) => i.category === category);
}

export function getIntegrationById(id: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
