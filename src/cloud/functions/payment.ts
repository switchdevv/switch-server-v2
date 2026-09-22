// Port of legacy cloud/payment/payment.js, without Stripe (D-12).
//
// Card payments are off everywhere: the food app only offers cash (`paymentConfigs.methods`), and
// legacy's Stripe secret key is blank, so every Stripe call it makes fails. v2 keeps the function
// and the same outcomes for any old build that still calls it, without the Stripe SDK.
import type { FunctionTable } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { requireUser } from '../guards.js';

export const paymentFunctions: FunctionTable = {
  // Legacy checks the session and `tokenId`, then fails in Stripe (141 with Stripe's
  // missing-key message). v2 fails at the same point with a legacy error string.
  async savePayment(req) {
    requireUser(req);
    const { tokenId } = req.params as Record<string, unknown>;
    if (!tokenId) throw CLOUD_ERRORS.SAVE_PAYMENT_PARAMS_MISSING;
    throw CLOUD_ERRORS.FAILED_TO_PROCESS_PAYMENT;
  },
};
