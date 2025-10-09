"""LLM orchestration helpers.

This module contains the minimal glue for the POC:
- An OpenAI tool schema describing the `solve_postflop` function.
- Light parsing/normalization utilities for user-provided board strings.
- A mapper that converts tool arguments into the Rust solver's request shape.
- A single-pass chat function that asks the LLM to call the tool once, then
  calls the Rust solver and returns a short confirmation plus raw solver JSON.
"""

import json
from typing import List, Dict, Any
from openai import OpenAI
from .config import settings
from .schemas import (
    ChatMessage,
    ChatResponse,
    ToolSolveArgs,
    SolverSolveRequest,
)
from .solver_client import solve as call_solver


system_prompt = (
    "You are a poker strategy assistant. Use the tool to compute numbers. "
    "Do not invent equities or actions. If inputs are missing, ask concise questions."
)


def tool_schema() -> Dict[str, Any]:
    """Return the OpenAI tool (function) schema for `solve_postflop`.

    The schema instructs the model what arguments are needed to perform a solve.
    We keep it intentionally small for the POC; stricter validation happens in
    the Rust service, which will reject invalid inputs.
    """
    return {
        "type": "function",
        "function": {
            "name": "solve_postflop",
            "description": "Compute GTO strategy for a postflop spot.",
            "parameters": {
                "type": "object",
                "properties": {
                    "oop_range": {"type": "string"},
                    "ip_range": {"type": "string"},
                    "board": {"type": "string"},
                    "starting_pot": {"type": "integer"},
                    "effective_stack": {"type": "integer"},
                    "flop_bet_sizes": {"type": "string"},
                    "turn_bet_sizes": {"type": "string"},
                    "river_bet_sizes": {"type": "string"},
                    "turn_donk_sizes": {"type": "string"},
                    "river_donk_sizes": {"type": "string"},
                    "max_iters": {"type": "integer"},
                    "target_exploitability": {"type": "number"},
                },
                "required": [
                    "oop_range",
                    "ip_range",
                    "board",
                    "starting_pot",
                    "effective_stack",
                    "flop_bet_sizes",
                    "turn_bet_sizes",
                    "river_bet_sizes",
                    "max_iters",
                ],
            },
        },
    }


def parse_board(board: str) -> Dict[str, Any]:
    """Parse a compact board string into flop/turn/river parts.

    Expected formats (compact):
    - "Td9d6h" (flop only)
    - "Td9d6hQc" (flop + turn)
    - "Td9d6hQc2s" (flop + turn + river)

    Notes:
    - This is a lenient POC parser; it does not sanitize ranks/suits beyond
      simple slicing. The Rust service performs domain validation.
    """
    s = board.strip()
    flop = s[:6]
    turn = s[6:8] if len(s) >= 8 else None
    river = s[8:10] if len(s) >= 10 else None
    return {"flop": flop, "turn": turn, "river": river}


def to_solver_request(args: ToolSolveArgs) -> SolverSolveRequest:
    """Map tool arguments into the Rust solver `/solve` request payload.

    - Duplicates the same bet-size string for both players per street (POC).
    - Sets reasonable defaults for thresholds and rake fields.
    - Leaves compression/verbosity off for faster iteration.
    """
    board = parse_board(args.board)

    def sizes_pair(s: str) -> list[str]:
        return [s, s]

    config = {
        "card_config": {
            "range": [args.oop_range, args.ip_range],
            "flop": board["flop"],
            "turn": board["turn"],
            "river": board["river"],
        },
        "tree_config": {
            "starting_pot": args.starting_pot,
            "effective_stack": args.effective_stack,
            "rake_rate": 0.0,
            "rake_cap": 0.0,
            "flop_bet_sizes": sizes_pair(args.flop_bet_sizes),
            "turn_bet_sizes": sizes_pair(args.turn_bet_sizes),
            "river_bet_sizes": sizes_pair(args.river_bet_sizes),
            "turn_donk_sizes": args.turn_donk_sizes,
            "river_donk_sizes": args.river_donk_sizes,
            "add_allin_threshold": 1.5,
            "force_allin_threshold": 0.15,
            "merging_threshold": 0.1,
        },
    }

    options = {
        "max_iters": args.max_iters,
        "target_exploitability": args.target_exploitability,
        "compressed": False,
        "verbose": False,
    }

    return SolverSolveRequest(config=config, options=options)


async def chat_with_tools(messages: List[ChatMessage]) -> ChatResponse:
    """Single-pass chat orchestration.

    Steps:
    1) Send a system prompt + user messages to OpenAI with the tool schema.
    2) If the model calls `solve_postflop`, parse args and call the Rust solver.
    3) Return a short confirmation string plus the raw solver JSON.
       (No second model pass in the POC.)
    4) If no tool call is made, return the assistant text, possibly asking for
       missing inputs.
    """
    client = OpenAI(api_key=settings.openai_api_key)

    oai_messages = [
        {"role": "system", "content": system_prompt},
        *[{"role": m.role, "content": m.content} for m in messages],
    ]

    resp = client.chat.completions.create(
        model=settings.model,
        messages=oai_messages,
        tools=[tool_schema()],
        tool_choice="auto",
        temperature=0.2,
        max_tokens=settings.max_llm_tokens,
    )

    choice = resp.choices[0]
    tool_calls = choice.message.tool_calls or []

    # Single-pass POC: if tool used, call solver and return a short confirmation; no second LLM round
    if tool_calls:
        for call in tool_calls:
            if call.function.name == "solve_postflop":
                raw_args = json.loads(call.function.arguments or "{}")
                args = ToolSolveArgs(**raw_args)
                solver_req = to_solver_request(args)
                solver_payload = await call_solver(solver_req)
                text = "Computed strategy using solver. Showing raw results."
                return ChatResponse(message=ChatMessage(role="assistant", content=text), solver=solver_payload)

    # No tool used; return the assistant text
    assistant_text = choice.message.content or "I need more details (ranges, board, stacks, bet sizes)."
    return ChatResponse(message=ChatMessage(role="assistant", content=assistant_text), solver=None)


