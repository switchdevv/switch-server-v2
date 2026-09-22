import type { ParseSdk } from './context.js';

interface RestController {
  request(
    method: string,
    path: string,
    data?: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  ajax: unknown;
  handleError: unknown;
}

interface CoreManagerLike {
  getRESTController(): RestController;
  setRESTController(controller: RestController): void;
  getInstallationController(): { currentInstallationId(): Promise<string> };
}

const roundTrip = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/**
 * Legacy cloud code reached Parse Server over HTTP (directAccess off, serverURL = public URL). v2
 * keeps the in-process controller (no network hop) but restores the two things HTTP gave it:
 *
 * 1. JSON semantics, both ways. `obj.set('staffType', undefined)` sent no `staffType` key and left
 *    the field alone. In-process, the body object reaches Parse Server as is and `undefined` is
 *    stored as `null` — new users would get `phone: null`, `picture: null`, …, and `editUser`
 *    would null `staffType`.
 *
 * 2. The SDK's installation id. Over HTTP the SDK sends its own id with every request. In-process
 *    (and for master-key requests without one) Parse Server uses `'cloud'`, and it never creates
 *    session tokens for `'cloud'` — so `linkWith`/`signUp` in loginWith* would return no
 *    `sessionToken` and the apps' Google/Apple sign-in would break.
 *
 * Must run after Parse Server installed its controller (the `parseServer.app` getter) and before
 * any cloud code runs.
 */
export function makeDirectAccessWireFaithful(Parse: ParseSdk): void {
  const CoreManager = (Parse as unknown as { CoreManager: CoreManagerLike }).CoreManager;
  const inner = CoreManager.getRESTController();
  const installations = CoreManager.getInstallationController();
  CoreManager.setRESTController({
    ajax: inner.ajax,
    handleError: inner.handleError,
    async request(method, path, data, options = {}) {
      const installationId =
        (options.installationId as string | undefined) ??
        (await installations.currentInstallationId());
      const response = await inner.request(method, path, roundTrip(data), {
        ...options,
        installationId,
      });
      return roundTrip(response);
    },
  });
}
