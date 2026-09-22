// Realtime from the server to the ops console (switch-ops), over Pusher private channels. Private,
// because anyone holding the public key can read a public channel: a browser may only join one
// after `authorizeOpsChannel` signs it for a signed-in ops account.
import type { CloudDeps, ParseUser } from './context.js';
import { isStaffAccount } from './functions/staff-access.js';

/** Every region's events: admins only. */
export const OPS_ALL_CHANNEL = 'private-ops';
const CITY_PREFIX = 'private-ops-city-';

/** One region's events: its staff, and admins. */
export function opsCityChannel(cityId: string): string {
  return CITY_PREFIX + cityId;
}

export type OpsRole = 'admin' | 'staff' | null;

/**
 * switch-ops' `staffRole` ladder (src/lib/auth/access.ts), on the caller's current row: disabled
 * denies, then staff at all, then an `Admin` staffType, then the `opsAccess` grant.
 */
export function opsRoleOf(user: ParseUser): OpsRole {
  if (user.get('enabled') === false) return null;
  if (!isStaffAccount(user.get('staffType'), user.get('appType'))) return null;
  if (
    String(user.get('staffType') ?? '')
      .trim()
      .toLowerCase() === 'admin'
  )
    return 'admin';
  return user.get('opsAccess') === true ? 'staff' : null;
}

/** Whether an account with `role`, pinned to `cityId`, may join `channel`. */
export function mayJoinOpsChannel(
  role: OpsRole,
  cityId: string | undefined,
  channel: string,
): boolean {
  if (!role) return false;
  if (channel === OPS_ALL_CHANNEL) return role === 'admin';
  if (!channel.startsWith(CITY_PREFIX)) return false;
  return role === 'admin' || (!!cityId && channel === opsCityChannel(cityId));
}

/** What ops receive when a driver declines an order sent to them. */
export interface DriverDeclinedEvent {
  orderId: string;
  driverId: string;
  driverName: string | null;
  cityId: string | null;
  declinedAt: string;
}

export const DRIVER_DECLINED_EVENT = 'driverDeclined';

/**
 * Tells ops a driver declined, on the all-regions channel and on the order's region channel. An
 * admin joins only the first and a staff account only the second, so nobody hears it twice. Not
 * awaited: the decline is already stored on the order, which ops also read on their next refresh.
 */
export function notifyOpsDriverDeclined(deps: CloudDeps, event: DriverDeclinedEvent): void {
  const channels = [OPS_ALL_CHANNEL];
  if (event.cityId) channels.push(opsCityChannel(event.cityId));
  const log = deps.logger.child({ orderId: event.orderId, driverId: event.driverId });
  for (const channel of channels) {
    deps.ports.realtime.trigger(channel, DRIVER_DECLINED_EVENT, event).then(
      () => log.info({ channel }, 'driverDeclined sent to ops'),
      (error: unknown) => log.warn({ channel, err: error }, 'driverDeclined send to ops failed'),
    );
  }
}
