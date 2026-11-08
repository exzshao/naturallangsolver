// Zod schema for the spot parameters the LLM extracts from plain English
// (SPEC §4). Every field except is_poker_spot is nullable and required, which
// is what OpenAI strict structured outputs need (no .optional()). The same
// schema works for providers without a strict mode.
import { z } from "zod";

export const POSITIONS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
export const STREETS = ["preflop", "flop", "turn", "river"] as const;
export const POT_TYPES = ["limped", "srp", "3bet", "4bet"] as const;

export const PositionSchema = z.enum(POSITIONS);
export const StreetSchema = z.enum(STREETS);
export const PotTypeSchema = z.enum(POT_TYPES);

export const AMOUNT_UNITS = ["bb", "chips"] as const;
export const ACTORS = ["hero", "villain"] as const;
export const ACTION_KINDS = ["limp", "open", "raise", "3bet", "4bet", "call", "check", "bet", "fold", "allin"] as const;

export const AmountUnitSchema = z.enum(AMOUNT_UNITS);
export const ActionSchema = z.object({
  street: StreetSchema,
  actor: z.enum(ACTORS),
  action: z.enum(ACTION_KINDS),
  amount: z
    .number()
    .nullable()
    .describe(
      "In the user's units (see amount_unit). open/raise/3bet/4bet: the raise-to total for the street. bet: the bet size. allin: the all-in total if stated. Null for check/call/fold/limp, when not stated, or when the size is given as a share of the pot (use pot_pct).",
    ),
  pot_pct: z
    .number()
    .nullable()
    .describe(
      'Bet or raise size as a percent of the pot when the user gives it that way ("75% pot" -> 75, "half pot" -> 50, "pot" -> 100). Null otherwise.',
    ),
});

export type Position = z.infer<typeof PositionSchema>;
export type Street = z.infer<typeof StreetSchema>;
export type PotType = z.infer<typeof PotTypeSchema>;
export type AmountUnit = z.infer<typeof AmountUnitSchema>;
/** `pot_pct` is required in the LLM schema (strict structured outputs) but optional in code. */
export type Action = Omit<z.infer<typeof ActionSchema>, "pot_pct"> & { pot_pct?: number | null };

export const ExtractionSchema = z.object({
  is_poker_spot: z
    .boolean()
    .describe("False for anything that is not a poker hand or spot."),
  num_players: z
    .number()
    .int()
    .nullable()
    .describe("Number of players who see the flop. Null if not stated or implied."),
  street: StreetSchema.nullable().describe(
    "Street on which the decision happens.",
  ),
  board: z
    .string()
    .nullable()
    .describe('Board cards concatenated, e.g. "Td9d6h" or "Td9d6hQc".'),
  hero_position: PositionSchema.nullable(),
  villain_position: PositionSchema.nullable(),
  hero_hand: z
    .string()
    .nullable()
    .describe('Hero\'s exact hole cards, e.g. "AhKh". Null unless both suits are known.'),
  villain_hand: z
    .string()
    .nullable()
    .describe(
      'Villain\'s hole cards if the user says villain showed or revealed them: exact cards like "7c2d" when both suits are known, else a hand class: "72o" (offsuit), "72s" (suited), "77" (pair), "72" (suitedness unknown). Null otherwise.',
    ),
  pot_type: PotTypeSchema.nullable().describe(
    "srp = single raised pot, 3bet = 3-bet pot, 4bet = 4-bet pot.",
  ),
  pot_bb: z
    .number()
    .nullable()
    .describe("Pot size in big blinds at the start of `street`."),
  effective_stack_bb: z
    .number()
    .nullable()
    .describe(
      "Effective stack in big blinds remaining behind at the start of `street`, after the pot is formed. Null unless the user states the remaining stack; \"100bb deep\" is starting_stack_bb, not this.",
    ),
  starting_stack_bb: z
    .number()
    .nullable()
    .describe('Stack depth before the hand started, e.g. "100bb deep" -> 100.'),
  amount_unit: AmountUnitSchema.nullable().describe(
    'Units of the amounts in `actions`: "bb" if the user gave big blinds, "chips" for chips, dollars, or bare numbers. Null if no amounts.',
  ),
  big_blind_size: z
    .number()
    .nullable()
    .describe('Big blind in the same units as `actions` amounts, e.g. stakes "$1/$2" -> 2. Null unless stated.'),
  actions: z
    .array(ActionSchema)
    .nullable()
    .describe(
      "Betting action in order, all streets up to and including the current one, as the user described it, ending just before the decision hero asks about (never record that decision itself). Null if no action was described.",
    ),
  oop_range: z
    .string()
    .nullable()
    .describe("Out-of-position player's range, PioSOLVER syntax. Only if the user gave one."),
  ip_range: z
    .string()
    .nullable()
    .describe("In-position player's range, PioSOLVER syntax. Only if the user gave one."),
  bet_sizes: z
    .object({
      bet: z.string().nullable().describe('e.g. "33%, 75%"'),
      raise: z.string().nullable().describe('e.g. "3x"'),
    })
    .nullable()
    .describe("Only if the user named bet or raise sizes."),
  notes: z
    .string()
    .nullable()
    .describe("Anything relevant that did not fit elsewhere, e.g. action already taken on the street."),
});

/** Like the LLM schema, with the newer fields (`villain_hand`, `actions[].pot_pct`) optional in code. */
export type Extraction = Omit<z.infer<typeof ExtractionSchema>, "actions" | "villain_hand"> & {
  actions: Action[] | null;
  villain_hand?: string | null;
};
