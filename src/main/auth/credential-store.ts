/**
 * Credential store interface for WebAuthn credential persistence.
 * The actual SQLite implementation will come in Task 8.
 */

export interface StoredCredential {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string; // base64url-encoded
  counter: number;
  deviceName: string | null;
  transports: string | null; // JSON array of transport strings
  rpId: string;
  createdAt: string;
}

export interface CredentialStore {
  /** Get all credentials for a user, optionally filtered by RP ID */
  getCredentialsByUserId(userId: string, rpId?: string): StoredCredential[];

  /** Get all credentials for a given RP ID */
  getCredentialsByRpId(rpId: string): StoredCredential[];

  /** Save a new credential */
  saveCredential(credential: StoredCredential): void;

  /** Update the counter for a credential after successful authentication */
  updateCounter(credentialId: string, newCounter: number): void;

  /** Store a challenge for a user (used during WebAuthn ceremonies) */
  storeChallenge(userId: string, challenge: string): void;

  /** Get and remove the stored challenge for a user */
  getChallenge(userId: string): string | null;

  /** Save user profile info (firstName, lastName, email, appId, deviceId) */
  saveUserProfile(profile: UserProfile): void;

  /** Get user profile by email */
  getUserProfile(email: string): UserProfile | null;
}

export interface UserProfile {
  email: string;
  firstName: string;
  lastName: string;
  appId: string;
  deviceId: string;
  createdAt: string;
}
