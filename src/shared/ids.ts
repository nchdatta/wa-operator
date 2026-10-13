import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

/** Sortable unique ID (ULID). Used for internal IDs and `biz_opaque_callback_data`. */
export function newId(): string {
  return next();
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
