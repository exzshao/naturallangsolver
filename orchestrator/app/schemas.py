from typing import List, Literal, Optional, Any, Dict
from pydantic import BaseModel, Field, validator


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str


class ChatRequest(BaseModel):
    messages: List[ChatMessage]


class ToolSolveArgs(BaseModel):
    oop_range: str
    ip_range: str
    board: str
    starting_pot: int
    effective_stack: int
    flop_bet_sizes: str
    turn_bet_sizes: str
    river_bet_sizes: str
    turn_donk_sizes: Optional[str] = None
    river_donk_sizes: Optional[str] = None
    max_iters: int = 100
    target_exploitability: Optional[float] = None

    @validator("board")
    def board_nonempty(cls, v: str) -> str:
        if not v or len(v.strip()) == 0:
            raise ValueError("board must be provided")
        return v


class SolverSolveRequest(BaseModel):
    config: Dict[str, Any]
    options: Dict[str, Any]
    node_path: List[int] = []
    lock_strategy: Optional[List[float]] = None


class SolverCardAction(BaseModel):
    index: int
    card: str


class SolverAverages(BaseModel):
    equity_p0: float
    equity_p1: float
    ev_p0: float
    ev_p1: float


class SolverSolveResponse(BaseModel):
    exploitability: float
    available_actions: List[str]
    chance_cards: Optional[List[SolverCardAction]] = None
    node_path: List[int]
    averages: SolverAverages
    zero_sum_ev: List[float]
    warnings: List[str] = []


class ChatResponse(BaseModel):
    message: ChatMessage
    solver: Optional[SolverSolveResponse] = None


