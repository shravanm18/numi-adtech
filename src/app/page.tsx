'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { evaluateLines } from '@/lib/evaluator';

const STORAGE_KEY = 'numi_adtech_scratchpad_v1';
const COMPACT_KEY = 'numi_adtech_compact_v1';

const DEFAULT_SCRATCHPAD = `// Q4 Ad-Tech Media Plan
q4_budget = 1.2m
q4_budget - 15%

2.5m impressions at $15 cpm
$50k budget at $20 cpm
$15k for 1.2m impressions
cpm of $15k and 1.2m

450k
320k
180k
sum
avg
prev * 1.1

$1.5m in eur
today + 2 weeks`;

export default function HomePage() {
  const [text, setText] = useState<string>('');
  const [compact, setCompact] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const savedText = localStorage.getItem(STORAGE_KEY);
      const savedCompact = localStorage.getItem(COMPACT_KEY);
      setText(savedText !== null ? savedText : DEFAULT_SCRATCHPAD);
      if (savedCompact !== null) {
        setCompact(savedCompact === 'true');
      }
    } catch {
      setText(DEFAULT_SCRATCHPAD);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, text);
    } catch {
      // Ignore storage quota errors
    }
  }, [text, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(COMPACT_KEY, String(compact));
    } catch {
      // Ignore storage quota errors
    }
  }, [compact, hydrated]);

  const results = useMemo(() => evaluateLines(text, compact), [text, compact]);

  const handleScroll = () => {
    if (textareaRef.current && resultsRef.current) {
      resultsRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const handleCopy = async (value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setToast(`Copied ${value}`);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToast(null), 1800);
    } catch {
      setToast(`Value: ${value}`);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToast(null), 1800);
    }
  };

  return (
    <div className="app-shell">
      <div className="numi-window">
        <header className="titlebar">
          <div className="traffic-lights" aria-hidden="true">
            <span className="dot dot-red" />
            <span className="dot dot-yellow" />
            <span className="dot dot-green" />
          </div>
          <span className="titlebar-title">Numi</span>
          <div className="titlebar-spacer" />
        </header>

        <main className="editor-container">
          <textarea
            ref={textareaRef}
            className="input-pane"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onScroll={handleScroll}
            placeholder="2.5m impressions at $15 cpm..."
            spellCheck={false}
            autoFocus
          />
          <div ref={resultsRef} className="results-pane" aria-live="polite">
            {results.map((res) => (
              <div key={res.lineIndex} className="result-line">
                {res.formatted ? (
                  <span
                    className="result-value"
                    onClick={() => handleCopy(res.copyValue)}
                    title="Click to copy"
                  >
                    {res.formatted}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </main>

        <footer className="footer-bar">
          <button
            type="button"
            className={`footer-btn ${compact ? 'active' : ''}`}
            onClick={() => setCompact((c) => !c)}
            title="Toggle between full numbers and compact notation ($2.5M)"
          >
            {compact ? '● Compact ($2.5M)' : '○ Full (2,500,000)'}
          </button>
          <div className="footer-actions">
            <button
              type="button"
              className="footer-btn"
              onClick={() => setText(DEFAULT_SCRATCHPAD)}
            >
              Example
            </button>
            <button
              type="button"
              className="footer-btn"
              onClick={() => setText('')}
            >
              Clear
            </button>
          </div>
        </footer>
      </div>

      <div className={`toast ${toast ? 'visible' : ''}`}>{toast || ''}</div>
    </div>
  );
}
