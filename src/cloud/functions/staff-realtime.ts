// Not in legacy (D-23): signs switch-ops' subscriptions to its Pusher private channels. pusher-js
// calls it through a custom authorizer, so it travels with the console's Parse session like every
// other call, and a revoked grant or a moved region stops new subscriptions at once.
import type { FunctionTable } from '../context.js';
import { mayJoinOpsChannel, opsRoleOf } from '../ops-channels.js';

export const staffRealtimeFunctions: FunctionTable = {
  async authorizeOpsChannel(req, deps) {
    const { Parse } = deps;
    const { socketId, channelName } = req.params as Record<string, unknown>;
    if (!req.user) throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Sign in first.');
    if (typeof socketId !== 'string' || typeof channelName !== 'string')
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'socketId and channelName are required.');
    // The caller's current row, not the session's cached copy.
    const caller = await new Parse.Query(Parse.User)
      .equalTo('objectId', req.user.id)
      .first({ useMasterKey: true });
    const role = caller ? opsRoleOf(caller) : null;
    const cityId = caller?.get('city')?.id as string | undefined;
    if (!mayJoinOpsChannel(role, cityId, channelName)) {
      deps.logger.warn(
        { fn: 'authorizeOpsChannel', userId: req.user.id, channelName, role },
        'ops channel refused',
      );
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Not allowed on this channel.');
    }
    try {
      return deps.ports.realtime.authorizeChannel(socketId, channelName);
    } catch (error) {
      deps.logger.warn({ fn: 'authorizeOpsChannel', err: error }, 'ops channel signing failed');
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Could not sign this channel.');
    }
  },
};
