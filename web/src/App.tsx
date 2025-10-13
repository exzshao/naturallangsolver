import { useMemo, useState } from 'react';
import RangeGrid from './RangeGrid';

type Msg = { role: 'user' | 'assistant'; content: string };

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [oopRange, setOopRange] = useState<Set<string>>(new Set());
  const [ipRange, setIpRange] = useState<Set<string>>(new Set());

  const oopRangeStr = useMemo(() => serializeRange(oopRange), [oopRange]);
  const ipRangeStr = useMemo(() => serializeRange(ipRange), [ipRange]);

  function serializeRange(range: Set<string>): string {
    // Simple CSV list like "AKs, AKo, 99" which is compatible with solver service examples
    return Array.from(range.values()).sort().join(',');
  }

  async function send() {
    if (!input.trim() && !oopRangeStr && !ipRangeStr) return;
    const prefix = (oopRangeStr || ipRangeStr) ? `OOP=${oopRangeStr}; IP=${ipRangeStr}` : '';
    const backendContent = prefix ? (input.trim() ? `${prefix}\n${input}` : prefix) : input;
    const uiContent = input; // show only what the user typed, not the prepended ranges
    const uiNext = [...messages, { role: 'user', content: uiContent } as Msg];
    const wireNext = [...messages, { role: 'user', content: backendContent } as Msg];
    setMessages(uiNext);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('http://localhost:8000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: wireNext }),
      });
      const data = await res.json();
      setMessages((m) => [...m, data.message]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 680, margin: '40px auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Poker Assistant</h1>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <RangeGrid title="OOP Range" value={oopRange} onChange={setOopRange} />
        <RangeGrid title="IP Range" value={ipRange} onChange={setIpRange} />
      </div>
      {/* Ranges are auto-prepended in send(); no insert button needed */}
      <div style={{ border: '1px solid #ddd', padding: 16, borderRadius: 8, minHeight: 240 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ margin: '8px 0' }}>
            <strong>{m.role}:</strong> {m.content}
          </div>
        ))}
        {loading && <div>Thinking…</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask for a postflop solve…"
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={send}>Send</button>
      </div>
    </div>
  );
}


