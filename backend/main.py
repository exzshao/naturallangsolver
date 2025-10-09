from openai import OpenAI
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime
from typing import Optional, List
import asyncio
from concurrent.futures import ThreadPoolExecutor
from postflop_solver_python import PostFlopSolver

load_dotenv()
client = OpenAI()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # Your Next.js frontend URL
    # allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Thread pool for CPU-intensive Rust operations
executor = ThreadPoolExecutor(max_workers=4)

class Ranges(BaseModel):
    ip_range: List[str]
    oop_range: List[str]

class SolverInferData(BaseModel): # TODO: this should actually just contain -> player specific hand, flop, turn, river, actions
    flop: str
    turn: Optional[str] = None
    river: Optional[str] = None
    player_hand: Optional[str] = None
    # bet_sizes: Optional[str] = None # TODO remove bet sizes and raise sizes from this and add as separate UI cuz LLM gets confused.
    # raise_sizes: Optional[str] = None
    actions: Optional[List[str]] = None
    other_notes: Optional[str] = None

class BetAndRaiseSizes(BaseModel):
    bet_sizes: List[int]
    raise_sizes: List[int]

class SolveRequest(BaseModel):
    # Required parameters
    oop_range: str
    ip_range: str
    flop: str
    starting_pot: int
    effective_stack: int
    
    # Optional with sensible defaults
    bet_sizes: str = "60%, e, a"
    raise_sizes: str = "2.5x"
    turn: Optional[str] = None
    river: Optional[str] = None
    max_iterations: int = 1000
    target_exploitability: float = 1.0
    
    # Advanced options (rarely needed, defaults don't affect behavior)
    rake_rate: float = 0.0
    rake_cap: float = 0.0
    enable_compression: bool = False

ranges = {
    "ip_range": [],
    "oop_range": []
}

@app.post("/solve")
async def solve_poker_scenario(request: SolveRequest):
    """
    Solve a poker scenario using native Rust solver.
    """
    
    def run_solver():
        try:
            # Create Rust solver instance (simple by default!)
            solver = PostFlopSolver(
                oop_range=request.oop_range,
                ip_range=request.ip_range,
                flop=request.flop,
                starting_pot=request.starting_pot,
                effective_stack=request.effective_stack,
                bet_sizes=request.bet_sizes,
                raise_sizes=request.raise_sizes,
                turn=request.turn,
                river=request.river,
                rake_rate=request.rake_rate,
                rake_cap=request.rake_cap
            )
            
            # Run the solver (CPU-intensive Rust code)
            exploitability = solver.solve(
                max_iterations=request.max_iterations,
                target_exploitability=request.target_exploitability,
                enable_compression=request.enable_compression
            )
            
            # Extract results
            actions = solver.get_available_actions()
            frequencies = solver.get_action_frequencies()
            hands = solver.get_private_cards(player=0)
            equity = solver.get_equity(player=0)
            
            return {
                "exploitability": exploitability,
                "actions": actions,
                "frequencies": frequencies,
                "hands": hands,
                "equity": equity
            }
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
    
    # Run on thread pool to avoid blocking event loop
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(executor, run_solver)
    
    return result

@app.post("/api/ranges")
async def handle_ranges(data: Ranges):
    ranges["ip_range"] = data.ip_range
    ranges["oop_range"] = data.oop_range
    return {
        "received_ranges": {
            "ip_range": data.ip_range,
            "oop_range": data.oop_range
        },
        "status": "success"
    }

@app.post("/api/chat")
async def handle_chat(data: dict):
    completion = client.beta.chat.completions.parse(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": f"""
                Extract structured poker solver data from user messages. 
                Return the data in JSON format matching this schema:
                {{
                    "flop": "<Flop cards> or null if not provided",
                    "turn": "<Turn card> or null if not provided",
                    "river": "<River card> or null if not provided",
                    "player_hand": "<Player hand> or null if not provided",
                    "actions": ["<action1>", "<action2>", ...],
                    "other_notes": "<Other notes> or null if not provided"
                }}

                IMPORTANT:
                1. All card values must be standardized to abbreviated format. For example, output "Qd" for "queen of diamonds", "10h" for "10 of hearts", "5s" for "5 of spades", etc. Even if the user writes full names (e.g., "queen of dimonds, 10 of hearts, 5 of spades"), output the cards as "Qd", "10h", "5s".
                2. If a card's suit is not specified (e.g., just "queen"), choose a random valid suit (c, d, h, or s) and output in abbreviated format.
                3. All actions should be standardized. Use lower-case action names and a consistent format. For example, output actions as "check", "fold", "call", "bet(<amount>)", "raise(<amount>)", "allin(<amount>)".
                4. Any parts of the message that are not relevant to the structured data should go in other notes.
             """},
            {"role": "user", "content": data["message"]}
        ],
        response_format=SolverInferData,
    )
    # TODO: Also need to extract ACTIONS from user message and play these actions in solver.
    solver_data = completion.choices[0].message.parsed
    return {
        "response": completion.choices[0].message.content,
        "solver_data": solver_data.dict(),
        "current_range": ranges
    }


# completion = client.chat.completions.create(
#     model="gpt-4o-mini",
#     messages=[
#         {"role": "system", "content": "You are an assistant that helps users with poker-related questions and provides accurate information about possible boards. Be brief."},
#         {"role": "user", "content": "Button opens for 3bb, I call on bb. What would be a typical range for me and button? Output the range in comma-separated format using standard notation (e.g., 'AA,KK,AKs')"}
#     ]
# )

# print(completion.choices[0].message.content)