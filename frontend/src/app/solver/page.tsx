"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SolveResult {
  exploitability: number;
  actions: string[];
  frequencies: [string, number][];
  hands: string[];
  equity: number[];
}

export default function SolverPage() {
  // Input state
  const [oopRange, setOopRange] = useState("66+,A8s+,A5s-A4s,AJo+,K9s+,KQo,QTs+,JTs");
  const [ipRange, setIpRange] = useState("QQ-22,AQs-A2s,ATo+,K5s+,KJo+");
  const [flop, setFlop] = useState("Td9d6h");
  const [turn, setTurn] = useState("Qc");
  const [river, setRiver] = useState("");
  const [startingPot, setStartingPot] = useState(200);
  const [effectiveStack, setEffectiveStack] = useState(900);
  const [betSizes, setBetSizes] = useState("60%, e, a");
  const [raiseSizes, setRaiseSizes] = useState("2.5x");

  // Results state
  const [result, setResult] = useState<SolveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSolve = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("http://localhost:8000/solve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oop_range: oopRange,
          ip_range: ipRange,
          flop: flop,
          turn: turn || null,
          river: river || null,
          starting_pot: startingPot,
          effective_stack: effectiveStack,
          bet_sizes: betSizes,
          raise_sizes: raiseSizes,
          max_iterations: 1000,
          target_exploitability: 1.0,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || "Failed to solve");
      }

      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-4 max-w-6xl">
      <h1 className="text-3xl font-bold mb-6">Poker Solver</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Left Column - Ranges & Board */}
        <Card>
          <CardHeader>
            <CardTitle>Scenario Setup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">OOP Range</label>
              <Input
                value={oopRange}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOopRange(e.target.value)}
                placeholder="66+,A8s+,AJo+"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">IP Range</label>
              <Input
                value={ipRange}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIpRange(e.target.value)}
                placeholder="QQ-22,AQs-A2s,ATo+"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-sm font-medium mb-1">Flop</label>
                <Input
                  value={flop}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFlop(e.target.value)}
                  placeholder="Td9d6h"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Turn</label>
                <Input
                  value={turn}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTurn(e.target.value)}
                  placeholder="Qc"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">River</label>
                <Input
                  value={river}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRiver(e.target.value)}
                  placeholder="7s"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Right Column - Pot & Stack */}
        <Card>
          <CardHeader>
            <CardTitle>Game Parameters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Starting Pot</label>
                <Input
                  type="number"
                  value={startingPot}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStartingPot(parseInt(e.target.value))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Effective Stack</label>
                <Input
                  type="number"
                  value={effectiveStack}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEffectiveStack(parseInt(e.target.value))}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Bet Sizes
                <span className="text-xs text-gray-500 ml-2">(e.g., 60%, e, a)</span>
              </label>
              <Input
                value={betSizes}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBetSizes(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Raise Sizes
                <span className="text-xs text-gray-500 ml-2">(e.g., 2.5x)</span>
              </label>
              <Input
                value={raiseSizes}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRaiseSizes(e.target.value)}
              />
            </div>

            <Button
              onClick={handleSolve}
              disabled={loading}
              className="w-full"
              size="lg"
            >
              {loading ? "Solving..." : "Solve"}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Error Display */}
      {error && (
        <Card className="mb-6 border-red-500">
          <CardContent className="pt-6">
            <p className="text-red-600 font-medium">Error: {error}</p>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-6">
          {/* Summary */}
          <Card>
            <CardHeader>
              <CardTitle>Solution Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-sm text-gray-500">Exploitability</p>
                  <p className="text-2xl font-bold">{result.exploitability.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Actions Available</p>
                  <p className="text-2xl font-bold">{result.actions.length}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">OOP Hands</p>
                  <p className="text-2xl font-bold">{result.hands.length}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Board</p>
                  <p className="text-2xl font-bold">
                    {flop}
                    {turn && ` ${turn}`}
                    {river && ` ${river}`}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Action Frequencies */}
          <Card>
            <CardHeader>
              <CardTitle>Strategy (Action Frequencies)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {result.frequencies.map(([action, frequency]) => (
                  <div key={action} className="space-y-1">
                    <div className="flex justify-between items-center">
                      <span className="font-medium">{action}</span>
                      <span className="text-sm text-gray-600">
                        {(frequency * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2.5">
                      <div
                        className="bg-blue-600 h-2.5 rounded-full transition-all"
                        style={{ width: `${frequency * 100}%` }}
                      ></div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Top Equity Hands */}
          <Card>
            <CardHeader>
              <CardTitle>Top 10 Hands by Equity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {result.hands
                  .map((hand, idx) => ({ hand, equity: result.equity[idx] }))
                  .sort((a, b) => b.equity - a.equity)
                  .slice(0, 10)
                  .map(({ hand, equity }) => (
                    <div
                      key={hand}
                      className="bg-gray-50 p-3 rounded border text-center"
                    >
                      <p className="font-bold text-lg">{hand}</p>
                      <p className="text-sm text-gray-600">
                        {(equity * 100).toFixed(1)}%
                      </p>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

