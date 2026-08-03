import { describe, expect, it } from "vitest";

import {
  MoneyParseError,
  parseMoneyAtomic,
  parsePositiveMoneyAtomic,
} from "../src/core/money.js";

const USDC = { symbol: "USDC", decimals: 6 } as const;

describe("integer money parsing", () => {
  it.each([
    ["1 USDC", 1_000_000n],
    ["0.50 USDC", 500_000n],
    ["0.000001 USDC", 1n],
    ["9007199254740993 USDC", 9_007_199_254_740_993_000_000n],
    ["0 USDC", 0n],
  ])("parses %s exactly", (input, expected) => {
    expect(parseMoneyAtomic(input, USDC)).toBe(expected);
  });

  it("rejects JS numbers and non-canonical decimal strings", () => {
    try {
      parseMoneyAtomic(0.1, USDC);
      throw new Error("Expected JS number to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MoneyParseError);
      expect((error as MoneyParseError).reason).toBe("number-not-allowed");
    }
    for (const input of [
      "01 USDC",
      "+1 USDC",
      "1e3 USDC",
      "1.0000000 USDC",
      "1  USDC",
      "1 usdc",
      "1 USDT",
      " 1 USDC",
      `${"9".repeat(73)} USDC`,
    ]) {
      expect(() => parseMoneyAtomic(input, USDC), input).toThrow(MoneyParseError);
    }
    try {
      parsePositiveMoneyAtomic("0 USDC", USDC);
      throw new Error("Expected zero positive money to fail");
    } catch (error) {
      expect((error as MoneyParseError).reason).toBe("amount-must-be-positive");
    }
  });

  it("property: decimal placement is equivalent to integer string construction", () => {
    let state = 0x402_402;
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const whole = BigInt(state);
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const fractionalDigits = state % 7;
      const fraction = String(state % 1_000_000)
        .padStart(6, "0")
        .slice(0, fractionalDigits);
      const text = `${whole}${fraction.length === 0 ? "" : `.${fraction}`} USDC`;
      const expected = whole * 1_000_000n + BigInt((fraction || "0").padEnd(6, "0"));
      expect(parseMoneyAtomic(text, USDC)).toBe(expected);
    }
  });
});
