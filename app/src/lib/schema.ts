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

export type Position = z.infer<typeof PositionSchema>;
export type Street = z.infer<typeof StreetSchema>;
export type PotType = z.infer<typeof PotTypeSchema>;

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

export type Extraction = z.infer<typeof ExtractionSchema>;
