/**
 * Ports: every side effect the cloud code has on the outside world goes through one of these.
 * Real adapters live in `src/adapters/*`; `src/adapters/fakes.ts` records instead of sending.
 */

/** The exact object legacy passes to `admin.messaging().send()`. */
export interface FcmMessage {
  android: { priority: 'high'; notification?: { tag: string } };
  apns?: { headers: Record<string, string> };
  notification?: { title: string; body?: string; imageUrl?: string };
  data?: unknown;
  token?: string;
  topic?: string;
  condition?: string;
}

export interface PushPort {
  /** Rejects on failure. Callers decide whether to swallow (legacy always does). */
  send(message: FcmMessage): Promise<void>;
}

export interface RealtimePort {
  trigger(channel: string, event: string, payload: unknown): Promise<void>;
  /**
   * Signs a browser's subscription to a private channel (Pusher's `auth` string). Throws when the
   * socket id or channel name is malformed. The caller decides who may subscribe.
   */
  authorizeChannel(socketId: string, channel: string): { auth: string };
}

export interface SmsPort {
  /** Sends one SMS and resolves with the provider's parsed JSON response. */
  send(to: string, message: string): Promise<unknown>;
}

export interface DistancePort {
  /** Google Distance Matrix, one origin and one destination, `lat,lng` strings. Resolves the raw JSON. */
  matrix(origin: string, destination: string): Promise<unknown>;
}

/** Parse Server email adapter contract (the only method legacy's adapter implemented). */
export interface MailPort {
  sendMail(options: { to: string; subject: string; text: string }): Promise<unknown>;
}

export interface Ports {
  push: PushPort;
  realtime: RealtimePort;
  sms: SmsPort;
  distance: DistancePort;
  mail: MailPort;
}
