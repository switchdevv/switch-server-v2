import type ParseDefault from 'parse/node';
import type { Env } from '../config/env.js';
import type { Logger } from '../observability/logger.js';
import type { Ports } from '../ports/index.js';

/** The Parse namespace Parse Server hands to `cloud(Parse)`, with `Parse.Cloud` server methods. */
export type ParseSdk = typeof ParseDefault;
export type ParseObject = InstanceType<ParseSdk['Object']>;
export type ParseUser = InstanceType<ParseSdk['User']>;
export type FunctionRequest = Parameters<Parameters<ParseSdk['Cloud']['define']>[1]>[0];

/** Starts / cancels the automatic dispatch job (legacy `chooseDriver` + `agenda.cancel`). */
export interface DispatchScheduler {
  /** Legacy `chooseDriver({ objectId, driverId })` from cloud/order/driver.js. */
  start(input: { objectId: unknown; driverId?: string | undefined }): Promise<void>;
  /** Legacy `agenda.cancel({ 'data.objectId': objectId })`. */
  cancel(objectId: unknown): Promise<void>;
}

export type ClaimOutcome = 'claimed' | 'canceled' | 'taken';

/**
 * Who drives an order, changed only by atomic compare-and-set (D-20, ADR 0002), so two callers
 * racing on one order never both succeed. Order ids come straight from the client: anything but a
 * string counts as no such order.
 */
export interface OrderClaims {
  /**
   * Makes `driverId` the driver of an order that isn't canceled and has no driver or already has
   * them. Otherwise `canceled` (missing or canceled) or `taken` (another driver has it).
   */
  claim(orderId: unknown, driverId: string): Promise<ClaimOutcome>;
  /** Clears the driver only while it is still `driverId`; false when it isn't. */
  release(orderId: unknown, driverId: string): Promise<boolean>;
  /** Cancels the order only while it has no driver; false when a driver holds it. */
  cancelUnclaimed(orderId: string): Promise<boolean>;
}

/**
 * Which drivers were sent an order during its current offer (D-21, src/cloud/driver-offers.ts). The
 * automatic search sends each driver an order once; ops' `assignDriver` always sends. An offer
 * ends when a driver takes the order or the search gives up.
 */
export interface DriverOffers {
  /** Records that `driverId` was sent the order; true only the first time in this offer. */
  markOffered(orderId: string, driverId: string): Promise<boolean>;
  /** Whether `driverId` was sent the order during its current offer. */
  wasOffered(orderId: string, driverId: string): Promise<boolean>;
  /** Ends the order's offer, so every driver may be sent it again. */
  clear(orderId: unknown): Promise<void>;
}

/** `Order.driverDeclines`: which drivers turned an open order down (D-23). */
export interface OrderDeclines {
  /** Stores the driver's decline if the order is still open; the stored value, or null. */
  record(
    orderId: string,
    driverId: string,
    name: string | null,
  ): Promise<{ name: string | null; at: string } | null>;
  /** Forgets the driver's decline: the order is being sent to them again. */
  clear(orderId: string, driverId: string): Promise<void>;
}

/** Deletes a stored file through the files adapter, in-process (D-5). */
export interface FileStore {
  deleteFile(name: string): Promise<void>;
}

export interface Random {
  /** 4-digit OTP (D-10). */
  otp(): string;
  /** Legacy `Math.random().toString().slice(-8)`: the staff push `notifId`. */
  notifId(): string;
  /**
   * The throwaway social-signup password (8 base-36 chars). Legacy used
   * `Math.random().toString(36).slice(-8)`; v2 draws it from crypto (D-17). Never returned to the client.
   */
  password(): string;
}

export interface CloudDeps {
  Parse: ParseSdk;
  env: Env;
  ports: Ports;
  dispatch: DispatchScheduler;
  claims: OrderClaims;
  offers: DriverOffers;
  declines: OrderDeclines;
  files: FileStore;
  random: Random;
  logger: Logger;
}

export type FunctionHandler = (req: FunctionRequest, deps: CloudDeps) => Promise<unknown>;
export type FunctionTable = Record<string, FunctionHandler>;

/** Legacy fire-and-forget calls keep their timing but never become unhandled rejections (D-4). */
export function detach(
  deps: Pick<CloudDeps, 'logger'>,
  what: string,
  promise: Promise<unknown>,
): void {
  promise.catch((error: unknown) =>
    deps.logger.warn({ err: error, what }, 'background call failed'),
  );
}
