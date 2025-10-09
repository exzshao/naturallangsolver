# Advanced Solver Parameters

## Complete Parameter List

Your Python bindings now support **ALL** parameters from the Rust solver!

### Basic Parameters (Required)
```python
solver = PostFlopSolver(
    oop_range="66+,A8s+",           # Required
    ip_range="QQ-22,AQs-A2s",       # Required
    flop="Td9d6h",                  # Required
    starting_pot=200,               # Required
    effective_stack=900,            # Required
    bet_sizes="60%, e, a",          # Required (default for all streets)
    raise_sizes="2.5x",             # Required (default for all streets)
)
```

### Optional Board Cards
```python
turn="Qc",                          # Optional: None = solve from flop
river="7s",                         # Optional: None = solve to showdown
```

### Rake Parameters (NEW!)
```python
rake_rate=0.05,                     # Optional: 0.0-1.0 (e.g., 0.05 = 5% rake)
rake_cap=30.0,                      # Optional: max rake in chips (e.g., 30.0)
```

**Example:**
```python
# Live poker with 5% rake, $30 cap
solver = PostFlopSolver(
    ...,
    rake_rate=0.05,
    rake_cap=30.0
)
```

### Per-Street, Per-Player Bet Sizes (NEW!)
```python
# Flop sizes (OOP vs IP)
flop_bet_sizes_oop=("50%, 75%", "2.5x"),   # Optional: OOP flop bet/raise sizes
flop_bet_sizes_ip=("60%, e, a", "2.5x"),   # Optional: IP flop bet/raise sizes

# Turn sizes
turn_bet_sizes_oop=("50%, e", "2.5x"),     # Optional: OOP turn sizes
turn_bet_sizes_ip=("60%, e, a", "3x"),     # Optional: IP turn sizes

# River sizes
river_bet_sizes_oop=("50%, 75%, a", "2x"), # Optional: OOP river sizes
river_bet_sizes_ip=("60%, e, a", "2.5x"),  # Optional: IP river sizes
```

**Example - Asymmetric sizing:**
```python
# OOP has defensive sizes, IP has aggressive sizes
solver = PostFlopSolver(
    ...,
    flop_bet_sizes_oop=("33%, 50%", "2x"),    # Small bets, small raises
    flop_bet_sizes_ip=("75%, e, a", "3x"),    # Large bets, large raises
)
```

### Donk Betting Options (NEW!)
```python
turn_donk_sizes="50%, 75%",        # Optional: OOP donk bet sizes on turn
river_donk_sizes="50%, a",         # Optional: OOP donk bet sizes on river
```

**What's a donk bet?** When OOP leads into the aggressor (unusual line).

**Example:**
```python
# Enable donk betting on river only
solver = PostFlopSolver(
    ...,
    river_donk_sizes="50%, 75%, a"   # OOP can donk bet on river
)
```

### Tree Construction Parameters (NEW!)

#### Add All-in Threshold
```python
add_allin_threshold=1.5            # Optional: Default 1.5
```

**What it does:** Adds all-in option if `(max_bet / pot) <= threshold`

**Examples:**
- `1.5` = Add all-in if max bet ≤ 1.5x pot (default)
- `1.0` = Add all-in if max bet ≤ 1x pot (pot-sized)
- `0.0` = Never auto-add all-in

#### Force All-in Threshold
```python
force_allin_threshold=0.15         # Optional: Default 0.15
```

**What it does:** Forces all-in if `(stack_after_call / pot) <= threshold`

This prevents tiny SPR situations where optimal play is always all-in.

**Examples:**
- `0.15` = Force all-in if SPR ≤ 0.15 (default, recommended)
- `0.20` = More aggressive (larger SPR triggers all-in)
- `0.10` = More conservative
- `0.0` = Never force all-in

#### Merging Threshold
```python
merging_threshold=0.1              # Optional: Default 0.1
```

**What it does:** Merges similar bet sizes to reduce tree complexity.

Uses PioSOLVER algorithm: removes bet Y if `(100+X)/(100+Y) < 1.0 + threshold`

**Examples:**
- `0.1` = Moderate merging (default, recommended)
- `0.05` = Aggressive merging (fewer bet sizes)
- `0.0` = No merging (keeps all bets)

### Solve Parameters (NEW!)
```python
solver.solve(
    max_iterations=1000,
    target_exploitability=1.0,
    enable_compression=False       # NEW: Optional memory compression
)
```

**Compression:**
- `False` = Use 32-bit floats (faster, more memory)
- `True` = Use 16-bit ints (slower, 50% less memory)

---

## Complete Examples

### Example 1: Simple (Backward Compatible)
```python
# Old way still works!
solver = PostFlopSolver(
    oop_range="66+,A8s+",
    ip_range="QQ-22,AQs-A2s",
    flop="Td9d6h",
    starting_pot=200,
    effective_stack=900,
    bet_sizes="60%, e, a",
    raise_sizes="2.5x"
)
```

