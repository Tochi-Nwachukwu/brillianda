// Copied from the front end's packages/core/src/booklists.ts (24 Oct 2026), without its Zod schemas
// (bookItemSchema, bookListSchema), which live in apps/api/src/routes/booklists.ts with the same rules.
// Books and things needed (user request, 15 Oct 2026): a list for each class level and session,
// which parents see for the class their child is in or moving into.

export const BOOK_CATEGORIES = ["textbook", "stationery", "uniform", "other"] as const;
export type BookCategory = (typeof BOOK_CATEGORIES)[number];
export const BOOK_CATEGORY_LABEL: Record<BookCategory, string> = {
  textbook: "Textbooks",
  stationery: "Exercise books and stationery",
  uniform: "Uniform",
  other: "Other things",
};

/** Naira for one, whole numbers; null when the school doesn't give a price. `detail`: author, publisher, edition, size, or a note. */
export type BookItem = { category: BookCategory; name: string; detail: string; quantity: number; price: number | null };

/** "₦12,500" */
export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString("en-NG")}`;
}

/** The cost of the priced items, and how many have no price (so the total can say it's partial). */
export function listTotal(items: Pick<BookItem, "quantity" | "price">[]): { total: number; unpriced: number } {
  let total = 0;
  let unpriced = 0;
  for (const item of items) {
    if (item.price === null) unpriced++;
    else total += item.price * item.quantity;
  }
  return { total, unpriced };
}

/** The items in category order, each category once, empty ones left out. */
export function byCategory<T extends { category: BookCategory }>(items: T[]): { category: BookCategory; label: string; items: T[] }[] {
  return BOOK_CATEGORIES.map((category) => ({ category, label: BOOK_CATEGORY_LABEL[category], items: items.filter((i) => i.category === category) })).filter(
    (g) => g.items.length > 0,
  );
}
