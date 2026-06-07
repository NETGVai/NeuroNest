/**
 * WhatsApp Channel Module — public API.
 */

export { WhatsAppClient, type NormalizedMessage, type WAStatus } from './WhatsAppClient';
export { WhatsAppAdapter } from './WhatsAppAdapter';
export { getAuthDir, clearAuth, hasAuth } from './AuthStore';
