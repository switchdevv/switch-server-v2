// D-25: the driver wallet's pure rules. The per-order rule is an aggregation, tested against
// MongoDB in test/integration/driver-wallet.test.ts.
import { describe, expect, it } from 'vitest';
import {
  canGoOnline,
  type Lot,
  ordersLeft,
  serviceFeeOf,
  valueOfNewest,
  valueOfOldest,
  walletLevel,
  walletSettingsOf,
  walletState,
} from '../../src/domain/driver-wallet.js';
import { arabicOrders, walletPushCopy } from '../../src/domain/wallet-messages.js';

const at = (day: number) => new Date(Date.UTC(2026, 8, day));

describe('walletSettingsOf', () => {
  it('defaults to off, at least 1 order to go online, a warning at 10', () => {
    expect(walletSettingsOf(undefined)).toEqual({ enforced: false, minOrders: 1, lowOrders: 10 });
  });

  it('keeps whole numbers and replaces anything else by its default', () => {
    expect(walletSettingsOf({ enforced: true, minOrders: 3, lowOrders: 15 })).toEqual({
      enforced: true,
      minOrders: 3,
      lowOrders: 15,
    });
    expect(walletSettingsOf({ enforced: 'yes', minOrders: -1, lowOrders: 2.5 })).toEqual({
      enforced: false,
      minOrders: 1,
      lowOrders: 10,
    });
  });
});

describe('levels', () => {
  const settings = { enforced: true, minOrders: 1, lowOrders: 10 };

  it('is empty under the minimum, low up to the threshold, ok above', () => {
    expect(walletLevel(99, settings)).toBe('empty');
    expect(walletLevel(100, settings)).toBe('low');
    expect(walletLevel(1000, settings)).toBe('low');
    expect(walletLevel(1001, settings)).toBe('ok');
  });

  it('tells the app off while not enforced, and then lets anyone online', () => {
    const off = { ...settings, enforced: false };
    expect(walletState(0, off)).toBe('off');
    expect(canGoOnline(0, off)).toBe(true);
    expect(canGoOnline(99, settings)).toBe(false);
    expect(canGoOnline(100, settings)).toBe(true);
  });

  it('shows whole orders, never below 0', () => {
    expect(ordersLeft(1260)).toBe(12);
    expect(ordersLeft(99)).toBe(0);
    expect(ordersLeft(-40)).toBe(0);
  });
});

describe('FIFO valuation', () => {
  // 50 orders bought at 50 DA, then a free-delivery credit of 2 orders at 60 DA.
  const lots: Lot[] = [
    { at: at(20), units: 200, unitPrice: 60 },
    { at: at(1), units: 5000, unitPrice: 50 },
  ];

  it('prices the orders left as the newest ones received, each at its own price', () => {
    // 30 used (oldest first) of the 50 → 20 of them + the 2 credited are left.
    expect(valueOfNewest(lots, 2200, 60)).toBe(2 * 60 + 20 * 50);
    expect(valueOfNewest(lots, 150, 60)).toBe(90);
  });

  it('takes a partial refund from the oldest orders left', () => {
    // Of 22 left (2 @ 60 newest, 20 @ 50), the oldest 5 are at 50.
    expect(valueOfOldest(lots, 2200, 500, 60)).toBe(250);
    // All of them: the same as the whole value.
    expect(valueOfOldest(lots, 2200, 2200, 60)).toBe(valueOfNewest(lots, 2200, 60));
  });

  it('prices a negative balance, and what the lots do not cover, at today’s fee', () => {
    expect(valueOfNewest(lots, -150, 60)).toBe(-90);
    expect(valueOfNewest([], 300, 55)).toBe(165);
  });

  it('rounds to whole DA only at the end', () => {
    expect(valueOfNewest([{ at: at(1), units: 333, unitPrice: 45 }], 333, 45)).toBe(150);
  });
});

describe('serviceFeeOf', () => {
  it('reads City.fees.food.service, and nothing that is not a positive number', () => {
    expect(serviceFeeOf({ food: { service: 50 } })).toBe(50);
    expect(serviceFeeOf({ food: { service: 0 } })).toBeNull();
    expect(serviceFeeOf({ food: {} })).toBeNull();
    expect(serviceFeeOf(undefined)).toBeNull();
  });
});

describe('wallet pushes', () => {
  it('counts orders in Arabic with the dual and the plural ranges', () => {
    expect(arabicOrders(1)).toBe('طلب واحد');
    expect(arabicOrders(2)).toBe('طلبان');
    expect(arabicOrders(3)).toBe('3 طلبات');
    expect(arabicOrders(10)).toBe('10 طلبات');
    expect(arabicOrders(11)).toBe('11 طلبًا');
    expect(arabicOrders(100)).toBe('100 طلب');
    expect(arabicOrders(103)).toBe('103 طلبات');
  });

  it('speaks the driver’s language, English when it is unknown, and never money', () => {
    expect(walletPushCopy('en', 'low', 10).title).toBe('Only 10 orders left');
    expect(walletPushCopy('fr', 'low', 1).title).toBe('Plus qu’une commande');
    expect(walletPushCopy('ar', 'empty', 0).title).toBe('نفد رصيد طلباتك');
    expect(walletPushCopy('de', 'topUp', 12, 5)).toEqual({
      title: '5 orders added',
      body: 'You now have 12 orders.',
    });
  });
});
