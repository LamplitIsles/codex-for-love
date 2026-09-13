// Imported from LamplitIsles/dsh-plugins (Apache-2.0); see docs/IMPORTS.md.
import { randomInt } from "node:crypto";

export const MAX_COUNT = 100;
export const MAX_SIDES = 1_000_000;
export const MAX_MODIFIER = 1_000_000;
export const MAX_LABEL_LENGTH = 200;

export interface DiceResult {
  count: number;
  sides: number;
  rolls: number[];
  modifier: number;
  total: number;
  label?: string;
}

function integer(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${field} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/** The injected draw uses randomInt's inclusive minimum and exclusive maximum. */
export function rollDice(
  input: unknown,
  draw: (min: number, max: number) => number = randomInt,
): DiceResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(
      "Provide an object with count, sides, optional modifier, and optional label.",
    );
  }
  const args = input as Record<string, unknown>;
  if (
    Object.keys(args).some(
      (key) => !["count", "sides", "modifier", "label"].includes(key),
    )
  ) {
    throw new Error("Only count, sides, modifier, and label are accepted.");
  }
  const count = integer(
    args.count === undefined ? 1 : args.count,
    "count",
    1,
    MAX_COUNT,
  );
  const sides = integer(args.sides, "sides", 2, MAX_SIDES);
  const modifier = integer(
    args.modifier === undefined ? 0 : args.modifier,
    "modifier",
    -MAX_MODIFIER,
    MAX_MODIFIER,
  );
  const label = args.label;
  if (
    label !== undefined &&
    (typeof label !== "string" || label.length > MAX_LABEL_LENGTH)
  ) {
    throw new Error(
      `label must be a string of at most ${MAX_LABEL_LENGTH} characters.`,
    );
  }
  const rolls = Array.from({ length: count }, () => draw(1, sides + 1));
  const total = rolls.reduce((sum, roll) => sum + roll, modifier);
  return {
    count,
    sides,
    rolls,
    modifier,
    total,
    ...(label === undefined ? {} : { label }),
  };
}
