import type { ParseObject, ParseSdk } from './context.js';

export const CLASSES = {
  order: 'Order',
  store: 'Restaurant',
  product: 'Food',
  list: 'List',
  address: 'Address',
  promo: 'Promo',
  review: 'Review',
  region: 'City',
  message: 'Message',
  file: 'FileObject',
} as const;

/**
 * Legacy `const X = Parse.Object.extend(CLASS); const o = new X(); o.id = id;` — an unsaved
 * object that encodes as a pointer. For `_User` legacy used `Parse.Object.extend(Parse.User)`,
 * which yields the same `_User` pointer.
 */
export function pointer(Parse: ParseSdk, className: string, id: unknown): ParseObject {
  const obj = className === '_User' ? new Parse.User() : new Parse.Object(className);
  obj.id = id as string;
  return obj;
}
