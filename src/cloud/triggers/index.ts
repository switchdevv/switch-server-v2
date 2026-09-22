// Port of the legacy triggers: cloud/auth/auth.js (login/logout), cloud/files/files.js,
// cloud/food/food.js, cloud/list/list.js, cloud/promo/promo.js, cloud/message/message.js,
// cloud/reviews/reviews.js. Plus one addition: `beforeSave _User`, the boundary behind
// setOpsAccess/setFinanceAccess (functions/staff-access.ts).
//
// afterSave/afterDelete errors are logged and swallowed by Parse Server (4.3 and 9.x alike), and
// the trigger is awaited before the response. The ports below rely on that.
import { addRating } from '../../domain/ratings.js';
import { detach, type CloudDeps, type ParseObject, type ParseUser } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { deleteFileByName, FILE_CLASS } from '../functions/files.js';
import { ACCESS_FIELDS } from '../functions/staff-access.js';
import { notifyStaff } from '../notify.js';
import { CLASSES } from '../pointers.js';

/** The request fields the triggers use (Parse's own request types differ per trigger kind). */
export interface TriggerReq {
  object: ParseObject;
  user?: ParseUser;
  master?: boolean;
}
export interface FileTriggerReq {
  file: InstanceType<CloudDeps['Parse']['File']>;
  user?: ParseUser;
}

export type TriggerSpec =
  | { kind: 'beforeLogin'; handler: (req: TriggerReq, deps: CloudDeps) => Promise<void> }
  | { kind: 'afterLogout'; handler: (req: TriggerReq, deps: CloudDeps) => Promise<void> }
  | {
      kind: 'beforeSaveFile' | 'afterSaveFile';
      handler: (req: FileTriggerReq, deps: CloudDeps) => Promise<void>;
    }
  | {
      kind: 'beforeSave' | 'afterSave' | 'afterDelete';
      className: string;
      handler: (req: TriggerReq, deps: CloudDeps) => Promise<void>;
    };

/** Store `isDiscount` goes false when no discounted product is left (afterSave/afterDelete Food). */
async function disableIsDiscount(req: TriggerReq, deps: CloudDeps): Promise<void> {
  const { Parse } = deps;
  const query = new Parse.Query(CLASSES.product);
  query.equalTo('restaurant', req.object.get('restaurant'));
  query.equalTo('isDiscount', true);
  const count = await query.count({ useMasterKey: true });
  if (count === 0) {
    const query2 = new Parse.Query(CLASSES.store);
    query2.equalTo('objectId', req.object.get('restaurant').id);
    const store = await query2.first({ useMasterKey: true });
    if (store) {
      store.set('isDiscount', false);
      await store.save(null, { useMasterKey: true });
    }
  }
}

