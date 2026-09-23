import { describe, expect, it } from 'vitest';
import { allFunctions, TRIGGERS } from '../../src/cloud/index.js';

// Inventory §3 (02-contract-inventory.md): nothing may be added or dropped silently.
const LEGACY_FUNCTIONS = [
  'loginWithGoogle',
  'loginWithFacebook',
  'loginWithApple',
  'verifyPhone',
  'calculateOrder',
  'placeOrder',
  'cancelFood',
  'orderRated',
  'savePayment',
  'acceptManager',
  'cancelManager',
  'finishManager',
  'confirmManager',
  'uniquePromo',
  'acceptDriver',
  'checkDriver',
  'cancelDriver',
  'toDestinationDriver',
  'arrivedDriver',
  'finishDriver',
  'deleteFile',
  'loginStaff',
  'updateConfigs',
  'getUsers',
  'addUser',
  'editUser',
  'deleteUsers',
  'toggleEnableUsers',
  'deleteMessages',
  'editPromo',
  'assignPromo',
  'deletePromos',
  'deleteStores',
  'toggleEnableStores',
  'assignManager',
  'assignStoreFile',
  'changeRegion',
  'editList',
  'assignList',
  'deletelists',
  'editProduct',
  'assignProduct',
  'deleteProducts',
  'duplicateProduct',
  'deleteReviews',
  'deleteOrders',
  'editOrder',
  'assignDriver',
  'chooseDriver',
  'sendPush',
];
const LEGACY_TRIGGERS = [
  'beforeLogin',
  'afterLogout',
  'beforeSaveFile',
  'afterSaveFile',
  'afterSave Food',
  'afterDelete Food',
  'afterDelete List',
  'afterSave Promo',
  'afterDelete Promo',
  'afterSave Message',
  'afterSave Review',
];
// Additions over legacy, each a deliberate deviation (01-rewrite-plan.md §9, D-22, D-23, D-24).
const ADDED_FUNCTIONS = [
  'setOpsAccess',
  'setFinanceAccess',
  'declineDriver',
  'authorizeOpsChannel',
  'signOutStaff',
  'removeStaff',
  'recountRatings',
];
const ADDED_TRIGGERS = ['beforeSave _User'];

describe('registry', () => {
  it('registers exactly the 50 legacy cloud functions plus the additions', () => {
    expect(LEGACY_FUNCTIONS).toHaveLength(50);
    expect(Object.keys(allFunctions()).sort()).toEqual(
      [...LEGACY_FUNCTIONS, ...ADDED_FUNCTIONS].sort(),
    );
  });

  it('registers exactly the 11 legacy triggers plus the additions', () => {
    expect(LEGACY_TRIGGERS).toHaveLength(11);
    expect(Object.keys(TRIGGERS).sort()).toEqual([...LEGACY_TRIGGERS, ...ADDED_TRIGGERS].sort());
  });
});
