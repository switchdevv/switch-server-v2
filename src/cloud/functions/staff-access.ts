// Not in legacy: the access grants switch-ops and switch-finance call from their /access pages.
// Specs: switch-ops/docs/ops-access-backend.md, switch-finance/docs/finance-access-backend.md.
// Both consoles read the error code, so these throw Parse.Errors, not CLOUD_ERRORS strings.
// The boundary that stops an account granting itself is `beforeSave _User` (triggers/index.ts).
import type { CloudDeps, FunctionHandler, FunctionTable } from '../context.js';
import { isStaffAccount, staffTypeOf } from '../staff-accounts.js';

/** The `_User` Boolean each grant writes. Ignored for admins, who have access by role. */
export const ACCESS_FIELDS = { ops: 'opsAccess', finance: 'financeAccess' } as const;

function setAccess(console: keyof typeof ACCESS_FIELDS, label: string): FunctionHandler {
  const field = ACCESS_FIELDS[console];
  return async (req, deps: CloudDeps) => {
    const { Parse } = deps;
    const { userId, granted } = req.params as Record<string, unknown>;
    if (!req.user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Sign in first.');
    if (typeof userId !== 'string' || !userId)
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'userId is required.');
    if (typeof granted !== 'boolean')
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'granted must be a boolean.');

    // The caller's current row, not the session's cached copy.
    const caller = await new Parse.Query(Parse.User)
      .equalTo('objectId', req.user.id)
      .first({ useMasterKey: true });
    if (!caller || caller.get('enabled') === false)
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Account is disabled.');
    if (staffTypeOf(caller.get('staffType')) !== 'admin')
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Only admins can change access.');

    const target = await new Parse.Query(Parse.User)
      .equalTo('objectId', userId)
      .first({ useMasterKey: true });
    if (!target) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'No such account.');
    if (!isStaffAccount(target.get('staffType'), target.get('appType'))) {
      throw new Parse.Error(
        Parse.Error.OPERATION_FORBIDDEN,
        `Only staff accounts can be granted ${label} access.`,
      );
    }
    // Admins have access by role; the consoles show no switch for them. This also means an
    // admin (the only possible caller) can never revoke their own access.
    if (staffTypeOf(target.get('staffType')) === 'admin')
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Admins always have access.');

    target.set(field, granted);
    await target.save(null, { useMasterKey: true });
    return { objectId: target.id, [field]: granted };
  };
}

export const staffAccessFunctions: FunctionTable = {
  setOpsAccess: setAccess('ops', 'Ops'),
  setFinanceAccess: setAccess('finance', 'finance'),
};
