// ─── Weather Adapter ────────────────────────────────────────────
// Full ChannelAdapter implementation for weather data queries via
// OpenWeatherMap API. Supports current conditions, multi-day forecasts,
// and location-specific queries. Bidirectional: accepts natural language
// weather commands inbound and returns weather data outbound.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.5, REQ 10.1

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Weather adapter configuration.
 * Requires an OpenWeatherMap API key and an optional default location.
 */
export const WeatherConfigSchema = z.object({
  /** OpenWeatherMap API key */
  apiKey: z.string().min(1),
  /** Default location for queries without a specified city */
  defaultLocation: z.string().optional().default('New York'),
  /** Temperature units: standard, metric, or imperial */
  units: z.enum(['standard', 'metric', 'imperial']).optional().default('metric'),
});

export type WeatherConfig = z.infer<typeof WeatherConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported weather command actions */
type WeatherAction = 'current' | 'forecast';

/** Parsed inbound command structure */
interface WeatherCommand {
  action: WeatherAction;
  /** City/location to query (falls back to defaultLocation) */
  location?: string;
  /** Number of forecast days (for forecast action, default 5) */
  days?: number;
}

/** Current weather response shape */
interface CurrentWeatherResult {
  location: string;
  temperature: number;
  feelsLike: number;
  humidity: number;
  description: string;
  windSpeed: number;
  visibility: number;
  pressure: number;
  units: string;
  icon: string;
  timestamp: number;
}

/** Forecast entry */
interface ForecastEntry {
  date: string;
  tempMin: number;
  tempMax: number;
  description: string;
  humidity: number;
  windSpeed: number;
  icon: string;
}

/** Multi-day forecast response shape */
interface ForecastResult {
  location: string;
  days: number;
  units: string;
  forecast: ForecastEntry[];
}

// ─── Weather Adapter ────────────────────────────────────────────

