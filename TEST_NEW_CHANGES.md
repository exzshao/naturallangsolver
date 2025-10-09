# How to Test New Changes

## Step 1: Rebuild Python Bindings

```bash
cd rust/py-adapt
maturin develop --release
```

This compiles your Rust code and installs it into your Python environment.

**Expected output:**
```
🔗 Found pyo3 bindings
🐍 Found CPython 3.x at ...
   Compiling postflop_solver_python v0.1.0 (/path/to/rust/py-adapt)
    Finished release [optimized] target(s) in 45.23s
📦 Built wheel for CPython 3.x ...
🛠 Installed postflop_solver_python-0.1.0
```

---

## Step 2: Quick Python Test

Create a test file or run directly:

```bash
# Test from command line
python3 << 'EOF'
from postflop_solver_python import PostFlopSolver

print("Testing minimal interface...")

# Test 1: Absolute minimum (5 params)
solver = PostFlopSolver(
    "QQ+,AKs",           # oop_range
    "88+,AJs+",          # ip_range
    "Ah8d3c",            # flop
    100,                 # starting_pot
    500                  # effective_stack
)

print("✓ Solver created with minimal params!")

# Test 2: Solve
print("\nSolving...")
exploitability = solver.solve(100, 1.0)  # Quick test with 100 iterations
print(f"✓ Solved! Exploitability: {exploitability:.2f}")

# Test 3: Get results
frequencies = solver.get_action_frequencies()
print(f"\n✓ Action frequencies:")
for action, freq in frequencies:
    print(f"  {action}: {freq*100:.1f}%")

print("\n✅ All tests passed!")
EOF
```

---

## Step 3: Test Advanced Parameters

```bash
python3 << 'EOF'
from postflop_solver_python import PostFlopSolver

print("Testing advanced parameters...")

# Test with rake
solver = PostFlopSolver(
    "QQ+,AKs", "88+,AJs+", "Ah8d3c", 100, 500,
    rake_rate=0.05,
    rake_cap=30.0
)
print("✓ Rake parameters work!")

# Test with custom bet sizes
solver2 = PostFlopSolver(
    "QQ+,AKs", "88+,AJs+", "Ah8d3c", 100, 500,
    bet_sizes="50%, 75%, a",
    raise_sizes="3x"
)
print("✓ Custom bet sizes work!")

print("\n✅ Advanced tests passed!")
EOF
```

---

## Step 4: Test Backend API

### Start the backend:
```bash
cd backend
uvicorn main:app --reload
```

### Test with curl (in another terminal):
```bash
curl -X POST http://localhost:8000/solve \
  -H "Content-Type: application/json" \
  -d '{
    "oop_range": "QQ+,AKs",
    "ip_range": "88+,AJs+",
    "flop": "Ah8d3c",
    "starting_pot": 100,
    "effective_stack": 500
  }'
```

**Expected response:**
```json
{
  "exploitability": 1.23,
  "actions": ["Check", "Bet(50)", "AllIn(500)"],
  "frequencies": [
    ["Check", 0.35],
    ["Bet(50)", 0.45],
    ["AllIn(500)", 0.20]
  ],
  "hands": ["AcKc", "AcQc", ...],
  "equity": [0.78, 0.65, ...]
}
```

---

## Step 5: Test Frontend UI

### Start both servers:
```bash
# Terminal 1 - Backend
cd backend
uvicorn main:app --reload

# Terminal 2 - Frontend
cd frontend
npm run dev
```

### Visit in browser:
```
http://localhost:3000/solver
```

### Test checklist:
- [ ] Fill in OOP range: `QQ+,AKs`
- [ ] Fill in IP range: `88+,AJs+`
- [ ] Fill in flop: `Ah8d3c`
- [ ] Fill in starting pot: `100`
- [ ] Fill in effective stack: `500`
- [ ] Leave bet sizes as default
- [ ] Click "Solve"
- [ ] See results appear (action frequencies, top hands)

---

## Quick Validation Script

Run your existing test suite:

```bash
python3 tests/test_py_solver.py
```

This will test:
- ✅ Minimal 5-parameter interface
- ✅ Full solver with all features
- ✅ Action frequencies
- ✅ Tree navigation

**Expected output:**
```
============================================================
PostFlopSolver Test Suite
============================================================

==================================================
Testing Minimal Interface (5 params)
==================================================
✅ Created solver with only 5 required params
✅ Solved! Exploitability: 1.23
✅ Got 3 actions
   Check: 35.2%
   Bet(50): 44.8%
   AllIn(500): 20.0%

🎉 Minimal interface test passed!

✅ Solver initialized successfully
Solving... (this might take a few seconds)
...
🎉 All tests passed!

============================================================
Test Summary
============================================================
Minimal Interface Test: ✅ PASSED
Full Solver Test: ✅ PASSED
============================================================
```

---

## Common Issues & Fixes

### Issue 1: "No module named 'postflop_solver_python'"
**Fix:**
```bash
cd rust/py-adapt
maturin develop --release
```

### Issue 2: "TypeError: ... takes X positional arguments but Y were given"
**Fix:** You have the old version installed. Rebuild:
```bash
cd rust/py-adapt
maturin develop --release --force
```

### Issue 3: Solver crashes or hangs
**Fix:** Check your ranges are valid:
```python
# Bad: Invalid range syntax
solver = PostFlopSolver("QQ++", "88+", ...)  # Extra +

# Good: Valid range syntax
solver = PostFlopSolver("QQ+", "88+", ...)
```

### Issue 4: Backend returns 400 error
**Check:** Your request JSON matches the schema:
```json
{
  "oop_range": "QQ+",     // Required
  "ip_range": "88+",      // Required
  "flop": "Ah8d3c",       // Required
  "starting_pot": 100,    // Required
  "effective_stack": 500  // Required
}
```

---

## Performance Benchmarks

After rebuilding, you can benchmark:

```python
import time
from postflop_solver_python import PostFlopSolver

# Small tree (fast)
start = time.time()
solver = PostFlopSolver("QQ+", "88+", "Ah8d3c", 100, 500, turn="2s", river="7d")
solver.solve(1000, 1.0)
print(f"River spot: {time.time() - start:.2f}s")

# Medium tree
start = time.time()
solver = PostFlopSolver("QQ+,AKs", "88+,AJs+", "Ah8d3c", 100, 500, turn="2s")
solver.solve(1000, 1.0)
print(f"Turn spot: {time.time() - start:.2f}s")

# Large tree (slow)
start = time.time()
solver = PostFlopSolver("66+,A8s+,AJo+", "22+,A2s+,ATo+", "Td9d6h", 200, 900)
solver.solve(1000, 1.0)
print(f"Flop spot: {time.time() - start:.2f}s")
```

**Expected times:**
- River: 2-5 seconds
- Turn: 5-15 seconds
- Flop: 15-60 seconds

---

## Checklist: Did Everything Work?

- [ ] `maturin develop --release` completed without errors
- [ ] Minimal 5-param example runs
- [ ] Default bet sizes work
- [ ] Custom bet sizes work
- [ ] Rake parameters work
- [ ] Turn/river cards work
- [ ] Result extraction works (frequencies, hands, equity)
- [ ] Backend API responds
- [ ] Frontend UI loads and submits

**If all checked:** ✅ Your changes are working!

