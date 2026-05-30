import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { TrendingUp, TrendingDown, Activity, Zap, BarChart3, ArrowUpDown } from 'lucide-react';

// ─── Dynamic App ID (reads from localStorage → env → fallback) ───────────────
import { getAppId } from '@/services/deriv-api';

function getWsUrl(): string {
  return `wss://ws.derivws.com/websockets/v3?app_id=${getAppId()}`;
}

interface VolatilityCardProps {
  symbol: string;
  tickCount: number;
  mode: 'over' | 'under';
  onStrongSignal?: (hasSignal: boolean) => void;
  onConnectionStatus?: (isConnected: boolean) => void;
}

interface Pattern {
  digits: number[];
  length: number;
  frequency: number;
}

/**
 * Extracts the last digit from a Deriv price quote.
 * Deriv prices have 2 decimal places for most indices,
 * so we parse to string and take the very last character.
 * Handles edge cases: NaN, out-of-range, non-numeric inputs.
 */
function extractLastDigit(price: number | string): number {
  try {
    const num = typeof price === 'string' ? parseFloat(price) : price;
    if (!isFinite(num)) return -1;
    // Use toFixed(2) to normalise, then grab final char
    const str = num.toFixed(2);
    const d = parseInt(str[str.length - 1], 10);
    return Number.isNaN(d) ? -1 : d;
  } catch {
    return -1;
  }
}

