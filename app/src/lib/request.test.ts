import { describe, expect, it } from "vitest";
import { applyDefaults, DEFAULTS } from "./defaults";
import { buildSolverRequest, prepareSolve } from "./request";
import { extraction } from "./test-helpers";

describe("buildSolverRequest (§7)", () => {
  it("maps the default spot to the solver contract with chips", () => {
    const { spot } = applyDefaults(extraction({ hero_hand: "AhKh" }));
    expect(buildSolverRequest(spot)).toEqual({
      board: "Td9d6h",
      oop_range: DEFAULTS.ranges["srp:BTNvBB"]!.oop,
      ip_range: DEFAULTS.ranges["srp:BTNvBB"]!.ip,
      starting_pot: 550,
      effective_stack: 9750,
      bet_sizes: {
        flop: { bet: "33%, 75%", raise: "", oop: { bet: "", raise: "3x" } },
        turn: { bet: "75%", raise: "", donk: "" },
        river: { bet: "75%", raise: "", donk: "" },
      },
      bet_size_fallbacks: [
        {
          flop: { bet: "33%", raise: "", oop: { bet: "", raise: "3x" } },
          turn: { bet: "75%", raise: "", donk: "" },
          river: { bet: "75%", raise: "", donk: "" },
        },
      ],
      preflop_aggressor: "ip",
      hero: { player: "ip", hand: "AhKh" },
      max_iterations: 1000,
      target_exploitability_pct: 0.5,
    });
  });

  it("puts ranges in OOP/IP slots by position, not by hero/villain", () => {
    const req = buildSolverRequest(
      applyDefaults(
        extraction({ hero_position: "BTN", villain_position: "SB", pot_type: "3bet", oop_range: "QQ+", ip_range: "JJ-99" }),
      ).spot,
    );
    expect(req.oop_range).toBe("QQ+");
    expect(req.ip_range).toBe("JJ-99");
    expect(req.hero.player).toBe("ip");

    const req2 = buildSolverRequest(
      applyDefaults(extraction({ hero_position: "SB", villain_position: "BTN", pot_type: "3bet" })).spot,
    );
    expect(req2.hero.player).toBe("oop");
    expect(req2.oop_range).toBe(DEFAULTS.ranges["3bet:BTNvSB"]!.oop);
  });

  it("converts fractional bb to rounded chips", () => {
    const req = buildSolverRequest(
      applyDefaults(extraction({ pot_bb: 6.255, effective_stack_bb: 93.333 })).spot,
    );
    expect(req.starting_pot).toBe(626);
    expect(req.effective_stack).toBe(9333);
    expect(Number.isInteger(req.starting_pot) && Number.isInteger(req.effective_stack)).toBe(true);
  });

  it("hero hand null stays null", () => {
    expect(buildSolverRequest(applyDefaults(extraction()).spot).hero).toEqual({ player: "ip", hand: null });
  });
});

describe("prepareSolve", () => {
  it("returns a request and assumptions for a solvable spot", () => {
    const r = prepareSolve(extraction());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.starting_pot).toBe(550);
      expect(r.assumptions.length).toBeGreaterThan(0);
    }
  });

  it("returns the early validation error", () => {
    expect(prepareSolve(extraction({ is_poker_spot: false }))).toEqual({
      ok: false,
      error: { status: "cant_solve", reason: "NOT_POKER", message: expect.any(String) },
    });
  });

  it("returns the post-defaults validation error", () => {
    const r = prepareSolve(extraction({ pot_bb: 250 }));
    expect(r.ok === false && r.error.reason).toBe("INVALID_STACKS");
  });
});