### Example 2: With Rake (Live Poker)
```python
solver = PostFlopSolver(
    oop_range="66+,A8s+,AJo+",
    ip_range="QQ-22,AQs-A2s,ATo+",
    flop="Kh9d3c",
    starting_pot=300,
    effective_stack=1200,
    bet_sizes="50%, 75%, a",
    raise_sizes="2.5x",
    rake_rate=0.05,              # 5% rake
    rake_cap=30.0                # $30 cap
)
```

### Example 3: Asymmetric Sizing
```python
# OOP: Defensive, small sizes
# IP: Aggressive, large sizes
solver = PostFlopSolver(
    oop_range="QQ+,AKs",
    ip_range="88+,AJs+",
    flop="Ah8d3c",
    starting_pot=400,
    effective_stack=1000,
    bet_sizes="50%, e, a",       # Default (not used if overridden)
    raise_sizes="2.5x",          # Default
    flop_bet_sizes_oop=("33%, 50%", "2x"),   # OOP: small bets
    flop_bet_sizes_ip=("75%, e, a", "3x"),   # IP: large bets
    turn_bet_sizes_oop=("33%", "2x"),
    turn_bet_sizes_ip=("75%, a", "3x"),
)
```

### Example 4: Enable Donk Betting
```python
solver = PostFlopSolver(
    oop_range="66+,A2s+",
    ip_range="22+,A2s+",
    flop="Td9d6h",
    starting_pot=200,
    effective_stack=900,
    bet_sizes="60%, e, a",
    raise_sizes="2.5x",
    river_donk_sizes="50%, 75%, a"  # OOP can donk on river
)
```

### Example 5: Fine-tuned Tree Construction
```python
solver = PostFlopSolver(
    oop_range="QQ+,AKs",
    ip_range="88+,AJs+",
    flop="Kh9d3c",
    starting_pot=300,
    effective_stack=1200,
    bet_sizes="50%, 75%, e, a",
    raise_sizes="2.5x",
    add_allin_threshold=1.2,     # Add allin more conservatively
    force_allin_threshold=0.20,  # Force allin with larger SPR
    merging_threshold=0.05       # Aggressive bet merging
)
```

### Example 6: Memory Compression
```python
solver = PostFlopSolver(
    oop_range="22+,A2s+,A2o+",   # Very wide range (lots of combos)
    ip_range="22+,A2s+,A2o+",
    flop="Td9d6h",
    starting_pot=200,
    effective_stack=900,
    bet_sizes="50%, 75%, e, a",
    raise_sizes="2.5x"
)

# Use compression to save memory (slower but uses 50% less RAM)
exploitability = solver.solve(
    max_iterations=1000,
    target_exploitability=1.0,
    enable_compression=True      # Compress to save memory
)
```

---

## Parameter Reference Table

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `oop_range` | str | **Required** | OOP starting range |
| `ip_range` | str | **Required** | IP starting range |
| `flop` | str | **Required** | Flop cards (e.g., "Td9d6h") |
| `starting_pot` | int | **Required** | Pot size at start |
| `effective_stack` | int | **Required** | Stack remaining |
| `bet_sizes` | str | **Required** | Default bet options |
| `raise_sizes` | str | **Required** | Default raise options |
| `turn` | str? | None | Turn card or None |
| `river` | str? | None | River card or None |
| `rake_rate` | float? | 0.0 | Rake % (0.0-1.0) |
| `rake_cap` | float? | 0.0 | Max rake in chips |
| `flop_bet_sizes_oop` | (str,str)? | Uses `bet_sizes` | OOP flop (bet, raise) |
| `flop_bet_sizes_ip` | (str,str)? | Uses `bet_sizes` | IP flop (bet, raise) |
| `turn_bet_sizes_oop` | (str,str)? | Uses `bet_sizes` | OOP turn (bet, raise) |
| `turn_bet_sizes_ip` | (str,str)? | Uses `bet_sizes` | IP turn (bet, raise) |
| `river_bet_sizes_oop` | (str,str)? | Uses `bet_sizes` | OOP river (bet, raise) |
| `river_bet_sizes_ip` | (str,str)? | Uses `bet_sizes` | IP river (bet, raise) |
| `turn_donk_sizes` | str? | None | OOP turn donk options |
| `river_donk_sizes` | str? | None | OOP river donk options |
| `add_allin_threshold` | float? | 1.5 | Auto-add allin threshold |
| `force_allin_threshold` | float? | 0.15 | Force allin SPR threshold |
| `merging_threshold` | float? | 0.1 | Bet size merging |

### Solve Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_iterations` | int | **Required** | Max CFR iterations |
| `target_exploitability` | float | **Required** | Stop if below this |
| `enable_compression` | bool? | False | Use 16-bit compression |

---

## Now You Have Complete Control!

All parameters from the Rust solver are now exposed in your Python bindings. This gives you the same power as using the Rust API directly!

### Rebuild to Use New Parameters:

```bash
cd rust/py-adapt
maturin develop --release
```

Then you can use all the new parameters immediately!

