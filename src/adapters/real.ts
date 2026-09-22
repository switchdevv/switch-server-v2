import type { Env } from '../config/env.js';
import type { Logger } from '../observability/logger.js';
import type {
  DistancePort,
  MailPort,
  Ports,
  PushPort,
  RealtimePort,
  SmsPort,
} from '../ports/index.js';
import { createFakePorts } from './fakes.js';

/** FCM HTTP v1 through firebase-admin, same `messaging().send(message)` call as legacy. */
async function createFcm(env: Env): Promise<PushPort> {
  if (!env.FIREBASE_SERVICE_ACCOUNT)
    throw new Error('FIREBASE_SERVICE_ACCOUNT is required for PUSH_DRIVER=fcm/allowlist');
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');
  const app = initializeApp(
    { credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) as object) },
    'switch-push',
  );
  const messaging = getMessaging(app);
  return {
    async send(message) {
      await messaging.send(message as Parameters<typeof messaging.send>[0]);
    },
  };
}

async function createPusher(env: Env): Promise<RealtimePort> {
  const { default: Pusher } = await import('pusher');
  // Legacy constructs Pusher with whatever is configured (the repo's configs.js has blank
  // credentials) and every trigger then fails silently. Keep that: a construction error becomes a
  // rejected trigger, never a boot failure.
  let client: InstanceType<typeof Pusher> | Error;
  try {
    client = new Pusher({
      appId: env.PUSHER_APP_ID,
      key: env.PUSHER_KEY,
      secret: env.PUSHER_SECRET ?? '',
      cluster: env.PUSHER_CLUSTER,
      useTLS: true,
    });
  } catch (error) {
    client = error instanceof Error ? error : new Error(String(error));
  }
  return {
    async trigger(channel, event, payload) {
      if (client instanceof Error) throw client;
      await client.trigger(channel, event, payload);
    },
    authorizeChannel(socketId, channel) {
      if (client instanceof Error) throw client;
      return { auth: client.authorizeChannel(socketId, channel).auth };
    },
  };
}

/** SMS Algérie JSON API: form-encoded POST, exactly the fields legacy sends. */
function createSmsAlgerie(env: Env): SmsPort {
  return {
    async send(to, message) {
      const params = new URLSearchParams();
      params.set('function', 'sms_send');
      params.set('apikey', env.SMS_API_KEY ?? '');
      params.set('userkey', env.SMS_USER_KEY ?? '');
      params.set('to', to);
      params.set('message', message);
      const res = await fetch(env.SMS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      return res.json();
    },
  };
}

/**
 * Google Distance Matrix. Byte-identical query to legacy's `google-distance-matrix` 1.1.1
 * (including the empty `avoid=`), and the same error text on a non-200 response.
 */
export function distanceMatrixUrl(key: string, origin: string, destination: string): string {
  const qs = new URLSearchParams([
    ['origins', origin],
    ['destinations', destination],
    ['mode', 'driving'],
    ['units', 'metric'],
    ['language', 'en'],
    ['avoid', ''],
    ['key', key],
  ]);
  return `https://maps.googleapis.com/maps/api/distancematrix/json?${qs.toString()}`;
}

function createGoogleDistance(env: Env): DistancePort {
  return {
    async matrix(origin, destination) {
      const res = await fetch(
        distanceMatrixUrl(env.GOOGLE_MAPS_API_KEY ?? '', origin, destination),
      );
      const body = await res.text();
      if (res.status !== 200) throw new Error('Google API request error: ' + body);
      return JSON.parse(body) as unknown;
    },
  };
}

async function createSendgrid(env: Env): Promise<MailPort> {
  const { default: sgMail } = await import('@sendgrid/mail');
  sgMail.setApiKey(env.SENDGRID_API_KEY ?? '');
  return {
    async sendMail({ to, subject, text }) {
      const [response] = await sgMail.send({ from: env.MAIL_FROM, to, subject, text });
      return response;
    },
  };
}

/** Builds the port set for `env`. Fakes log their effects so local runs show what would be sent. */
export async function createPorts(env: Env, logger: Logger): Promise<Ports> {
  // Locally the data is synthetic, so show what would have been sent (OTP texts, email links,
  // push payloads). Elsewhere (staging allowlists, the rehearsal on a prod copy) the arguments
  // carry real people's data and stay redacted (`effect.args`).
  const fakes = createFakePorts((effect) =>
    env.APP_ENV === 'local'
      ? logger.info({ port: effect.port, call: effect.call, args: effect.args }, 'fake port call')
      : logger.info({ effect }, 'fake port call'),
  );
  const inList = (list: string[], value: unknown) =>
    typeof value === 'string' && list.includes(value);

  let push: PushPort = fakes.push;
  if (env.PUSH_DRIVER === 'fcm') push = await createFcm(env);
  if (env.PUSH_DRIVER === 'allowlist') {
    const fcm = await createFcm(env);
    push = {
      async send(message) {
        if (inList(env.PUSH_TOKEN_ALLOWLIST, message.token)) return fcm.send(message);
        return fakes.push.send(message);
      },
    };
  }

  let sms: SmsPort = fakes.sms;
  if (env.SMS_DRIVER === 'sms-algerie') sms = createSmsAlgerie(env);
  if (env.SMS_DRIVER === 'allowlist') {
    const real = createSmsAlgerie(env);
    sms = {
      send: (to, message) =>
        inList(env.SMS_PHONE_ALLOWLIST, to) ? real.send(to, message) : fakes.sms.send(to, message),
    };
  }

  let mail: MailPort = fakes.mail;
  if (env.MAIL_DRIVER === 'sendgrid') mail = await createSendgrid(env);
  if (env.MAIL_DRIVER === 'allowlist') {
    const real = await createSendgrid(env);
    mail = {
      sendMail: (o) =>
        inList(env.MAIL_ALLOWLIST, o.to) ? real.sendMail(o) : fakes.mail.sendMail(o),
    };
  }

  return {
    push,
    sms,
    mail,
    realtime: env.REALTIME_DRIVER === 'pusher' ? await createPusher(env) : fakes.realtime,
    distance: env.DISTANCE_DRIVER === 'google' ? createGoogleDistance(env) : fakes.distance,
  };
}
