from postflop_solver_python import PostFlopSolver

def test_minimal_interface():
    """Test the new simplified 5-parameter interface"""
    print("\n" + "="*50)
    print("Testing Minimal Interface (5 params)")
    print("="*50)
    
    try:
        # Test absolute minimum
        solver = PostFlopSolver(
            oop_range="QQ+,AKs",
            ip_range="88+,AJs+",
            flop="Ah8d3c",
            starting_pot=100,
            effective_stack=500
        )
        print("✅ Created solver with only 5 required params")
        
        # Quick solve
        exploitability = solver.solve(50, 1.0)
        print(f"✅ Solved! Exploitability: {exploitability:.2f}")
        
        # Test results
        frequencies = solver.get_action_frequencies()
        print(f"✅ Got {len(frequencies)} actions")
        for action, freq in frequencies:
            print(f"   {action}: {freq*100:.1f}%")
        
        print("\n🎉 Minimal interface test passed!\n")
        return True
        
    except Exception as e:
        print(f"❌ Minimal interface test failed: {e}\n")
        return False

def test_solver():
    try:
        # Initialize solver with the same parameters from your example
        starting_pot = 200
        solver = PostFlopSolver(
            oop_range="66+,A8s+,A5s-A4s,AJo+,K9s+,KQo,QTs+,JTs,96s+,85s+,75s+,65s,54s",
            ip_range="QQ-22,AQs-A2s,ATo+,K5s+,KJo+,Q8s+,J8s+,T7s+,96s+,86s+,75s+,64s+,53s+",
            flop="Td9d6h",
            starting_pot=starting_pot,
            effective_stack=900,
            turn="Qc",
            bet_sizes="20%, 50%, a",
            raise_sizes="3x" 
        )
        print("✅ Solver initialized successfully")

        # Test solving
        print("Solving... (this might take a few seconds)")
        exploitability = solver.solve(max_iterations=1000, target_exploitability=0.5)
        exploitability_percentage = (exploitability / starting_pot) * 100

        print(f"Exploitability: {exploitability}")
        print(f"Exploitability: {exploitability_percentage:.3f}% of pot")

        # frequencies = solver.get_action_frequencies()
        # print("\nAction frequencies:")
        # for action, freq in frequencies:
        #     print(f"{action}: {freq*100:.1f}%")

        # print("\nFrequencies for first hand:")
        # hand_freqs = solver.get_hand_frequencies(0)
        # for action, freq in hand_freqs:
        #     print(f"{action}: {freq * 100:.1f}%")

        actions = solver.get_available_actions()
        strategy = solver.get_strategy()
        hands = solver.get_private_cards(player=0)
        num_hands = len(hands)

        # Overall frequencies (what get_action_frequencies() does)
        solver.cache_normalized_weights()  # Need to cache weights first
        weights = solver.get_normalized_weights(0)
        frequencies = [0.0] * len(actions)

        for hand_idx in range(num_hands):
            for action_idx in range(len(actions)):
                strategy_idx = action_idx * num_hands + hand_idx
                frequencies[action_idx] += strategy[strategy_idx] * weights[hand_idx]

        # Normalize
        total = sum(frequencies)
        if total > 0:
            frequencies = [f/total for f in frequencies]

        print("\nOverall frequencies:")
        for action, freq in zip(actions, frequencies):
            print(f"{action}: {freq*100:.1f}%")

        # Hand frequencies (what get_hand_frequencies() does)
        hand_idx = 0  # for a specific hand
        print(f"\nFrequencies for hand {hands[hand_idx]}:")
        for action_idx, action in enumerate(actions):
            strategy_idx = action_idx * num_hands + hand_idx
            print(f"{action}: {strategy[strategy_idx]*100:.1f}%")

        # print(oop_cards)

        # Test playing actions
        solver.play(0)  # Play first available action
        new_actions = solver.get_available_actions()
        print(f"New available actions after playing: {new_actions}")

        # Test going back to root
        solver.back_to_root()
        root_actions = solver.get_available_actions()
        print(f"Actions at root: {root_actions}")

        print("\n🎉 All tests passed!")

    except Exception as e:
        print(f"❌ Error: {str(e)}")

if __name__ == "__main__":
    print("\n" + "="*60)
    print("PostFlopSolver Test Suite")
    print("="*60)
    
    # Run all tests
    test1_passed = test_minimal_interface()
    test2_passed = False
    
    try:
        test_solver()
        test2_passed = True
    except Exception as e:
        print(f"❌ Full solver test failed: {e}")
    
    # Summary
    print("\n" + "="*60)
    print("Test Summary")
    print("="*60)
    print(f"Minimal Interface Test: {'✅ PASSED' if test1_passed else '❌ FAILED'}")
    print(f"Full Solver Test: {'✅ PASSED' if test2_passed else '❌ FAILED'}")
    print("="*60 + "\n")