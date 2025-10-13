import React from 'react';

type RangeGridProps = {
  title?: string;
  value: Set<string>;
  onChange: (next: Set<string>) => void;
};

const RANKS: string[] = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];

function handCode(rowIndex: number, colIndex: number): string {
  if (rowIndex === colIndex) {
    return `${RANKS[rowIndex]}${RANKS[colIndex]}`;
  }
  const high = Math.min(rowIndex, colIndex);
  const low = Math.max(rowIndex, colIndex);
  const isSuited = rowIndex < colIndex; // upper triangle suited, lower triangle offsuit
  return `${RANKS[high]}${RANKS[low]}${isSuited ? 's' : 'o'}`;
}

export default function RangeGrid({ title, value, onChange }: RangeGridProps) {
  function toggle(code: string) {
    const next = new Set(value);
    if (next.has(code)) {
      next.delete(code);
    } else {
      next.add(code);
    }
    onChange(next);
  }

  return (
    <div>
      {title && <div style={{ margin: '8px 0', fontWeight: 600 }}>{title}</div>}
      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          {RANKS.map((r, i) => (
            <tr key={r}>
              {RANKS.map((c, j) => {
                const code = handCode(i, j);
                const selected = value.has(code);
                return (
                  <td key={code} style={{ padding: 0 }}>
                    <button
                      type="button"
                      onClick={() => toggle(code)}
                      title={code}
                      style={{
                        width: 36,
                        height: 28,
                        border: '1px solid #ddd',
                        background: selected ? '#d1e7dd' : '#fff',
                        cursor: 'pointer',
                        fontFamily: 'system-ui, sans-serif',
                        fontSize: 12,
                      }}
                    >
                      {code}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


