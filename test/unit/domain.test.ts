import { describe, expect, it } from 'vitest';
import { cryptoRandom } from '../../src/adapters/random.js';
import { deliveryFee, type FeeTable, tripMinutes } from '../../src/domain/fees.js';
import { messagesFor, translations, withOrder } from '../../src/domain/i18n.js';
import { addRating } from '../../src/domain/ratings.js';
import { newUserFields } from '../../src/domain/user-defaults.js';

// Verbatim from legacy cloud/order/food.js (calculateOrder), for differential checks.
function legacyDelivery(distance: number, fees: Record<string, never>) {
  const city = { fees: { food: fees } } as {
    fees: Record<string, Record<string, number | null | undefined>>;
  };
  const appType = 'food';
  let usedDistance = distance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parseInt = (x: any) => Number.parseInt(x);
  const kmDiff = usedDistance - parseInt(usedDistance);
  if (kmDiff !== 0 && kmDiff <= 0.5) usedDistance = parseInt(usedDistance) + 0.5;
  else if (kmDiff > 0.5) usedDistance = parseInt(usedDistance) + 1;
  const f = city.fees[appType] as Record<string, number>;
  let delivery = f.initial!;
  if (f.minKmsExtra !== null && f.minKmsExtra !== undefined) {
    if (usedDistance > f.minKms! && usedDistance <= f.minKmsExtra) {
      delivery = f.initialExtra!;
    } else if (usedDistance > f.minKmsExtra) {
      const diff = usedDistance - f.minKmsExtra;
      delivery = f.initialExtra! + parseInt(diff * f.perExtraKm!);
    }
  } else if (usedDistance > f.minKms!) {
    const diff = usedDistance - f.minKms!;
    delivery += parseInt(diff * f.perExtraKm!);
  }
  return delivery;
}

let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

describe('delivery fee (calculateOrder)', () => {
  it('matches legacy on 5000 random distances and tables (one- and two-tier)', () => {
    for (let i = 0; i < 5000; i++) {
      const distance = Math.round(rand() * 250) / 10; // 0.0 … 25.0 km, one decimal like "12.3 km"
      const twoTier = rand() < 0.5;
      const fees: FeeTable = {
        initial: 100 + Math.round(rand() * 200),
        minKms: Math.round(rand() * 6),
        perExtraKm: Math.round(rand() * 70) + 0.5 * Math.round(rand()),
        ...(twoTier
          ? {
              initialExtra: 250 + Math.round(rand() * 100),
              minKmsExtra: 6 + Math.round(rand() * 6),
            }
          : rand() < 0.3
            ? { minKmsExtra: null }
            : {}),
      };
      expect(deliveryFee(distance, fees), JSON.stringify({ distance, fees })).toBe(
        legacyDelivery(distance, fees as never),
      );
    }
  });

  it('rounds up to the next half km', () => {
    const fees = { initial: 0, minKms: 0, perExtraKm: 10 };
    expect(deliveryFee(4.2, fees)).toBe(45);
    expect(deliveryFee(4.5, fees)).toBe(45);
    expect(deliveryFee(4.51, fees)).toBe(50);
    expect(deliveryFee(4, fees)).toBe(40);
  });

  it('trip minutes = ceil(preparation + km × perKm)', () => {
    expect(tripMinutes(4.2, { preparationTime: 10, timePerKm: 3 })).toBe(23);
  });
});

describe('ratings (afterSave Review)', () => {
  it('running average rounded to 1 decimal, as legacy', () => {
    expect(addRating({ ratingTotal: 7, reviews: 2 }, 4)).toEqual({
      ratingTotal: 11,
      reviews: 3,
      rating: 3.7,
    });
    expect(addRating({ ratingTotal: 0, reviews: 0 }, 5)).toEqual({
      ratingTotal: 5,
      reviews: 1,
      rating: 5,
    });
  });
});

describe('i18n', () => {
  it('keeps the three languages and the legacy keys', () => {
    expect(Object.keys(translations)).toEqual(['en', 'fr', 'ar']);
    expect(Object.keys(messagesFor('en'))).toHaveLength(15);
  });
  it('replaces only the first %s', () => {
    expect(withOrder('Order %s / %s', 'abc')).toBe('Order #abc / %s');
  });
  it('Q-11: an unknown language throws (after the DB write, like legacy)', () => {
    expect(() => messagesFor('de')).toThrow(TypeError);
  });
});

describe('new-user defaults', () => {
  it('is the legacy literal (loginWith*: undefined for phone, picture, address, city, managerStore, driverLocation, staffType)', () => {
    const fields = newUserFields({
      username: 'u',
      password: 'p',
      fullname: 'F',
      email: 'e',
      language: 'en',
      appType: ['food'],
    });
    expect(fields).toStrictEqual({
      username: 'u',
      fullname: 'F',
      password: 'p',
      email: 'e',
      language: 'en',
      appType: ['food'],
      enabled: true,
      pushToken: {},
      theme: 'light',
      phone: undefined,
      picture: undefined,
      address: undefined,
      city: undefined,
      promoNotifs: true,
      payment: { method: 'cash', stripeCustomerId: null, stripeDefaultSourceId: null, list: [] },
      cartOptions: {},
      cartFood: [],
      favorites: [],
      promosUsed: [],
      managerStore: undefined,
      driverActive: false,
      driverRating: 0,
      driverLocation: undefined,
      driverOrdersAccepted: 0,
      driverParams: { ratingTotal: 0, reviews: 0 },
      staffType: undefined,
    });
  });
});

describe('random values', () => {
  it('D-10: the OTP is always 4 digits; D-17: the signup password is 8 base-36 chars', () => {
    for (let i = 0; i < 1000; i++) {
      expect(cryptoRandom.otp()).toMatch(/^\d{4}$/);
      expect(cryptoRandom.password()).toMatch(/^[0-9a-z]{8}$/);
    }
  });
});
