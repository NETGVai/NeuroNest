import { app } from 'electron';

const PROTOCOL = 'neuronest';

export class DeepLinkHandler {
  private authTokenCallback: ((token: string) => void) | null = null;

  /**
   * Register the neuronest:// protocol as the default handler.
   * On macOS, listens for the 'open-url' event to receive deep links.
   * On Windows/Linux, listens for the 'second-instance' event since deep links
   * are passed as command-line arguments to the existing instance.
   */
  register(): void {
    app.setAsDefaultProtocolClient(PROTOCOL);

    // macOS: deep links arrive via the 'open-url' event
    app.on('open-url', (_event, url) => {
      this.handleUrl(url);
    });

    // Windows/Linux: deep links arrive via 'second-instance' event
    // The URL is passed as the last argument in the argv array
    app.on('second-instance', (_event, argv) => {
      // On Windows, the deep link URL is typically the last argument
      for (const arg of argv) {
        if (arg.startsWith(PROTOCOL + '://')) {
          this.handleUrl(arg);
          break;
        }
      }
    });

    // Also handle the case where the app was launched with a deep link URL (cold start on Windows)
    if (process.platform === 'win32' || process.platform === 'linux') {
      const launchUrl = process.argv.find(arg => arg.startsWith(PROTOCOL + '://'));
      if (launchUrl) {
        // Defer handling until the app is ready and callbacks are registered
        app.whenReady().then(() => {
          setTimeout(() => this.handleUrl(launchUrl), 500);
        });
      }
    }
  }

  /**
   * Parse an incoming deep link URL and extract the path and token query parameter.
   * If the URL contains a valid auth token, invokes the registered callback.
   * Malformed URLs are logged and discarded.
   */
  handleUrl(url: string): { path: string; token?: string } | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      console.warn('[DeepLinkHandler] Malformed URL, ignoring:', url);
      return null;
    }

    if (parsed.protocol !== `${PROTOCOL}:`) {
      console.warn('[DeepLinkHandler] Unknown protocol, ignoring:', parsed.protocol);
      return null;
    }

    const urlPath = parsed.hostname || parsed.pathname.replace(/^\/+/, '');
    const token = parsed.searchParams.get('token') ?? undefined;

    const result: { path: string; token?: string } = { path: urlPath };
    if (token) {
      result.token = token;
    }

    if (urlPath === 'auth' && token && this.authTokenCallback) {
      this.authTokenCallback(token);
    }

    return result;
  }

  /**
   * Set a callback to be invoked when a valid neuronest://auth?token=<JWT> URL is received.
   */
  onAuthToken(callback: (token: string) => void): void {
    this.authTokenCallback = callback;
  }
}
