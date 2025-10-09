import { useState } from 'react';

type Msg = { role: 'user' | 'assistant'; content: string };

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  async function send() {
    if (!input.trim()) return;
    const next = [...messages, { role: 'user', content: input } as Msg];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('http://localhost:8000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
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


