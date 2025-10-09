# Quick Start Guide

## Run Everything (3 Commands)

```bash
# Terminal 1 - Build Python bindings (one-time)
cd rust/py-adapt && maturin develop --release

# Terminal 2 - Backend
cd backend && uvicorn main:app --reload

# Terminal 3 - Frontend  
cd frontend && npm run dev
```

Then visit: **http://localhost:3000/solver**

---

## Example Scenario

**Common 3-bet Pot Situation:**

- **OOP Range:** `QQ+,AKs,AKo`
- **IP Range:** `88+,AJs+,AQo+,KQs`
- **Flop:** `Kh9d3c`
- **Turn:** `7s`
- **Starting Pot:** `300` (after 3-bet)
- **Effective Stack:** `1200`
- **Bet Sizes:** `50%, 75%, a`
- **Raise Sizes:** `2.5x`

**Expected Result:**
- OOP should c-bet frequently with top pair+
- Some checking with medium strength
- IP calls with pairs, raises with strong kings

---

## Notation Cheat Sheet

### Ranges
```
AA, KK, QQ      = Specific pairs
22+             = All pairs 22 through AA
AKs             = Ace-King suited
AKo             = Ace-King offsuit
A8s+            = A8s, A9s, ATs, AJs, AQs, AKs
KQo, AJo+       = Multiple combos separated by comma
```

### Cards
```
Rank: 2-9, T (ten), J, Q, K, A
Suit: c (clubs), d (diamonds), h (hearts), s (spades)

Example: Td9d6h = T♦ 9♦ 6♥
```

### Bet Sizes
```
50%     = 50% of pot
75%     = 75% of pot
e       = geometric (sizes pot for river = stack)
a       = all-in
2.5x    = 2.5 times the previous bet
```

---

## API Quick Reference

```bash
curl -X POST http://localhost:8000/solve \
  -H "Content-Type: application/json" \
  -d '{
    "oop_range": "QQ+,AKs",
    "ip_range": "88+,AJs+",
    "flop": "Kh9d3c",
    "turn": "7s",
    "starting_pot": 300,
    "effective_stack": 1200,
    "bet_sizes": "50%, 75%, a",
    "raise_sizes": "2.5x"
  }'
```

---

## Python Usage

```python
from postflop_solver_python import PostFlopSolver

solver = PostFlopSolver(
    oop_range="QQ+,AKs",
    ip_range="88+,AJs+",
    flop="Kh9d3c",
    starting_pot=300,
    effective_stack=1200,
    bet_sizes="50%, 75%, a",
    raise_sizes="2.5x",
    turn="7s"
)

exploitability = solver.solve(1000, 1.0)
frequencies = solver.get_action_frequencies()

for action, freq in frequencies:
    print(f"{action}: {freq*100:.1f}%")
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Invalid range" | Check notation: `66+,A8s+` (no spaces) |
| "Invalid flop" | Must be 3 cards: `Td9d6h` |
| Solver too slow | Reduce iterations or simplify bet sizes |
| Port 8000 in use | Kill other process or change port |
| Module not found | Run `maturin develop` in `rust/py-adapt` |

---

## What Each Value Means

**Exploitability:** How much $ opponent can win by deviating
- < 1.0 = Good (less than 1 chip per hand)
- < 0.5 = Very good
- < 0.1 = Excellent

**Action Frequencies:** % of range taking each action
- Example: Check 35%, Bet 50%, All-in 15%

**Equity:** % chance to win at showdown
- 0.50 = 50% (coin flip)
- 0.70 = 70% (strong)
- 0.30 = 30% (weak)

---

## Common Scenarios to Try

### 1. **Single Raised Pot - Flop**
```
OOP: 66+,A8s+,A5s-A4s,AJo+,K9s+,KQo,QTs+,JTs
IP: QQ-22,AQs-A2s,ATo+,K5s+,KJo+
Flop: Td9d6h
Pot: 200, Stack: 900
```

### 2. **3-Bet Pot - Turn**
```
OOP: QQ+,AKs,AKo
IP: 88+,AJs+,AQo+
Flop: Kh9d3c, Turn: 7s
Pot: 300, Stack: 1200
```

### 3. **4-Bet Pot - River**
```
OOP: KK+,AKs
IP: QQ+,AKs
Flop: Ah8d3c, Turn: 2s, River: 7h
Pot: 800, Stack: 600
```

---

## Files Created

- **Frontend UI:** `frontend/src/app/solver/page.tsx`
- **Backend Endpoint:** `backend/main.py` (`POST /solve`)
- **Python Bindings:** `rust/py-adapt/src/lib.rs`
- **Setup Guide:** `SOLVER_SETUP.md`
- **Summary:** `SUMMARY.md`

