// When to ask for a review. The panel shows one small, quiet line at the
// bottom asking for a review on the Chrome Web Store, once, and only to people
// who have really used the extension: at least ASK_AFTER_DAYS after they first
// opened the tree, on at least ASK_AFTER_DAYS_USED different days. Either
// button hides it for good. The count stays on this computer (storage.local)
// and is never sent anywhere.

export const ASK_AFTER_DAYS = 14;
export const ASK_AFTER_DAYS_USED = 7;
export const REVIEW_URL =
  'https://chromewebstore.google.com/detail/tree-of-tabs/goknfcebnofoghkgcmpjhlokkgefbokm/reviews';

/** Today as a day number in the user's time zone, so a "day" starts at local midnight. */
export function today(now = new Date()) {
  return Math.floor((now.getTime() - now.getTimezoneOffset() * 60000) / 86400000);
}

/** The usage record ({ firstDay, lastDay, daysUsed }) after using the tree on `day`. */
export function countDay(usage, day) {
  if (!usage?.firstDay) return { firstDay: day, lastDay: day, daysUsed: 1 };
  if (day <= usage.lastDay) return usage;
  return { ...usage, lastDay: day, daysUsed: usage.daysUsed + 1 };
}

/** Whether to ask for a review on `day`. */
export function shouldAsk(usage, day) {
  return Boolean(usage?.firstDay) && day - usage.firstDay >= ASK_AFTER_DAYS && usage.daysUsed >= ASK_AFTER_DAYS_USED;
}
