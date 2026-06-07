/**
 * Centralized logger that respects NEURONEST_DEBUG and NODE_ENV.
 *
 * Usage:
 *   import { logger } from '../utils/logger';
 *
 *   // Single message
 *   logger.info('App started');
 *
 *   // Message + structured data (like the existing event-bus pattern)
 *   logger.debug('Event published', { eventId: '123', topic: 'foo' });
 *
 *   // Message + multiple positional args (printf-style)
 *   logger.warn('Voice', 'Model load failed:', err);
 *
 * Levels:
 *   - debug: detailed traces, only in dev or when NEURONEST_DEBUG=1
 *   - info:  important state changes, always shown
 *   - warn:  recoverable issues, always shown
 *   - error: unrecoverable issues, always shown
 *
 * In production (NODE_ENV=production) without NEURONEST_DEBUG=1,
 * only info/warn/error are emitted.
 */

const isProduction = process.env.NODE_ENV === 'production';
const isDebugEnabled = !isProduction || process.env.NEURONEST_DEBUG === '1' || process.env.NEURONEST_DEBUG === 'true';

function emit(level: 'log' | 'warn' | 'error', message: string, ...args: any[]): void {
  if (args.length > 0) {
    (console[level] as (...a: any[]) => void)(message, ...args);
  } else {
    (console[level] as (...a: any[]) => void)(message);
  }
}

export const logger = {
  debug(message: string, ...args: any[]): void {
    if (!isDebugEnabled) return;
    emit('log', message, ...args);
  },

  info(message: string, ...args: any[]): void {
    emit('log', message, ...args);
  },

  warn(message: string, ...args: any[]): void {
    emit('warn', message, ...args);
  },

  error(message: string, ...args: any[]): void {
    emit('error', message, ...args);
  },

  /** Whether debug logs are currently being emitted. Useful for guarding expensive log payloads. */
  isDebug(): boolean {
    return isDebugEnabled;
  },
};
