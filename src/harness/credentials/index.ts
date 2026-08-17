/**
 * Credentials — Secret-reference storage and typed settings forms.
 *
 * Stores credential references only; resolves values at operation boundaries;
 * exposes non-secret availability metadata; validates complete external revisions
 * before commit; and returns typed StorageForm values rather than raw handles.
 *
 * Requirements: 22.1–22.8
 */

export * from './schemas';
export * from './credential-service';
