// The driver wallet's pushes (D-25), in the driver's language. Kept apart from
// src/i18n/translations.json, which stays a byte-identical copy of legacy's. The copy never
// mentions money: the driver app only ever shows orders.

export type WalletPushKind = 'low' | 'empty' | 'topUp';

interface WalletCopy {
  title: string;
  body: string;
}

/** Arabic counted noun: 1 طلب واحد, 2 طلبان, 3–10 طلبات, 11–99 طلبًا, with the hundreds rule. */
export function arabicOrders(n: number): string {
  if (n === 1) return 'طلب واحد';
  if (n === 2) return 'طلبان';
  const rest = n % 100;
  if (rest >= 3 && rest <= 10) return `${n} طلبات`;
  if (rest >= 11) return `${n} طلبًا`;
  return `${n} طلب`;
}

const en = (n: number) => (n === 1 ? '1 order' : `${n} orders`);
const fr = (n: number) => (n === 1 ? '1 commande' : `${n} commandes`);

const COPY: Record<
  'en' | 'fr' | 'ar',
  (kind: WalletPushKind, left: number, added: number) => WalletCopy
> = {
  en: (kind, left, added) => {
    if (kind === 'low')
      return {
        title: `Only ${en(left)} left`,
        body: 'Top up with Switch to keep receiving orders.',
      };
    if (kind === 'empty')
      return { title: 'No orders left', body: 'Top up with Switch to go online again.' };
    return { title: `${en(added)} added`, body: `You now have ${en(left)}.` };
  },
  fr: (kind, left, added) => {
    if (kind === 'low')
      return {
        title: left === 1 ? 'Plus qu’une commande' : `Plus que ${fr(left)}`,
        body: 'Rechargez auprès de Switch pour continuer à recevoir des commandes.',
      };
    if (kind === 'empty')
      return {
        title: 'Plus aucune commande prépayée',
        body: 'Rechargez auprès de Switch pour vous reconnecter.',
      };
    return {
      title: added === 1 ? '1 commande ajoutée' : `${fr(added)} ajoutées`,
      body: `Vous avez maintenant ${fr(left)}.`,
    };
  },
  ar: (kind, left, added) => {
    if (kind === 'low')
      return {
        title: `لم يتبقَّ سوى ${arabicOrders(left)}`,
        body: 'اشحن رصيدك لدى Switch لتواصل استلام الطلبات.',
      };
    if (kind === 'empty')
      return {
        title: 'نفد رصيد طلباتك',
        body: 'اشحن رصيدك لدى Switch لتتمكن من الاتصال مجددًا.',
      };
    return { title: `تمت إضافة ${arabicOrders(added)}`, body: `رصيدك الآن ${arabicOrders(left)}.` };
  },
};

/** The push copy. Unlike legacy's `messagesFor`, an unknown language falls back to English. */
export function walletPushCopy(
  language: string,
  kind: WalletPushKind,
  ordersLeft: number,
  ordersAdded = 0,
): WalletCopy {
  const copy = COPY[language as keyof typeof COPY] ?? COPY.en;
  return copy(kind, ordersLeft, ordersAdded);
}
