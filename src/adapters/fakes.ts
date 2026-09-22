import type { FcmMessage, Ports } from '../ports/index.js';

export interface Effect {
  port: keyof Ports;
  call: string;
  args: unknown[];
}

/**
 * Recording fakes: they never leave the process. Tests read `effects`; local dev logs them.
 * Responses can be scripted per call through `script`.
 */
export interface FakePorts extends Ports {
  effects: Effect[];
  script: {
    smsResponse: unknown;
    distanceResponse: (origin: string, destination: string) => unknown;
    failPush: boolean;
  };
  pushes(): FcmMessage[];
  reset(): void;
}

const defaultScript = (): FakePorts['script'] => ({
  smsResponse: { status: 'success' },
  distanceResponse: () => ({
    status: 'OK',
    rows: [
      {
        elements: [
          {
            status: 'OK',
            distance: { text: '3.2 km', value: 3200 },
            duration: { text: '8 mins', value: 480 },
          },
        ],
      },
    ],
  }),
  failPush: false,
});

export function createFakePorts(onEffect?: (effect: Effect) => void): FakePorts {
  const effects: Effect[] = [];
  let script = defaultScript();
  const record = (port: keyof Ports, call: string, ...args: unknown[]) => {
    const effect = { port, call, args };
    effects.push(effect);
    onEffect?.(effect);
  };

  const ports: FakePorts = {
    effects,
    get script() {
      return script;
    },
    set script(value) {
      script = value;
    },
    pushes: () => effects.filter((e) => e.port === 'push').map((e) => e.args[0] as FcmMessage),
    reset() {
      effects.length = 0;
      script = defaultScript();
    },
    push: {
      send(message) {
        record('push', 'send', structuredClone(message));
        return script.failPush ? Promise.reject(new Error('fake push failure')) : Promise.resolve();
      },
    },
    realtime: {
      trigger(channel, event, payload) {
        record('realtime', 'trigger', channel, event, structuredClone(payload));
        return Promise.resolve();
      },
      authorizeChannel(socketId, channel) {
        return { auth: `fake:${channel}:${socketId}` };
      },
    },
    sms: {
      send(to, message) {
        record('sms', 'send', to, message);
        return Promise.resolve(structuredClone(script.smsResponse));
      },
    },
    distance: {
      matrix(origin, destination) {
        record('distance', 'matrix', origin, destination);
        return Promise.resolve(structuredClone(script.distanceResponse(origin, destination)));
      },
    },
    mail: {
      sendMail(options) {
        record('mail', 'sendMail', options);
        return Promise.resolve({});
      },
    },
  };
  return ports;
}
