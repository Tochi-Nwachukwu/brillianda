// Copied from the front end's packages/core/src/booklists.test.ts (24 Oct 2026); its item-schema test is in apps/api/test/booklists.test.ts.
import { describe, expect, it } from "vitest";
import { byCategory, formatNaira, listTotal } from "../src/booklists.js";

describe("book lists", () => {
  it("adds up the priced items, and counts the ones without a price", () => {
    expect(
      listTotal([
        { quantity: 1, price: 4500 },
        { quantity: 12, price: 300 },
        { quantity: 2, price: null },
      ]),
    ).toEqual({ total: 8100, unpriced: 1 });
  });

  it("writes naira with thousands separated", () => {
    expect(formatNaira(12500)).toBe("₦12,500");
  });

  it("groups items in category order", () => {
    const groups = byCategory([
      { category: "uniform" as const, name: "Blazer" },
      { category: "textbook" as const, name: "New General Mathematics 2" },
      { category: "uniform" as const, name: "Socks" },
    ]);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Textbooks", 1],
      ["Uniform", 2],
    ]);
  });
});
