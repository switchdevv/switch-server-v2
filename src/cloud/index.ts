import type { CloudDeps, FunctionTable, ParseSdk } from './context.js';
import { authFunctions } from './functions/auth.js';
import { fileFunctions } from './functions/files.js';
import { orderDriverFunctions } from './functions/order-driver.js';
import { orderFoodFunctions } from './functions/order-food.js';
import { orderManagerFunctions } from './functions/order-manager.js';
import { paymentFunctions } from './functions/payment.js';
import { staffAccessFunctions } from './functions/staff-access.js';
import { staffAuthFunctions } from './functions/staff-auth.js';
import { staffCatalogueFunctions } from './functions/staff-catalogue.js';
import { staffOrderFunctions } from './functions/staff-orders.js';
import { staffRealtimeFunctions } from './functions/staff-realtime.js';
import { staffStoreFunctions } from './functions/staff-stores.js';
import { staffUserFunctions } from './functions/staff-users.js';
import { TRIGGERS } from './triggers/index.js';

const TABLES: FunctionTable[] = [
  authFunctions,
  fileFunctions,
  paymentFunctions,
  orderFoodFunctions,
  orderManagerFunctions,
  orderDriverFunctions,
  staffAuthFunctions,
  staffUserFunctions,
  staffStoreFunctions,
  staffCatalogueFunctions,
  staffOrderFunctions,
  staffAccessFunctions,
  staffRealtimeFunctions,
];

/** The single registry: every cloud function by name (a test pins the 50 legacy names + the additions). */
export function allFunctions(): FunctionTable {
  const all: FunctionTable = {};
  for (const table of TABLES) {
    for (const [name, handler] of Object.entries(table)) {
      if (name in all) throw new Error(`Cloud function ${name} is registered twice`);
      all[name] = handler;
    }
  }
  return all;
}

export { TRIGGERS };

/**
 * Parse's own failure log is silenced because it prints the function input (D-16). Log the
 * function, the caller and the error instead, never the params: legacy error strings (the
 * expected business outcomes) at info, anything else at warn.
 */
function logFunctionFailure(
  deps: CloudDeps,
  fn: string,
  userId: string | undefined,
  error: unknown,
): void {
  if (typeof error === 'string') {
    deps.logger.info({ fn, userId, error }, 'cloud function refused');
    return;
  }
  const code = (error as { code?: unknown } | null)?.code;
  deps.logger.warn({ fn, userId, code, err: error }, 'cloud function failed');
}

/** Registers everything on the `Parse` that Parse Server passes to `cloud(Parse)`. */
export function registerCloud(Parse: ParseSdk, deps: CloudDeps): void {
  const Cloud = Parse.Cloud;
  const log = deps.logger;
  for (const [name, handler] of Object.entries(allFunctions())) {
    Cloud.define(name, async (req) => {
      try {
        return await handler(req, deps);
      } catch (error) {
        logFunctionFailure(deps, name, req.user?.id, error);
        throw error;
      }
    });
  }
  // Parse's trigger request types vary per trigger; the handlers only read object/user/file.
  type Loose = (req: never) => Promise<void>;
  for (const [name, spec] of Object.entries(TRIGGERS)) {
    // Parse swallows after-trigger errors (and before-trigger errors become the response); log
    // them the way 4.3 did ("afterSave caught an error"), except the legacy error strings.
    const wrap =
      (handler: (req: never, d: CloudDeps) => Promise<void>): Loose =>
      async (req) => {
        try {
          await handler(req, deps);
        } catch (error) {
          if (typeof error !== 'string') log.warn({ err: error, trigger: name }, 'trigger failed');
          throw error;
        }
      };
    switch (spec.kind) {
      case 'beforeLogin':
        Cloud.beforeLogin(wrap(spec.handler) as never);
        break;
      case 'afterLogout':
        Cloud.afterLogout(wrap(spec.handler) as never);
        break;
      // Parse 7 replaced beforeSaveFile/afterSaveFile with beforeSave/afterSave(Parse.File).
      case 'beforeSaveFile':
        Cloud.beforeSave(Parse.File as never, wrap(spec.handler) as never);
        break;
      case 'afterSaveFile':
        Cloud.afterSave(Parse.File as never, wrap(spec.handler) as never);
        break;
      case 'beforeSave':
        Cloud.beforeSave(spec.className, wrap(spec.handler) as never);
        break;
      case 'afterSave':
        Cloud.afterSave(spec.className, wrap(spec.handler) as never);
        break;
      case 'afterDelete':
        Cloud.afterDelete(spec.className, wrap(spec.handler) as never);
        break;
    }
  }
}