export class WeatherAdapter extends BaseChannelAdapter {
  readonly channelId = 'weather';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Weather',
    emoji: '🌤️',
    description: 'Weather forecasts and conditions',
    actionTags: ['current weather', 'forecast', 'weather in city'],
    sortOrder: 1050,
  };

  readonly configSchema = WeatherConfigSchema;

  private config: WeatherConfig | null = null;

  /** Base URL for the OpenWeatherMap API */
  private readonly apiBase = 'https://api.openweathermap.org';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Weather adapter requires an OpenWeatherMap API key.\n\n' +
        'Setup steps:\n' +
        '1. Sign up at https://openweathermap.org/api\n' +
        '2. Generate an API key from your account dashboard\n' +
        '3. Provide the key in the adapter configuration\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify API access with a lightweight test request
    try {
      const testResult = await this.verifyApiAccess();
      if (!testResult.success) {
        return testResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to OpenWeatherMap API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    this.connected = true;
    this.log('info', 'Connected', { channelId: 'weather', defaultLocation: this.config.defaultLocation });

    return {
      success: true,
      message: `Weather adapter connected (default location: ${this.config.defaultLocation})`,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Weather adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      return {
        success: false,
        message:
          'Could not parse weather command. Supported: "current weather", "forecast 5-day", "weather in <city>".',
      };
    }

    // Resolve location — use command-specified or fall back to default
    const location = command.location || this.config.defaultLocation;

    // Execute the parsed command
    try {
      switch (command.action) {
        case 'current':
          return this.getCurrentWeather(location);

        case 'forecast':
          return this.getForecast(location, command.days ?? 5);

        default:
          return { success: false, message: `Unknown weather action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `Weather operation failed: ${errMsg}` };
    }
  }

  // ─── Private: API verification ──────────────────────────────────

  /**
   * Verify API access by making a lightweight current-weather request
   * for the default location. Confirms the API key is valid.
   */
  private async verifyApiAccess(): Promise<ConnectResult> {
    const response = await this.apiFetch('/data/2.5/weather', {
      q: this.config!.defaultLocation,
      units: this.config!.units,
    });

    if (!response.ok) {
      if (response.status === 401) {
        return this.authFailed(
          'Invalid OpenWeatherMap API key. Please verify your key at https://openweathermap.org/api_keys',
        );
      }
      if (response.status === 404) {
        return {
          success: false,
          message: `Default location "${this.config!.defaultLocation}" not found. Please check the location name.`,
          error: { code: 'CONFIG_INVALID', message: 'Default location not found' },
        };
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `OpenWeatherMap API verification failed (${response.status}): ${errorBody}`,
        error: { code: 'PROVIDER_ERROR', message: errorBody },
      };
    }

    return { success: true, message: 'API access verified' };
  }

  // ─── Private: Current weather ───────────────────────────────────

  /**
   * Fetch current weather conditions for a location.
   * Returns temperature, humidity, wind, description, etc.
   * @satisfies REQ 10.1
   */
  private async getCurrentWeather(location: string): Promise<SendResult> {
    const response = await this.apiFetch('/data/2.5/weather', {
      q: location,
      units: this.config!.units,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, message: `Location "${location}" not found.` };
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `Failed to fetch current weather (${response.status}): ${errorBody}`,
      };
    }

    const data = (await response.json()) as {
      name?: string;
      main?: {
        temp?: number;
        feels_like?: number;
        humidity?: number;
        pressure?: number;
      };
      weather?: Array<{ description?: string; icon?: string }>;
      wind?: { speed?: number };
      visibility?: number;
      dt?: number;
    };

    const result: CurrentWeatherResult = {
      location: data.name ?? location,
      temperature: data.main?.temp ?? 0,
      feelsLike: data.main?.feels_like ?? 0,
      humidity: data.main?.humidity ?? 0,
      description: data.weather?.[0]?.description ?? 'unknown',
      windSpeed: data.wind?.speed ?? 0,
      visibility: data.visibility ?? 0,
      pressure: data.main?.pressure ?? 0,
      units: this.config!.units,
      icon: data.weather?.[0]?.icon ?? '',
      timestamp: data.dt ?? Math.floor(Date.now() / 1000),
    };

    // Emit inbound so the AI pipeline can format a user-friendly response
    this.emitInbound('weather-query', JSON.stringify(result), 'text');

    return {
      success: true,
      message: JSON.stringify(result, null, 2),
    };
  }

  // ─── Private: Forecast ──────────────────────────────────────────

  /**
   * Fetch multi-day weather forecast for a location.
   * Uses the 5-day/3-hour forecast endpoint, aggregated to daily summaries.
   * @satisfies REQ 10.1
   */
  private async getForecast(location: string, days: number): Promise<SendResult> {
    // OpenWeatherMap free tier provides 5-day forecast in 3-hour intervals
    const clampedDays = Math.min(Math.max(days, 1), 5);

    const response = await this.apiFetch('/data/2.5/forecast', {
      q: location,
      units: this.config!.units,
      cnt: String(clampedDays * 8), // 8 intervals per day (3-hour slots)
    });

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, message: `Location "${location}" not found.` };
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `Failed to fetch forecast (${response.status}): ${errorBody}`,
      };
    }

    const data = (await response.json()) as {
      city?: { name?: string };
      list?: Array<{
        dt?: number;
        dt_txt?: string;
        main?: { temp_min?: number; temp_max?: number; humidity?: number };
        weather?: Array<{ description?: string; icon?: string }>;
        wind?: { speed?: number };
      }>;
    };

    // Aggregate 3-hour intervals into daily summaries
    const dailyMap = new Map<
      string,
      { temps: number[]; maxTemps: number[]; descriptions: string[]; humidities: number[]; winds: number[]; icons: string[] }
    >();

    for (const entry of data.list ?? []) {
      const dateStr = (entry.dt_txt ?? '').split(' ')[0] ?? '';
      if (!dateStr) continue;

      if (!dailyMap.has(dateStr)) {
        dailyMap.set(dateStr, { temps: [], maxTemps: [], descriptions: [], humidities: [], winds: [], icons: [] });
      }

      const day = dailyMap.get(dateStr)!;
      if (entry.main?.temp_min !== undefined) day.temps.push(entry.main.temp_min);
      if (entry.main?.temp_max !== undefined) day.maxTemps.push(entry.main.temp_max);
      if (entry.weather?.[0]?.description) day.descriptions.push(entry.weather[0].description);
      if (entry.main?.humidity !== undefined) day.humidities.push(entry.main.humidity);
      if (entry.wind?.speed !== undefined) day.winds.push(entry.wind.speed);
      if (entry.weather?.[0]?.icon) day.icons.push(entry.weather[0].icon);
    }

    const forecast: ForecastEntry[] = [];
    for (const [date, day] of dailyMap) {
      if (forecast.length >= clampedDays) break;
      forecast.push({
        date,
        tempMin: Math.min(...day.temps),
        tempMax: Math.max(...day.maxTemps),
        description: this.mostFrequent(day.descriptions) ?? 'unknown',
        humidity: Math.round(day.humidities.reduce((a, b) => a + b, 0) / day.humidities.length),
        windSpeed: Math.round((day.winds.reduce((a, b) => a + b, 0) / day.winds.length) * 10) / 10,
        icon: this.mostFrequent(day.icons) ?? '',
      });
    }

    const result: ForecastResult = {
      location: data.city?.name ?? location,
      days: clampedDays,
      units: this.config!.units,
      forecast,
    };

    // Emit inbound so the AI pipeline can format a user-friendly response
    this.emitInbound('weather-query', JSON.stringify(result), 'text');

    return {
      success: true,
      message: JSON.stringify(result, null, 2),
    };
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured weather command.
   * Supports JSON-format commands and natural language patterns:
   * - "current weather" / "current weather in London"
   * - "forecast 5-day" / "forecast 3-day in Tokyo"
   * - "weather in <city>"
   */
  parseCommand(content: string): WeatherCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as WeatherCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Pattern: "forecast <N>-day" with optional "in <location>"
    const forecastMatch = content.match(
      /^forecast\s+(\d+)[- ]?days?(?:\s+(?:in|for)\s+(.+))?$/i,
    );
    if (forecastMatch) {
      return {
        action: 'forecast',
        days: parseInt(forecastMatch[1]!, 10),
        location: forecastMatch[2]?.trim(),
      };
    }

    // Pattern: "forecast in <location>"
    const forecastLocationMatch = content.match(/^forecast(?:\s+(?:in|for)\s+(.+))?$/i);
    if (forecastLocationMatch) {
      return {
        action: 'forecast',
        location: forecastLocationMatch[1]?.trim(),
      };
    }

    // Pattern: "current weather" / "current conditions" with optional "in <location>"
    const currentMatch = content.match(
      /^(?:current\s+)?(?:weather|conditions|temperature)(?:\s+(?:in|for)\s+(.+))?$/i,
    );
    if (currentMatch) {
      return {
        action: 'current',
        location: currentMatch[1]?.trim(),
      };
    }

    // Pattern: "weather in <location>"
    const weatherInMatch = content.match(/^weather\s+(?:in|for)\s+(.+)$/i);
    if (weatherInMatch) {
      return {
        action: 'current',
        location: weatherInMatch[1]!.trim(),
      };
    }

    // Pattern: "what's the weather in <location>"
    const whatsWeatherMatch = content.match(
      /^(?:what(?:'s|s| is)?\s+the\s+)?weather\s+(?:in|for|at)\s+(.+)$/i,
    );
    if (whatsWeatherMatch) {
      return {
        action: 'current',
        location: whatsWeatherMatch[1]!.trim(),
      };
    }

    // Pattern: just a city name with "weather" keyword somewhere
    if (/weather/i.test(lower)) {
      const cityPart = content.replace(/weather/gi, '').trim();
      if (cityPart.length > 0) {
        return {
          action: 'current',
          location: cityPart,
        };
      }
      return { action: 'current' };
    }

    // If nothing matched, return null
    return null;
  }

  // ─── Private: Helpers ─────────────────────────────────────────

  /**
   * Return the most frequently occurring element in an array.
   */
  private mostFrequent(arr: string[]): string | undefined {
    if (arr.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const item of arr) {
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    let maxCount = 0;
    let maxItem: string | undefined;
    for (const [item, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        maxItem = item;
      }
    }
    return maxItem;
  }

  // ─── Private: API fetch helper ──────────────────────────────────

  /**
   * Make an authenticated request to the OpenWeatherMap API.
   * Automatically attaches the appid query parameter.
   */
  private async apiFetch(
    path: string,
    params: Record<string, string> = {},
  ): Promise<Response> {
    if (!this.config) {
      throw new Error('Weather adapter is not configured');
    }

    const url = new URL(path, this.apiBase);
    url.searchParams.set('appid', this.config.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  }
}
