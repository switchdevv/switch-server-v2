import { languageOf, messagesFor, type Messages } from '../domain/i18n.js';
import type { FcmMessage } from '../ports/index.js';
import type { CloudDeps, ParseObject } from './context.js';
import { CLOUD_ERRORS } from './errors.js';

export interface PushInput {
  title?: unknown;
  body?: unknown;
  token?: unknown;
  topic?: unknown;
  condition?: unknown;
  data?: unknown;
  imageUrl?: unknown;
  /** Tray entry id: a later push with the same tag replaces the shown one instead of stacking. */
  tag?: string;
}

/** Builds the FCM message exactly like legacy `sendPushNotification` (cloud/push/push.js). */
export function buildFcmMessage({
  title,
  body,
  token,
  topic,
  condition,
  data,
  imageUrl,
  tag,
}: PushInput): FcmMessage {
  if ((!title && !data) || (!token && !topic && !condition))
    throw CLOUD_ERRORS.SEND_PUSH_NOTIFICATION_PARAMS_MISSING;
  const message: FcmMessage = { android: { priority: 'high' } };
  if (title) {
    message.notification = { title: title as string };
    if (body) message.notification.body = body as string;
    if (imageUrl) message.notification.imageUrl = imageUrl as string;
  }
  if (tag) {
    message.android.notification = { tag };
    message.apns = { headers: { 'apns-collapse-id': tag } };
  }
  if (data) message.data = data;
  if (token) message.token = token as string;
  if (topic) message.topic = topic as string;
  if (condition) message.condition = condition as string;
  return message;
}

/**
 * Legacy `sendPushNotification`: throws synchronously on missing params, otherwise sends without
 * waiting and swallows every send error (`admin.messaging().send(message).catch(() => {})`).
 */
export function sendPush(deps: CloudDeps, input: PushInput): void {
  const message = buildFcmMessage(input);
  deps.ports.push.send(message).catch((error: unknown) => {
    deps.logger.debug({ err: error }, 'push send failed (swallowed, as legacy)');
  });
}

/**
 * Records that the order was sent to `driverId` (D-21) and says whether this is the first time in
 * the current offer. A failed write counts as the first: a repeated order is a nuisance, a missed
 * one is lost work.
 */
export async function recordOffer(
  deps: CloudDeps,
  orderId: string,
  driverId: string,
): Promise<boolean> {
  try {
    return await deps.offers.markOffered(orderId, driverId);
  } catch (error) {
    deps.logger.warn({ err: error, orderId, driverId }, 'driver offer not recorded');
    return true;
  }
}

/** Where a newOrder send came from, for the notification logs. */
export type NewOrderSource = 'assignDriver' | 'chooseDriver';

/**
 * P-newOrder to one driver: Pusher when Config `driverRealtime`, and FCM `newOrder` always (D-19).
 * The socket only lives while the app's process does, so FCM is what still reaches a driver whose
 * app was killed or whose socket dropped; the app shows an order id once, whichever arrives first.
 * The FCM is tagged with the order, so sending it again replaces the tray entry and alerts once
 * more, instead of stacking a second one (D-21).
 *
 * Logs one `newOrder notify` line with the channels it tries, then one line per channel outcome
 * (`channel: 'pusher' | 'fcm'`), so a missed order can be traced to the channel that dropped it.
 */
export function notifyDriverNewOrder(
  deps: CloudDeps,
  driver: ParseObject,
  objectId: unknown,
  driverRealtime: unknown,
  source: NewOrderSource,
): void {
  const pushToken = driver.get('pushToken');
  const fcmToken: unknown = pushToken && pushToken.driver;
  const log = deps.logger.child({ orderId: objectId, driverId: driver.id, source });
  log.info({ pusher: Boolean(driverRealtime), fcm: Boolean(fcmToken) }, 'newOrder notify');

  if (driverRealtime) {
    deps.ports.realtime.trigger(driver.id as string, 'orderEvent', { data: { id: objectId } }).then(
      () => log.info({ channel: 'pusher' }, 'newOrder sent'),
      (error: unknown) => log.warn({ channel: 'pusher', err: error }, 'newOrder send failed'),
    );
  } else {
    log.info({ channel: 'pusher' }, 'newOrder skipped: Config driverRealtime is off');
  }

  if (!fcmToken) {
    log.warn({ channel: 'fcm' }, 'newOrder skipped: driver has no FCM token');
    return;
  }
  const title = messagesFor(languageOf(driver)).newOrder + ' #' + objectId;
  const message = buildFcmMessage({
    title,
    token: fcmToken,
    data: { id: objectId, newOrder: 'true', launchApp: 'true', playSound: 'true' },
    tag: String(objectId),
  });
  deps.ports.push.send(message).then(
    () => log.info({ channel: 'fcm' }, 'newOrder sent'),
    (error: unknown) => log.warn({ channel: 'fcm', err: error }, 'newOrder send failed'),
  );
}

/**
 * P-staff: push every `appType='staff'` user in `city` (or everyone with Config `sendNotifsToAll`).
 * Callers check `city` themselves, as legacy does, because the check sits at different points.
 */
export async function notifyStaff(
  deps: CloudDeps,
  opts: {
    city: unknown;
    objectId: unknown;
    page: 'orders' | 'support';
    title: (messages: Messages) => string;
    config?: InstanceType<CloudDeps['Parse']['Config']>;
  },
): Promise<void> {
  const { Parse } = deps;
  const query = new Parse.Query(Parse.User);
  const config = opts.config ?? (await Parse.Config.get());
  if (!config.get('sendNotifsToAll')) query.equalTo('city', opts.city);
  query.equalTo('appType', 'staff');
  const users = await query.find({ useMasterKey: true });
  for (const staff of users) {
    if (staff.get('pushToken') && staff.get('pushToken').staff) {
      const title = opts.title(messagesFor(languageOf(staff)));
      const notifId = deps.random.notifId();
      sendPush(deps, {
        title,
        token: staff.get('pushToken').staff,
        data: { notifId, id: opts.objectId, page: opts.page },
      });
    }
  }
}
