import { randomBytes, randomInt } from 'node:crypto';
import type { Random } from '../cloud/context.js';

/** The production `Random`. Tests inject a deterministic one. */
export const cryptoRandom: Random = {
  // D-10: always exactly 4 digits (legacy's Math.random slice could repeat patterns).
  otp: () => String(randomInt(0, 10000)).padStart(4, '0'),
  // Legacy `Math.random().toString().slice(-8)`; only de-duplicates staff notifications.
  notifId: () => Math.random().toString().slice(-8),
  // D-17: 8 random base-36 chars from crypto (legacy: Math.random, sometimes shorter). The user
  // never sees it; it only has to be unguessable.
  password: () => Array.from(randomBytes(8), (byte) => (byte % 36).toString(36)).join(''),
};
