import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Byte-identical copy of legacy cloud/localization/translations.json (en, fr, ar). */
export const translations = require('../i18n/translations.json') as Record<
  string,
  { messages: Record<string, string> }
>;

export type Messages = Record<string, string>;

/**
 * `translations[language].messages`, unguarded on purpose (Q-11): a language outside en/fr/ar
 * throws a TypeError exactly where legacy does, after the DB writes that precede the push.
 */
export function messagesFor(language: string): Messages {
  return (translations[language] as { messages: Messages }).messages;
}

/** `user.get('language') || 'en'` */
export function languageOf(user: { get(key: string): unknown }): string {
  return (user.get('language') as string) || 'en';
}

/** Legacy `title.replace('%s', '#' + objectId)`: first occurrence only. */
export function withOrder(template: string | undefined, objectId: unknown): string {
  return (template as string).replace('%s', '#' + String(objectId));
}
