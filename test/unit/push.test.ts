import { describe, expect, it } from 'vitest';
import { buildFcmMessage } from '../../src/cloud/notify.js';

// Verbatim from legacy cloud/push/push.js (message construction; the send is stubbed out).
function legacyMessage({
  title,
  body,
  token,
  topic,
  condition,
  data,
  imageUrl,
}: Record<string, unknown> = {}) {
  if ((!title && !data) || (!token && !topic && !condition))
    throw 'SEND_PUSH_NOTIFICATION_PARAMS_MISSING';
  const message: Record<string, unknown> & { notification?: Record<string, unknown> } = {
    android: { priority: 'high' },
  };
  if (title) {
    message.notification = { title };
    if (body) message.notification.body = body;
    if (imageUrl) message.notification.imageUrl = imageUrl;
  }
  if (data) message.data = data;
  if (token) message.token = token;
  if (topic) message.topic = topic;
  if (condition) message.condition = condition;
  return message;
}

const values = [undefined, '', 'x', 0, 1, null, { a: 'b' }];
const pick = (i: number) => values[i % values.length];

describe('FCM message (sendPushNotification)', () => {
  it('matches legacy for every combination of present/absent/falsy inputs', () => {
    let checked = 0;
    for (let i = 0; i < 7 ** 4; i++) {
      const input = {
        title: pick(i),
        body: pick(Math.floor(i / 7)),
        token: pick(Math.floor(i / 49)),
        data: pick(Math.floor(i / 343)),
        topic: i % 11 === 0 ? 't' : undefined,
        condition: i % 13 === 0 ? 'c' : undefined,
        imageUrl: i % 3 ? 'img' : undefined,
      };
      let legacy: unknown, v2: unknown;
      try {
        legacy = legacyMessage(input);
      } catch (e) {
        legacy = { threw: e };
      }
      try {
        v2 = buildFcmMessage(input);
      } catch (e) {
        v2 = { threw: e };
      }
      expect(v2, JSON.stringify(input)).toEqual(legacy);
      checked++;
    }
    expect(checked).toBe(2401);
  });

  it('D-21: a tag adds the Android tray tag and the APNs collapse id, and nothing else', () => {
    const input = { title: 'New Order #o1', token: 't', data: { id: 'o1' } };
    expect(buildFcmMessage({ ...input, tag: 'o1' })).toEqual({
      ...legacyMessage(input),
      android: { priority: 'high', notification: { tag: 'o1' } },
      apns: { headers: { 'apns-collapse-id': 'o1' } },
    });
  });
});