export default function VolatilityCard({
  symbol,
  tickCount,
  mode,
  onStrongSignal,
  onConnectionStatus,
}: VolatilityCardProps) {
  const [digits, setDigits] = useState<number[]>([]);
  const [activeDigit, setActiveDigit] = useState(5);
  const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'offline'>('connecting');

  const wsRef = useRef<WebSocket | null>(null);
  const digitsRef = useRef<number[]>([]);
  const mountedRef = useRef(true);
  const lastSignalRef = useRef<string>('');
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const retryCountRef = useRef(0);
  const MAX_RETRIES = 8;
  const MAX_DIGITS = 4000;

  // ── WebSocket connection ───────────────────────────────────────────────────
  const connectWebSocket = useCallback(() => {
    if (!mountedRef.current) return;

    // Clean up any existing socket first
    if (wsRef.current) {
      wsRef.current.onclose = null; // prevent re-trigger
      wsRef.current.close();
      wsRef.current = null;
    }

    setStatus('connecting');
    onConnectionStatus?.(false);

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      retryCountRef.current = 0;
      setStatus('live');
      onConnectionStatus?.(true);

      // Request history + subscribe to live ticks in one call
      ws.send(JSON.stringify({
        ticks_history: symbol,
        style: 'ticks',
        count: tickCount,
        end: 'latest',
        subscribe: 1,
      }));
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      let data: any;
      try { data = JSON.parse(event.data); } catch { return; }

      // API-level error
      if (data.error) {
        console.error('[VolatilityCard] API error:', data.error.message);
        setStatus('error');
        onConnectionStatus?.(false);
        return;
      }

      // Historical batch — populate initial digits
      if (data.history?.prices) {
        const extracted: number[] = [];
        for (const p of data.history.prices) {
          const d = extractLastDigit(p);
          if (d >= 0) extracted.push(d);
        }
        digitsRef.current = extracted;
        setDigits([...extracted]);
      }

      // Live tick — append to buffer
      if (data.tick?.quote !== undefined) {
        const d = extractLastDigit(data.tick.quote);
        if (d >= 0) {
          digitsRef.current.push(d);
          if (digitsRef.current.length > MAX_DIGITS) {
            digitsRef.current.splice(0, digitsRef.current.length - MAX_DIGITS);
          }
          setDigits([...digitsRef.current]);
        }
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setStatus('error');
      onConnectionStatus?.(false);
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus('offline');
      onConnectionStatus?.(false);

      if (retryCountRef.current < MAX_RETRIES) {
        const delay = Math.min(1000 * 2 ** retryCountRef.current, 15000);
        retryCountRef.current++;
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connectWebSocket();
        }, delay);
      }
    };
  }, [symbol, tickCount, onConnectionStatus]);

  // ── Mount / unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    digitsRef.current = [];
    setDigits([]);
    retryCountRef.current = 0;
    connectWebSocket();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectWebSocket]);

  // ── Re-request history when tickCount changes while already connected ──────
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        ticks_history: symbol,
        style: 'ticks',
        count: tickCount,
        end: 'latest',
        subscribe: 1,
      }));
    }
  }, [symbol, tickCount]);

  // ── Analysis (memoised) ────────────────────────────────────────────────────
  const analysis = useMemo(() => {
    const recentTicks = digits.slice(-tickCount);
    const lastDigits = recentTicks.slice(-30);
    const threshold = activeDigit;
    const total = recentTicks.length || 1;

    const counts = new Array(10).fill(0);
    for (const d of recentTicks) {
      if (d >= 0 && d <= 9) counts[d]++;
    }

    const digitPercentages = counts.map(c => ((c / total) * 100).toFixed(1));

    let most = 0, second = 1, least = 0;
    let mostCount = counts[0], secondCount = counts[1], leastCount = counts[0];

    for (let i = 1; i < 10; i++) {
      if (counts[i] > mostCount) {
        second = most; secondCount = mostCount;
        most = i; mostCount = counts[i];
      } else if (counts[i] > secondCount) {
        second = i; secondCount = counts[i];
      }
      if (counts[i] < leastCount) {
        least = i; leastCount = counts[i];
      }
    }

    let lowCount = 0, highCount = 0;
    for (let i = 0; i < threshold; i++) lowCount += counts[i];
    for (let i = threshold + 1; i <= 9; i++) highCount += counts[i];
    const lowPercent = ((lowCount / total) * 100).toFixed(1);
    const highPercent = ((highCount / total) * 100).toFixed(1);

    let evenCount = 0, oddCount = 0;
    for (let i = 0; i <= 9; i += 2) evenCount += counts[i];
    for (let i = 1; i <= 9; i += 2) oddCount += counts[i];
    const evenPercent = ((evenCount / total) * 100).toFixed(1);
    const oddPercent = ((oddCount / total) * 100).toFixed(1);

    let signalType: 'neutral' | 'over' | 'under' = 'neutral';
    let signalStrength = 0;
    let signalText = 'WAIT';

    if (recentTicks.length >= 50) {
      if (most < threshold && second < threshold) {
        signalType = 'under';
        signalStrength = Math.min(100, Math.round(((counts[most] + counts[second]) / total) * 100));
        signalText = `🔥 UNDER ${threshold} (${signalStrength}%)`;
      } else if (most > threshold && second > threshold) {
        signalType = 'over';
        signalStrength = Math.min(100, Math.round(((counts[most] + counts[second]) / total) * 100));
        signalText = `🔥 OVER ${threshold} (${signalStrength}%)`;
      }
    }

    const winningDigits: number[] = [];
    const losingDigits: number[] = [];
    const entryProbability: { digit: number; winRate: number }[] = [];

    for (let digit = 0; digit <= 9; digit++) {
      let wins = 0, losses = 0;
      for (let i = 0; i < recentTicks.length - 1; i++) {
        if (recentTicks[i] === digit) {
          const next = recentTicks[i + 1];
          if (mode === 'over') {
            if (next > threshold) wins++;
            else if (next < threshold) losses++;
          } else {
            if (next < threshold) wins++;
            else if (next > threshold) losses++;
          }
        }
      }
      if (wins + losses > 0) {
        const winRate = (wins / (wins + losses)) * 100;
        entryProbability.push({ digit, winRate });
        if (winRate > 60) winningDigits.push(digit);
        else if (winRate < 40) losingDigits.push(digit);
      }
    }

    entryProbability.sort((a, b) => b.winRate - a.winRate);
    const bestEntryDigits = entryProbability.slice(0, 2);

    const patterns: Pattern[] = [];
    let currentPattern: number[] = [];
    for (let i = 0; i < recentTicks.length; i++) {
      if (currentPattern.length === 0 || recentTicks[i] === currentPattern[currentPattern.length - 1]) {
        currentPattern.push(recentTicks[i]);
      } else {
        if (currentPattern.length >= 3) {
          patterns.push({ digits: [...currentPattern], length: currentPattern.length, frequency: 1 });
        }
        currentPattern = [recentTicks[i]];
      }
    }

    const patternMap = new Map<string, Pattern>();
    patterns.forEach(p => {
      const key = p.digits.join(',');
      if (patternMap.has(key)) patternMap.get(key)!.frequency++;
      else patternMap.set(key, { ...p });
    });

    const longestPatterns = Array.from(patternMap.values())
      .sort((a, b) => b.length - a.length)
      .slice(0, 2);

    return {
      lastDigits, counts, digitPercentages, total,
      most, second, least, mostCount, secondCount, leastCount,
      lowPercent, highPercent,
      signalType, signalStrength, signalText,
      winningDigits: [...new Set(winningDigits)].slice(0, 3),
      losingDigits: [...new Set(losingDigits)].slice(0, 3),
      evenPercent, oddPercent, bestEntryDigits, longestPatterns,
      hasEnoughData: recentTicks.length >= 50,
    };
  }, [digits, tickCount, activeDigit, mode]);

  // ── Notify parent of strong signal ────────────────────────────────────────
  useEffect(() => {
    const hasStrongSignal = analysis.signalType !== 'neutral' && analysis.hasEnoughData;
    const signalKey = `${analysis.signalType}-${analysis.signalStrength}`;
    if (lastSignalRef.current !== signalKey) {
      lastSignalRef.current = signalKey;
      const t = setTimeout(() => onStrongSignal?.(hasStrongSignal), 100);
      return () => clearTimeout(t);
    }
  }, [analysis.signalType, analysis.signalStrength, analysis.hasEnoughData, onStrongSignal]);

  const statusColor = status === 'live' ? 'text-green-500' : status === 'error' ? 'text-red-500' : 'text-yellow-500';
  const statusBg   = status === 'live' ? 'bg-green-500/10' : status === 'error' ? 'bg-red-500/10'  : 'bg-yellow-500/10';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -1 }}
      transition={{ duration: 0.15 }}
      className="bg-gradient-to-br from-card to-card/95 backdrop-blur-sm border border-border/50 rounded-lg p-2 sm:p-2.5 shadow-md hover:shadow-lg transition-all duration-150 h-full"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2 sm:mb-2.5">
        <div className="flex items-center gap-1 sm:gap-1.5">
          <Activity className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-primary" />
          <h3 className="font-bold text-[11px] sm:text-xs bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
            {symbol}
          </h3>
        </div>
        <div className={`px-1 sm:px-1.5 py-0.5 rounded-full text-[7px] sm:text-[8px] font-mono ${statusBg} ${statusColor}`}>
          {status === 'live'       && '● LIVE'}
          {status === 'connecting' && '● CONN'}
          {status === 'error'      && '● ERR'}
          {status === 'offline'    && '● OFF'}
        </div>
      </div>

      {/* Signal Box */}
      <AnimatePresence>
        {analysis.signalType !== 'neutral' && analysis.hasEnoughData && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className={`mb-2 sm:mb-2.5 rounded-md p-1 sm:p-1.5 text-center ${
              analysis.signalType === 'over'
                ? 'bg-gradient-to-r from-green-500/20 to-emerald-500/20 border border-green-500/30'
                : 'bg-gradient-to-r from-red-500/20 to-rose-500/20 border border-red-500/30'
            }`}
          >
            <div className="flex items-center justify-center gap-0.5 sm:gap-1">
              {analysis.signalType === 'over'
                ? <TrendingUp  className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-green-500" />
                : <TrendingDown className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-red-500" />}
              <span className={`text-[8px] sm:text-[9px] font-bold ${
                analysis.signalType === 'over' ? 'text-green-500' : 'text-red-500'
              }`}>
                {analysis.signalText}
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-0.5 sm:h-1 mt-0.5 sm:mt-1">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${analysis.signalStrength}%` }}
                className={`h-0.5 sm:h-1 rounded-full ${
                  analysis.signalType === 'over' ? 'bg-green-500' : 'bg-red-500'
                }`}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Last 30 digits */}
      <div className="mb-2 sm:mb-2.5">
        <div className="flex items-center gap-1 mb-1 sm:mb-1.5">
          <BarChart3 className="w-2 h-2 sm:w-2.5 sm:h-2.5 text-muted-foreground" />
          <span className="text-[7px] sm:text-[8px] text-muted-foreground">Last 30</span>
        </div>
        <div className="grid grid-cols-10 gap-0.5 sm:gap-1">
          {analysis.lastDigits.map((d, i) => {
            let bgColor = 'bg-muted', textColor = 'text-foreground';
            if (d === activeDigit) { bgColor = 'bg-primary'; textColor = 'text-primary-foreground'; }
            else if (d > activeDigit) { bgColor = 'bg-green-500/20'; textColor = 'text-green-500'; }
            else { bgColor = 'bg-red-500/20'; textColor = 'text-red-500'; }
            return (
              <div
                key={`${i}-${d}`}
                className={`w-full aspect-square flex items-center justify-center rounded-full text-[8px] sm:text-[9px] font-mono font-bold ${bgColor} ${textColor}`}
              >
                {d}
              </div>
            );
          })}
        </div>
      </div>

      {/* Digit buttons */}
      <div className="mb-2 sm:mb-2.5">
        <div className="grid grid-cols-5 gap-0.5 sm:gap-1">
          {Array.from({ length: 10 }, (_, i) => {
            const pct = analysis.digitPercentages[i];
            let btnClass = 'bg-muted/50 hover:bg-muted text-foreground';
            if (i === analysis.most)   btnClass = 'bg-gradient-to-r from-green-500 to-emerald-500 text-white';
            else if (i === analysis.second) btnClass = 'bg-gradient-to-r from-blue-500 to-cyan-500 text-white';
            else if (i === analysis.least)  btnClass = 'bg-gradient-to-r from-red-500 to-rose-500 text-white';
            return (
              <motion.button
                key={i}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setActiveDigit(i)}
                className={`rounded py-0.5 sm:py-1 text-[8px] sm:text-[9px] font-mono font-bold transition-all ${btnClass} ${
                  i === activeDigit ? 'ring-1 ring-primary ring-offset-0' : ''
                }`}
              >
                {i}
                <span className="block text-[6px] sm:text-[7px] opacity-80">{pct}%</span>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Compact Stats */}
      <div className="grid grid-cols-2 gap-1 sm:gap-1.5 mb-2 sm:mb-2.5">
        <div className="bg-muted/30 rounded p-1 sm:p-1.5">
          <div className="flex justify-between text-[7px] sm:text-[8px] font-mono">
            <span className="text-red-500">&lt;{activeDigit}</span>
            <span className="text-green-500">&gt;{activeDigit}</span>
          </div>
          <div className="flex gap-0.5 sm:gap-1 mt-0.5">
            <div className="flex-1 h-1 sm:h-1.5 bg-red-500/20 rounded-full overflow-hidden">
              <motion.div initial={{ width: 0 }} animate={{ width: `${analysis.lowPercent}%` }} className="h-full bg-red-500 rounded-full" />
            </div>
            <div className="flex-1 h-1 sm:h-1.5 bg-green-500/20 rounded-full overflow-hidden">
              <motion.div initial={{ width: 0 }} animate={{ width: `${analysis.highPercent}%` }} className="h-full bg-green-500 rounded-full" />
            </div>
          </div>
          <div className="flex justify-between text-[6px] sm:text-[7px] mt-0.5">
            <span className="text-red-500">{analysis.lowPercent}%</span>
            <span className="text-green-500">{analysis.highPercent}%</span>
          </div>
        </div>

        <div className="bg-muted/30 rounded p-1 sm:p-1.5">
          <div className="flex items-center justify-between gap-0.5">
            <ArrowUpDown className="w-2 h-2 sm:w-2.5 sm:h-2.5 text-muted-foreground" />
            <span className="text-[6px] sm:text-[7px] font-medium">E/O</span>
          </div>
          <div className="flex gap-0.5 sm:gap-1 mt-0.5">
            <div className="flex-1 h-1 sm:h-1.5 bg-purple-500/20 rounded-full overflow-hidden">
              <motion.div initial={{ width: 0 }} animate={{ width: `${analysis.evenPercent}%` }} className="h-full bg-purple-500 rounded-full" />
            </div>
            <div className="flex-1 h-1 sm:h-1.5 bg-orange-500/20 rounded-full overflow-hidden">
              <motion.div initial={{ width: 0 }} animate={{ width: `${analysis.oddPercent}%` }} className="h-full bg-orange-500 rounded-full" />
            </div>
          </div>
          <div className="flex justify-between text-[6px] sm:text-[7px] mt-0.5">
            <span className="text-purple-500">{analysis.evenPercent}%</span>
            <span className="text-orange-500">{analysis.oddPercent}%</span>
          </div>
        </div>
      </div>

      {/* Digit Frequency */}
      <div className="mb-2 sm:mb-2.5 bg-gradient-to-r from-primary/5 to-primary/10 rounded p-1.5 sm:p-2">
        <div className="flex items-center gap-1 sm:gap-1.5 mb-1.5 sm:mb-2">
          <Zap className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-primary" />
          <span className="text-[7px] sm:text-[8px] font-bold text-primary uppercase tracking-wide">Digit Frequency</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
          <div className="text-center bg-green-500/10 rounded-lg p-1 sm:p-1.5">
            <div className="text-[6px] sm:text-[7px] text-green-500/80 font-medium mb-0.5">MOST</div>
            <div className="text-[16px] sm:text-[20px] font-mono font-bold text-green-500 leading-none">{analysis.most}</div>
            <div className="text-[7px] sm:text-[8px] text-green-400 font-mono mt-0.5">{analysis.digitPercentages[analysis.most]}%</div>
            <div className="text-[5px] sm:text-[6px] text-green-500/60 mt-0.5">{analysis.mostCount} ticks</div>
          </div>
          <div className="text-center bg-blue-500/10 rounded-lg p-1 sm:p-1.5">
            <div className="text-[6px] sm:text-[7px] text-blue-500/80 font-medium mb-0.5">2ND MOST</div>
            <div className="text-[16px] sm:text-[20px] font-mono font-bold text-blue-500 leading-none">{analysis.second}</div>
            <div className="text-[7px] sm:text-[8px] text-blue-400 font-mono mt-0.5">{analysis.digitPercentages[analysis.second]}%</div>
            <div className="text-[5px] sm:text-[6px] text-blue-500/60 mt-0.5">{analysis.secondCount} ticks</div>
          </div>
          <div className="text-center bg-red-500/10 rounded-lg p-1 sm:p-1.5">
            <div className="text-[6px] sm:text-[7px] text-red-500/80 font-medium mb-0.5">LEAST</div>
            <div className="text-[16px] sm:text-[20px] font-mono font-bold text-red-500 leading-none">{analysis.least}</div>
            <div className="text-[7px] sm:text-[8px] text-red-400 font-mono mt-0.5">{analysis.digitPercentages[analysis.least]}%</div>
            <div className="text-[5px] sm:text-[6px] text-red-500/60 mt-0.5">{analysis.leastCount} ticks</div>
          </div>
        </div>
      </div>

      {/* Patterns */}
      {analysis.longestPatterns.length > 0 && analysis.longestPatterns[0]?.digits.length >= 3 && (
        <div className="bg-muted/30 rounded p-1 sm:p-1.5 mb-1 sm:mb-1.5">
          <div className="flex items-center gap-0.5 sm:gap-1">
            <TrendingUp className="w-2 h-2 sm:w-2.5 sm:h-2.5 text-muted-foreground" />
            <span className="text-[6px] sm:text-[7px] font-medium">Patterns</span>
          </div>
          <div className="text-[6px] sm:text-[7px] font-mono">
            {analysis.longestPatterns[0]?.digits.slice(0, 3).join('→')}
          </div>
        </div>
      )}

      {/* Win/Loss Triggers */}
      {(analysis.winningDigits.length > 0 || analysis.losingDigits.length > 0) && (
        <div className="bg-muted/30 rounded p-1 sm:p-1.5">
          <div className="flex justify-between">
            <div>
              <div className="flex items-center gap-0.5 sm:gap-1">
                <div className="w-1 h-1 sm:w-1.5 sm:h-1.5 rounded-full bg-green-500" />
                <span className="text-[5px] sm:text-[6px]">W</span>
              </div>
              <div className="flex gap-0.5 mt-0.5">
                {analysis.winningDigits.map(d => (
                  <span key={d} className="px-0.5 sm:px-1 bg-green-500/20 text-green-500 rounded text-[5px] sm:text-[6px] font-mono">{d}</span>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-0.5 sm:gap-1">
                <div className="w-1 h-1 sm:w-1.5 sm:h-1.5 rounded-full bg-red-500" />
                <span className="text-[5px] sm:text-[6px]">L</span>
              </div>
              <div className="flex gap-0.5 mt-0.5">
                {analysis.losingDigits.map(d => (
                  <span key={d} className="px-0.5 sm:px-1 bg-red-500/20 text-red-500 rounded text-[5px] sm:text-[6px] font-mono">{d}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
