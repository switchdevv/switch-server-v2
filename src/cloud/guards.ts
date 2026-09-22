import type { CloudDeps, FunctionRequest, ParseObject, ParseUser } from './context.js';
import { CLOUD_ERRORS } from './errors.js';

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
