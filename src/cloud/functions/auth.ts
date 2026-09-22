// Port of legacy cloud/auth/auth.js (functions). The login/logout triggers are in ../triggers/index.ts.
import { newUserFields } from '../../domain/user-defaults.js';
import type { CloudDeps, FunctionRequest, FunctionTable, ParseUser } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';

interface SocialLogin {
  provider: 'google' | 'facebook' | 'apple';
  paramsError: string;
  required: string[];
  /** Evaluated at link time, after the user lookup / sign-up, as legacy does. */
  authData: (
    params: Record<string, unknown>,
    clientUser: Record<string, unknown>,
  ) => Record<string, unknown>;
  fullname: (clientUser: Record<string, unknown>, username: string) => unknown;
}

async function socialLogin(req: FunctionRequest, deps: CloudDeps, spec: SocialLogin) {
  const { Parse } = deps;
  const params = req.params as Record<string, unknown>;
  if (spec.required.some((key) => !params[key])) throw spec.paramsError;
  const { language, appType } = params;
  const clientUser = params.clientUser as Record<string, unknown>;
  if (!clientUser.email) throw CLOUD_ERRORS.EMAIL_MISSING;

  const query = new Parse.Query(Parse.User);
  query.equalTo('email', clientUser.email);
  const user = await query.first({ useMasterKey: true });
  const link = (target: ParseUser) =>
    target.linkWith(
      spec.provider,
      { authData: spec.authData(params, clientUser) },
      { useMasterKey: true },
    );

  if (user) {
    if (!user.get('enabled')) throw CLOUD_ERRORS.ACCOUNT_INACTIVE;
    const loggedUser = await link(user);
    return { newUser: false, sessionToken: loggedUser.getSessionToken() };
  }

  if (params.noNewUser) return { invalidUser: true };
  const username = (clientUser.email as string).split('@')[0] as string;
  const signedUser = new Parse.User();
  const fields = newUserFields({
    username,
    fullname: spec.fullname(clientUser, username),
    password: deps.random.password(),
    email: clientUser.email,
    language,
    appType,
  });
  for (const [key, value] of Object.entries(fields)) signedUser.set(key, value);
  await signedUser.signUp(null, { useMasterKey: true });
  const loggedUser = await link(signedUser);
  return { newUser: true, sessionToken: loggedUser.getSessionToken() };
}

export const authFunctions: FunctionTable = {
  loginWithGoogle: (req, deps) =>
    socialLogin(req, deps, {
      provider: 'google',
      paramsError: CLOUD_ERRORS.LOGIN_WITH_GOOGLE_PARAMS_MISSING,
      required: ['idToken', 'clientUser', 'language', 'appType'],
      authData: (params, clientUser) => ({
        id: clientUser.id,
        id_token: params.idToken,
        photo: clientUser.photo,
      }),
      fullname: (clientUser) => clientUser.name,
    }),

  // No current client calls this; kept for old store builds.
  loginWithFacebook: (req, deps) =>
    socialLogin(req, deps, {
      provider: 'facebook',
      paramsError: CLOUD_ERRORS.LOGIN_WITH_FACEBOOK_PARAMS_MISSING,
      required: ['accessToken', 'expirationDate', 'clientUser', 'language', 'appType'],
      authData: (params, clientUser) => ({
        id: clientUser.id,
        access_token: params.accessToken,
        expiration_date: params.expirationDate,
        // Throws a TypeError when `picture` is missing, like legacy (after sign-up for new users).
        photo: (clientUser.picture as { data: { url: unknown } }).data.url,
      }),
      fullname: (clientUser) => clientUser.name,
    }),

  loginWithApple: (req, deps) =>
    socialLogin(req, deps, {
      provider: 'apple',
      paramsError: CLOUD_ERRORS.LOGIN_WITH_APPLE_PARAMS_MISSING,
      required: ['identityToken', 'clientUser', 'language', 'appType'],
      authData: (params, clientUser) => ({ id: clientUser.id, token: params.identityToken }),
      fullname: (clientUser, username) => clientUser.fullName || username,
    }),

  // Q-4: unauthenticated, and the OTP goes back to the client, which verifies it on-device.
  async verifyPhone(req, deps) {
    const { phoneNumber, appType } = req.params as Record<string, unknown>;
    if (!phoneNumber || !appType) throw CLOUD_ERRORS.VERIFY_PHONE_PARAMS_MISSING;
    const code = deps.random.otp();
    const hashes: Record<string, string> = {
      food: deps.env.SMS_RETRIEVER_HASH_FOOD,
      driver: deps.env.SMS_RETRIEVER_HASH_DRIVER,
      manager: deps.env.SMS_RETRIEVER_HASH_MANAGER,
    };
    // Property access coerces like legacy: appType ['food'] reads hashes.food; unknown → "undefined".
    let msg = deps.env.SMS_MESSAGE_TEMPLATE.replace('%CODE%', code);
    msg += '\n' + hashes[appType as string];
    const res = (await deps.ports.sms.send(phoneNumber as string, msg)) as
      { status?: unknown } | null | undefined;
    if (res?.status !== 'success') throw CLOUD_ERRORS.VERIFY_PHONE_ERROR;
    return { code };
  },
};