export const TRIGGERS: Record<string, TriggerSpec> = {
  beforeLogin: {
    kind: 'beforeLogin',
    async handler({ object: user }) {
      if (!user.get('enabled')) throw CLOUD_ERRORS.ACCOUNT_INACTIVE;
    },
  },

  // Not in legacy. `_User` rows are owner-writable, so without this any account could grant itself
  // Ops/finance access, or give itself a staffType (an Admin one is admin in both consoles). Only
  // master-key writes may: the grant functions, editUser/addUser and Parse Dashboard. A signup
  // may carry no staffType (the apps send none); appType stays free, the apps append to it.
  'beforeSave _User': {
    kind: 'beforeSave',
    className: '_User',
    async handler({ object, master }, { Parse }) {
      if (master) return;
      const created = !object.existed();
      for (const field of [...Object.values(ACCESS_FIELDS), 'staffType']) {
        const refused = created ? object.get(field) != null : object.dirty(field);
        if (refused)
          throw new Parse.Error(
            Parse.Error.OPERATION_FORBIDDEN,
            `${field} can only be changed by an admin.`,
          );
      }
    },
  },

  afterLogout: {
    kind: 'afterLogout',
    async handler({ object: session }, deps) {
      const user = session.get('user');
      user.set('driverActive', false);
      detach(deps, 'afterLogout user.save', user.save(null, { useMasterKey: true }));
    },
  },

  beforeSaveFile: {
    kind: 'beforeSaveFile',
    async handler(req) {
      if (!req.user) throw CLOUD_ERRORS.USER_UNAUTHENTICATED;
    },
  },

  afterSaveFile: {
    kind: 'afterSaveFile',
    async handler({ file, user }, deps) {
      const obj = new deps.Parse.Object(FILE_CLASS);
      obj.set('fileName', file.name());
      obj.set('file', file);
      obj.set('createdBy', user);
      await obj.save(null, { useMasterKey: true });
    },
  },

  'afterSave Food': {
    kind: 'afterSave',
    className: CLASSES.product,
    async handler(req, deps) {
      if (req.object.get('isDiscount')) {
        const query = new deps.Parse.Query(CLASSES.store);
        query.equalTo('objectId', req.object.get('restaurant').id);
        const store = await query.first({ useMasterKey: true });
        if (store) {
          store.set('isDiscount', true);
          await store.save(null, { useMasterKey: true });
        }
      } else {
        await disableIsDiscount(req, deps);
      }
    },
  },

  'afterDelete Food': {
    kind: 'afterDelete',
    className: CLASSES.product,
    handler: disableIsDiscount,
  },

  'afterDelete List': {
    kind: 'afterDelete',
    className: CLASSES.list,
    async handler(req, deps) {
      const query = new deps.Parse.Query(CLASSES.product);
      query.equalTo('list', req.object);
      for (const obj of await query.find({ useMasterKey: true })) {
        await obj.destroy({ useMasterKey: true });
        if (obj.get('picture')) await deleteFileByName(deps, obj.get('picture').name());
      }
    },
  },

  'afterSave Promo': {
    kind: 'afterSave',
    className: CLASSES.promo,
    async handler(req, deps) {
      if (req.object.get('restaurant')) {
        const query = new deps.Parse.Query(CLASSES.store);
        query.equalTo('objectId', req.object.get('restaurant').id);
        const store = await query.first({ useMasterKey: true });
        if (store) {
          store.set('isPromo', true);
          await store.save(null, { useMasterKey: true });
        }
      }
    },
  },

  'afterDelete Promo': {
    kind: 'afterDelete',
    className: CLASSES.promo,
    async handler(req, deps) {
      if (req.object.get('restaurant')) {
        const query = new deps.Parse.Query(CLASSES.promo);
        query.equalTo('restaurant', req.object.get('restaurant'));
        query.greaterThanOrEqualTo('expirationDate', new Date());
        const count = await query.count({ useMasterKey: true });
        if (count === 0) {
          const query2 = new deps.Parse.Query(CLASSES.store);
          query2.equalTo('objectId', req.object.get('restaurant').id);
          const store = await query2.first({ useMasterKey: true });
          if (store) {
            store.set('isPromo', false);
            await store.save(null, { useMasterKey: true });
          }
        }
      }
    },
  },

  'afterSave Message': {
    kind: 'afterSave',
    className: CLASSES.message,
    async handler(req, deps) {
      // Q-8: legacy starts with `req.user.get('city')`, so a save without a user throws here and
      // Parse swallows it. Same effect: do nothing.
      if (!req.user) return;
      if (req.user.get('city')) {
        const objectId = req.object.id;
        await notifyStaff(deps, {
          city: req.user.get('city'),
          objectId,
          page: 'support',
          title: (m) =>
            (m.newMessage as string)
              .replace('%i', '#' + objectId)
              .replace('%s', req.object.get('fullname')),
        });
      }
    },
  },

  'afterSave Review': {
    kind: 'afterSave',
    className: CLASSES.review,
    async handler(req, deps) {
      // Q-8: see afterSave Message. This also stops the re-save below from recursing, since that
      // save runs with the master key and no user. Ratings are added again on every edit.
      if (!req.user) return;
      const { Parse } = deps;
      if (req.user.get('city')) {
        req.object.set('city', req.user.get('city'));
        await req.object.save(null, { useMasterKey: true });
      }
      if (req.object.get('restaurant')) {
        const query = new Parse.Query(CLASSES.store);
        query.equalTo('objectId', req.object.get('restaurant').id);
        const store = await query.first({ useMasterKey: true });
        if (store && store.get('enabled')) {
          const next = addRating(
            { ratingTotal: store.get('ratingTotal'), reviews: store.get('reviews') },
            req.object.get('rating'),
          );
          store.set('ratingTotal', next.ratingTotal);
          store.set('reviews', next.reviews);
          store.set('rating', next.rating);
          await store.save(null, { useMasterKey: true });
        }
      } else if (req.object.get('driver')) {
        const query = new Parse.Query(Parse.User);
        query.equalTo('objectId', req.object.get('driver').id);
        const driver = await query.first({ useMasterKey: true });
        if (driver && driver.get('enabled')) {
          const driverParams = driver.get('driverParams');
          const next = addRating(driverParams, req.object.get('rating'));
          driver.set('driverParams', {
            ...driverParams,
            ratingTotal: next.ratingTotal,
            reviews: next.reviews,
          });
          driver.set('driverRating', next.rating);
          await driver.save(null, { useMasterKey: true });
        }
      }
    },
  },
};
