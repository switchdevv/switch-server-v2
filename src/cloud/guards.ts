import type { CloudDeps, FunctionRequest, ParseObject, ParseUser } from './context.js';
import { CLOUD_ERRORS } from './errors.js';
import { isActiveAdmin } from './staff-accounts.js';

/** Guard **U**: `if (!req.user) throw USER_UNAUTHENTICATED`. */
export function requireUser(req: FunctionRequest): ParseUser {
  if (!req.user) throw CLOUD_ERRORS.USER_UNAUTHENTICATED;
  return req.user;
}

/** The exact legacy role lookup: any `_Role` whose `users` relation contains the user. */
export async function findRole(deps: CloudDeps, user: ParseUser): Promise<ParseObject | undefined> {
  const { Parse } = deps;
  const roleQuery = new Parse.Query(Parse.Role);
  roleQuery.equalTo('users', user);
  return roleQuery.first({ useMasterKey: true });
}

/** Guard **S**: authenticated, then any role (in practice `Staff`), else USER_UNAUTHORIZED. */
export async function requireStaff(req: FunctionRequest, deps: CloudDeps): Promise<ParseUser> {
  const user = requireUser(req);
  const role = await findRole(deps, user);
  if (!role) throw CLOUD_ERRORS.USER_UNAUTHORIZED;
  return user;
}

/** The caller's current row, not the session's cached copy — a demotion or a deactivation
 * takes effect on the next call, not when the session ends. */
async function freshCaller(deps: CloudDeps, user: ParseUser): Promise<ParseUser | undefined> {
  const { Parse } = deps;
  return new Parse.Query(Parse.User).equalTo('objectId', user.id).first({ useMasterKey: true });
}

/** Whether an already-authenticated caller is an enabled admin (D-24). */
export async function callerIsAdmin(deps: CloudDeps, user: ParseUser): Promise<boolean> {
  return isActiveAdmin(await freshCaller(deps, user));
}

/**
 * Guard **A** (D-24, not in legacy): guard S, then an enabled admin by the caller's current
 * row, else ADMIN_REQUIRED. S first, so a caller with no role still gets the legacy
 * USER_UNAUTHORIZED rather than learning that an admin check exists.
 */
export async function requireAdmin(req: FunctionRequest, deps: CloudDeps): Promise<ParseUser> {
  const user = await requireStaff(req, deps);
  if (!(await callerIsAdmin(deps, user))) throw CLOUD_ERRORS.ADMIN_REQUIRED;
  return user;
}
