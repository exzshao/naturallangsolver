# Simple Usage Guide

## Minimal Example (Just 5 Required Parameters!)

```python
from postflop_solver_python import PostFlopSolver

# Absolutely minimal - only 5 required parameters!
solver = PostFlopSolver(
    oop_range="66+,A8s+,AJo+",
    ip_range="QQ-22,AQs-A2s,ATo+",
    flop="Td9d6h",
    starting_pot=200,
    effective_stack=900
)

# Solve
exploitability = solver.solve(max_iterations=1000, target_exploitability=1.0)

# Get results
frequencies = solver.get_action_frequencies()
for action, freq in frequencies:
    print(f"{action}: {freq*100:.1f}%")
```

That's it! Everything else has sensible defaults.

---

## What Changed: Simplicity First!

### ✅ Only 5 Required Parameters:
1. `oop_range` - OOP starting range
2. `ip_range` - IP starting range  
3. `flop` - Flop cards
4. `starting_pot` - Pot size
5. `effective_stack` - Stack remaining

### ✅ Everything Else Is Optional with Defaults:

| Parameter | Default | What It Means |
|-----------|---------|---------------|
| `bet_sizes` | `"60%, e, a"` | 60% pot, geometric, all-in |
| `raise_sizes` | `"2.5x"` | 2.5x the previous bet |
| `turn` | `None` | Solve from flop |
| `river` | `None` | Solve to showdown |
| `rake_rate` | `0.0` | **No rake** (simple!) |
| `rake_cap` | `0.0` | No rake cap |
| `add_allin_threshold` | `1.5` | Standard threshold |
| `force_allin_threshold` | `0.15` | Standard (recommended) |
| `merging_threshold` | `0.1` | Standard merging |
| All per-street sizes | Uses `bet_sizes` | Symmetric for all streets |
| Donk betting | `None` | **Disabled** (simple!) |
| `enable_compression` | `False` | Fast (no compression) |

---

## Common Simple Use Cases

### 1. Flop Spot (Most Common)
```python
solver = PostFlopSolver(
    oop_range="66+,A8s+,AJo+",
    ip_range="QQ-22,AQs-A2s",
    flop="Kh9d3c",
    starting_pot=200,
    effective_stack=900
)
```

### 2. Turn Spot
```python
solver = PostFlopSolver(
    oop_range="66+,A8s+",
    ip_range="QQ-22,AQs-A2s",
    flop="Kh9d3c",
    turn="7s",           # Just add turn!
    starting_pot=200,
    effective_stack=900
)
```

### 3. River Spot
```python
solver = PostFlopSolver(
    oop_range="66+,A8s+",
    ip_range="QQ-22,AQs-A2s",
    flop="Kh9d3c",
    turn="7s",
    river="2d",          # Just add river!
    starting_pot=200,
    effective_stack=900
)
```

### 4. Different Bet Sizes (Optional)
```python
solver = PostFlopSolver(
    oop_range="66+,A8s+",
    ip_range="QQ-22,AQs-A2s",
    flop="Kh9d3c",
    starting_pot=200,
    effective_stack=900,
    bet_sizes="50%, 75%, a",  # Custom sizes (optional!)
    raise_sizes="3x"           # Custom raises (optional!)
)
```

---

## When to Use Advanced Features

You don't need advanced features unless:

### Use Rake Parameters When:
- ✅ Simulating live poker (5% rake)
- ✅ Online cash games with rake
- ❌ **NOT needed for:** Tournament spots, practice, most study

### Use Per-Street Sizing When:
- ✅ Modeling asymmetric play (OOP defensive, IP aggressive)
- ✅ Advanced strategy exploration
- ❌ **NOT needed for:** Basic GTO study, most scenarios

### Use Donk Betting When:
- ✅ Studying specific donk bet spots
- ✅ Advanced postflop theory
- ❌ **NOT needed for:** >95% of scenarios (rare line)

### Use Compression When:
- ✅ Very wide ranges causing memory issues
- ✅ Limited RAM available
- ❌ **NOT needed for:** Normal ranges, modern computers

---

## Progressive Complexity

### Level 1: Absolute Beginner
```python
solver = PostFlopSolver(
    oop_range="QQ+,AKs",
    ip_range="88+,AJs+",
    flop="Ah8d3c",
    starting_pot=100,
    effective_stack=500
)
```
**Uses:** All defaults, no rake, standard sizes

### Level 2: Intermediate
```python
solver = PostFlopSolver(
    oop_range="QQ+,AKs",
    ip_range="88+,AJs+",
    flop="Ah8d3c",
    starting_pot=100,
    effective_stack=500,
    bet_sizes="50%, 75%, a",    # Custom sizes
    turn="2s"                    # Specific turn
)
```
**Uses:** Custom bet sizes, specific board

### Level 3: Advanced
```python
solver = PostFlopSolver(
    oop_range="QQ+,AKs",
    ip_range="88+,AJs+",
    flop="Ah8d3c",
    starting_pot=100,
    effective_stack=500,
    rake_rate=0.05,                              # 5% rake
    rake_cap=30.0,                               # $30 cap
    flop_bet_sizes_oop=("33%, 50%", "2x"),      # OOP small
    flop_bet_sizes_ip=("75%, e, a", "3x"),      # IP large
)
```
**Uses:** Rake, asymmetric sizing

---

## Key Principle: Start Simple, Add Complexity Only When Needed

The default settings give you:
- ✅ Standard GTO play
- ✅ No rake (pure game theory)
- ✅ Reasonable bet sizes (60%, geometric, all-in)
- ✅ Symmetric play (same sizes for both players)
- ✅ Fast solving (no compression)

This is **perfect for 90% of use cases!**

Only add parameters when you specifically need:
- Rake (live poker simulation)
- Different sizes per street
- Asymmetric play
- Donk betting lines
- Memory optimization

---

## Rebuild to Use Simplified Interface:

```bash
cd rust/py-adapt
maturin develop --release
```

Now you have the **best of both worlds:**
- ✅ Simple by default (5 required params)
- ✅ Powerful when needed (all features available)
- ✅ No breaking changes (backward compatible)

