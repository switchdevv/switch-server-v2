// What makes a `_User` a staff account, an admin, or neither — one definition for the access
// grants (D-22), the ops channel ladder (D-23) and the admin guards (D-24). The consoles
// (switch-ops, switch-finance, switch-admin) apply the same rules in their lib/auth/access.ts.

const STAFF_TYPES = ['staff', 'admin'];
const STAFF_APP_TYPES = ['staff', 'admin'];

/** `staffType`, trimmed and lower-cased: it was typed by hand in the Parse Dashboard. */
export function staffTypeOf(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/** The consoles' `isStaffAccount`: a Staff/Admin `staffType` **and** a staff/admin `appType`. */
export function isStaffAccount(staffType: unknown, appType: unknown): boolean {
  return (
    STAFF_TYPES.includes(staffTypeOf(staffType)) &&
    Array.isArray(appType) &&
    appType.some((type) => STAFF_APP_TYPES.includes(type as string))
  );
}

/**
 * Anything that marks the account as staff — a `staffType` of any value, or a staff/admin
 * `appType` — whether or not the pair is complete. Wider than `isStaffAccount` on purpose:
 * this is what the admin guards protect, and a half-provisioned staff account is still one a
 * non-admin must not rewrite. The same test switch-ops' `isStaffTagged` makes.
 */
export function isStaffTagged(staffType: unknown, appType: unknown): boolean {
  return (
    staffTypeOf(staffType) !== '' ||
    (Array.isArray(appType) && appType.some((type) => STAFF_APP_TYPES.includes(type as string)))
  );
}

/** An enabled admin: the only accounts switch-admin, and the D-24 guards, let through. */
export function isActiveAdmin(user: { get(key: string): unknown } | undefined): boolean {
  if (!user || user.get('enabled') === false) return false;
  return (
    staffTypeOf(user.get('staffType')) === 'admin' &&
    isStaffAccount(user.get('staffType'), user.get('appType'))
  );
}

/** Whether `appType` gains 'staff' or 'admin' going from `before` to `after`. */
export function addsStaffAppType(before: unknown, after: unknown): boolean {
  const had = Array.isArray(before) ? before : [];
  const next = Array.isArray(after) ? after : [];
  return STAFF_APP_TYPES.some((type) => next.includes(type) && !had.includes(type));
}

/** `appType` with the staff markers taken out — what `removeStaff` leaves behind. */
export function withoutStaffAppTypes(appType: unknown): string[] {
  return (Array.isArray(appType) ? appType : []).filter(
    (type): type is string => typeof type === 'string' && !STAFF_APP_TYPES.includes(type),
  );
}
