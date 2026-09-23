// Not in legacy: the admin-only functions switch-admin calls (D-24). Staff off-boarding —
// signing an account out everywhere, taking it off the team — and recounting the ratings a
// deleted review leaves behind (the `afterSave Review` trigger only ever adds).
//
// Thrown as CLOUD_ERRORS strings (141 + string), like the legacy staff functions the same
// screens call, so one error reader covers them all.
import { recountRating } from '../../domain/ratings.js';
import type { CloudDeps, FunctionTable, ParseObject, ParseUser } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { requireAdmin } from '../guards.js';
import { CLASSES, pointer } from '../pointers.js';
import { isStaffTagged, withoutStaffAppTypes } from '../staff-accounts.js';

/** Enough for a bulk review deletion; a cap so one call can't walk the whole platform. */
const MAX_TARGETS = 100;
const PAGE = 1000;

async function staffTarget(
  deps: CloudDeps,
  caller: ParseUser,
  userId: unknown,
): Promise<ParseUser> {
  const { Parse } = deps;
  if (typeof userId !== 'string' || !userId) throw CLOUD_ERRORS.PARAMS_MISSING;
  if (userId === caller.id) throw CLOUD_ERRORS.SELF_NOT_ALLOWED;
  const target = await new Parse.Query(Parse.User)
    .equalTo('objectId', userId)
    .first({ useMasterKey: true });
  if (!target) throw CLOUD_ERRORS.USER_DOES_NOT_EXISTS;
  if (!isStaffTagged(target.get('staffType'), target.get('appType')))
    throw CLOUD_ERRORS.NOT_STAFF_ACCOUNT;
  return target;
}

/** Destroys every session of the account — the only way to end one before it expires. */
async function endSessions(deps: CloudDeps, user: ParseUser): Promise<number> {
  const { Parse } = deps;
  let ended = 0;
  // Page from the start each time: destroyed rows drop out of the next read.
  for (;;) {
    const sessions = await new Parse.Query(Parse.Session)
      .equalTo('user', user)
      .limit(PAGE)
      .find({ useMasterKey: true });
    for (const session of sessions) await session.destroy({ useMasterKey: true });
    ended += sessions.length;
    if (sessions.length < PAGE) return ended;
  }
}

/** Every rating left on the given pointer field, paged past Parse's ceiling. */
async function ratingsFor(
  deps: CloudDeps,
  field: 'restaurant' | 'driver',
  target: ParseObject,
): Promise<number[]> {
  const { Parse } = deps;
  const ratings: number[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const page = await new Parse.Query(CLASSES.review)
      .equalTo(field, target)
      .select('rating')
      .ascending('createdAt')
      .limit(PAGE)
      .skip(skip)
      .find({ useMasterKey: true });
    ratings.push(...page.map((review) => review.get('rating') as number));
    if (page.length < PAGE) return ratings;
  }
}

function idList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id))
    throw CLOUD_ERRORS.PARAMS_MISSING;
  return [...new Set(value as string[])];
}

export const staffAdminFunctions: FunctionTable = {
  /** Ends every session of a staff account — what "deactivate" needs, since a disabled
   * account keeps the sessions it has (`beforeLogin` only stops new ones). */
  async signOutStaff(req, deps) {
    const caller = await requireAdmin(req, deps);
    const target = await staffTarget(deps, caller, (req.params as Record<string, unknown>).userId);
    const sessions = await endSessions(deps, target);
    return { objectId: target.id, sessions };
  },

  /**
   * Takes an account off the team: out of the Staff role (which `editUser` never does), its
   * role and console grants cleared, the staff app dropped from `appType`, signed out. The
   * account itself stays — it may also be someone's customer account.
   */
  async removeStaff(req, deps) {
    const { Parse } = deps;
    const caller = await requireAdmin(req, deps);
    const target = await staffTarget(deps, caller, (req.params as Record<string, unknown>).userId);

    const role = await new Parse.Query(Parse.Role)
      .equalTo('name', deps.env.STAFF_ROLE_NAME)
      .first({ useMasterKey: true });
    if (role) {
      role.getUsers().remove(target);
      await role.save(null, { useMasterKey: true });
    }

    target.unset('staffType');
    target.unset('opsAccess');
    target.unset('financeAccess');
    target.set('appType', withoutStaffAppTypes(target.get('appType')));
    await target.save(null, { useMasterKey: true });
    const sessions = await endSessions(deps, target);
    return { objectId: target.id, sessions };
  },

  /**
   * Recounts rating totals from the reviews that are left — after `deleteReviews`, which
   * removes rows but never subtracts them from the totals the trigger added up. Writes what
   * the trigger writes: `rating`/`ratingTotal`/`reviews` on a restaurant, `driverRating` and
   * `driverParams.{ratingTotal,reviews}` on a driver.
   */
  async recountRatings(req, deps) {
    const { Parse } = deps;
    await requireAdmin(req, deps);
    const params = req.params as Record<string, unknown>;
    const restaurantIds = idList(params.restaurantIds);
    const driverIds = idList(params.driverIds);
    if (restaurantIds.length + driverIds.length === 0) throw CLOUD_ERRORS.PARAMS_MISSING;
    if (restaurantIds.length + driverIds.length > MAX_TARGETS) throw CLOUD_ERRORS.PARAMS_MISSING;

    let restaurants = 0;
    for (const id of restaurantIds) {
      const store = await new Parse.Query(CLASSES.store)
        .equalTo('objectId', id)
        .first({ useMasterKey: true });
      if (!store) continue;
      const next = recountRating(
        await ratingsFor(deps, 'restaurant', pointer(Parse, CLASSES.store, id)),
      );
      store.set('ratingTotal', next.ratingTotal);
      store.set('reviews', next.reviews);
      store.set('rating', next.rating);
      await store.save(null, { useMasterKey: true });
      restaurants += 1;
    }

    let drivers = 0;
    for (const id of driverIds) {
      const driver = await new Parse.Query(Parse.User)
        .equalTo('objectId', id)
        .first({ useMasterKey: true });
      if (!driver) continue;
      const next = recountRating(await ratingsFor(deps, 'driver', pointer(Parse, '_User', id)));
      driver.set('driverParams', {
        ...((driver.get('driverParams') as Record<string, unknown> | undefined) ?? {}),
        ratingTotal: next.ratingTotal,
        reviews: next.reviews,
      });
      driver.set('driverRating', next.rating);
      await driver.save(null, { useMasterKey: true });
      drivers += 1;
    }

    return { restaurants, drivers };
  },
};
