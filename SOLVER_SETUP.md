# Simple Solver UI Setup

## What I Built

A minimal web UI for the poker solver with:
- Input form for ranges, board cards, pot/stack sizes
- Simple solve button
- Results display showing:
  - Action frequencies (Check 35%, Bet 45%, etc.)
  - Top hands by equity
  - Exploitability metric

## How to Run

### 1. Make sure Python bindings are installed

```bash
cd rust/py-adapt
maturin develop --release
```

### 2. Start the backend

```bash
cd backend
source ../venv/bin/activate  # If using venv
python main.py
# or
uvicorn main:app --reload
```

Backend runs on: `http://localhost:8000`

### 3. Start the frontend

```bash
cd frontend
npm run dev
```

Frontend runs on: `http://localhost:3000`

### 4. Access the Solver

Go to: **http://localhost:3000/solver**

Or click "→ Simple Solver UI" button on the main page.

## Usage Example

1. **Set Ranges:**
   - OOP: `66+,A8s+,A5s-A4s,AJo+,K9s+,KQo,QTs+,JTs`
   - IP: `QQ-22,AQs-A2s,ATo+,K5s+,KJo+`

2. **Set Board:**
   - Flop: `Td9d6h`
   - Turn: `Qc`
   - River: (leave empty)

3. **Set Pot/Stack:**
   - Starting Pot: `200`
   - Effective Stack: `900`

4. **Bet Sizing:**
   - Bet Sizes: `60%, e, a` (60% pot, geometric, all-in)
   - Raise Sizes: `2.5x` (2.5x previous bet)

5. Click **"Solve"**

6. **Results show:**
   ```
   Check: 35.2%  ████████████░░░░░░░░░░░░░░░░░░░░
   Bet(120): 44.8%  ████████████████████░░░░░░░░░░░
   AllIn(900): 20.0%  ██████████░░░░░░░░░░░░░░░░░░░
   ```

## API Endpoint

The solver endpoint is at: `POST http://localhost:8000/solve`

Request body:
```json
{
  "oop_range": "66+,A8s+",
  "ip_range": "QQ-22,AQs-A2s",
  "flop": "Td9d6h",
  "turn": "Qc",
  "river": null,
  "starting_pot": 200,
  "effective_stack": 900,
  "bet_sizes": "60%, e, a",
  "raise_sizes": "2.5x",
  "max_iterations": 1000,
  "target_exploitability": 1.0
}
```

Response:
```json
{
  "exploitability": 1.23,
  "actions": ["Check", "Bet(120)", "AllIn(900)"],
  "frequencies": [["Check", 0.352], ["Bet(120)", 0.448], ["AllIn(900)", 0.200]],
  "hands": ["5c4c", "Ac4c", "5d4d", ...],
  "equity": [0.45, 0.62, 0.38, ...]
}
```

## Range Notation

- **Pairs:** `AA`, `KK`, `22+` (22 and up)
- **Suited:** `AKs`, `A8s+` (A8s through AKs)
- **Offsuit:** `AKo`, `KQo`
- **Ranges:** `66+`, `A5s-A4s`
- **Combined:** `66+,A8s+,AJo+,K9s+`

## Board Card Notation

Format: `Rank` + `Suit`
- Ranks: `2-9`, `T` (ten), `J`, `Q`, `K`, `A`
- Suits: `c` (clubs), `d` (diamonds), `h` (hearts), `s` (spades)

Examples:
- `Td9d6h` = Ten of diamonds, 9 of diamonds, 6 of hearts
- `Qc` = Queen of clubs
- `7s` = 7 of spades

## Bet Size Notation

### Bet Sizes:
- **Percentage:** `50%`, `75%` (percentage of pot)
- **Geometric:** `e` (sizes pot for river to equal remaining stack)
- **All-in:** `a`
- **Combined:** `60%, e, a`

### Raise Sizes:
- **Multiplier:** `2.5x` (2.5 times the bet)
- **Multiple:** `2x, 3x`

## Performance Notes

- First solve takes 5-30 seconds depending on tree complexity
- Exploitability < 1.0 is good (< 1% of pot)
- More iterations = more accurate but slower
- Compression can reduce memory (not currently exposed in UI)

## Troubleshooting

**"Invalid OOP range" error:**
- Check range notation: `66+,A8s+,AJo+`
- No spaces in ranges
- Use commas to separate

**"Invalid flop" error:**
- Must be exactly 3 cards
- Format: `Td9d6h` (rank + suit, no spaces)

**Solver taking too long:**
- Reduce max_iterations (try 500)
- Simplify bet sizes (fewer options = faster)
- Start with turn/river spots (smaller tree)

## Next Steps

You can enhance this UI by adding:
- Hand-specific strategy viewer
- Save/load scenarios
- Comparison mode (compare different boards)
- EV visualization
- Range visualization grid

