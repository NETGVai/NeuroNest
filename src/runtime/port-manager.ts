import * as net from 'net';

/**
 * Manages host port allocation to avoid conflicts across concurrent runtimes.
 * Uses Node.js built-in `net` module to check OS-level port availability.
 */
export class PortManager {
  private readonly allocatedPorts = new Set<number>();
  private readonly DEFAULT_BASE_PORT = 3000;

  /**
   * Find and reserve the next available port starting from basePort.
   * Checks both the internal registry and actual OS port availability
   * by attempting to bind a temporary net.Server on the port.
   */
  async allocate(basePort?: number): Promise<number> {
    let port = basePort ?? this.DEFAULT_BASE_PORT;

    while (true) {
      if (!this.allocatedPorts.has(port) && (await this.isPortAvailable(port))) {
        this.allocatedPorts.add(port);
        return port;
      }
      port++;
    }
  }

  /**
   * Release a previously allocated port so it can be reused.
   */
  release(port: number): void {
    this.allocatedPorts.delete(port);
  }

  /**
   * Get all currently allocated ports as a Map of port string → port number.
   */
  getAllocations(): Map<string, number> {
    const map = new Map<string, number>();
    for (const port of this.allocatedPorts) {
      map.set(String(port), port);
    }
    return map;
  }

  /**
   * Check if a port is available at the OS level by attempting to bind
   * a temporary net.Server on it.
   */
  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => {
        resolve(false);
      });
      server.listen(port, '127.0.0.1', () => {
        server.close(() => {
          resolve(true);
        });
      });
    });
  }
}
