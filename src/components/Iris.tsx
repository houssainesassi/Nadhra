// The app's emblem and its state indicator: a living iris. Decorative for assistive technology
// (aria-hidden), since the state is also given as text and spoken. All motion is CSS (globals.css)
// and stops under prefers-reduced-motion.
export type IrisState = "idle" | "watching" | "thinking" | "listening" | "speaking" | "urgent";

const TICKS = Array.from({ length: 60 }, (_, i) => i * 6);
const BARS = Array.from({ length: 36 }, (_, i) => i * 10);
// Fixed, irregular delays: the bars ripple without looking mechanical, and server and browser agree.
const DELAYS = [0, 340, 120, 520, 260, 700, 60, 440, 180, 620, 300, 780];

export function Iris({ state, className = "" }: { state: IrisState; className?: string }) {
  return (
    <div className={`iris ${className}`} data-state={state} data-testid="iris" aria-hidden="true">
      <div className="iris-aura" />
      <svg viewBox="0 0 200 200">
        <g className="iris-ticks" stroke="currentColor" strokeWidth="1">
          {TICKS.map((angle) => (
            <line key={angle} x1="100" y1="6" x2="100" y2={angle % 30 === 0 ? 16 : 11} transform={`rotate(${angle} 100 100)`} />
          ))}
        </g>
        <circle className="iris-arc" cx="100" cy="100" r="84" pathLength={100} />
        <circle className="iris-ping" cx="100" cy="100" r="74" />
        {BARS.map((angle, i) => (
          <g key={angle} transform={`rotate(${angle} 100 100)`}>
            <rect className="iris-bar" x="98.75" y="30" width="2.5" height="36" rx="1.25" style={{ "--delay": `${DELAYS[i % DELAYS.length]}ms` } as React.CSSProperties} />
          </g>
        ))}
        <circle className="iris-pupil" cx="100" cy="100" r="24" />
      </svg>
    </div>
  );
}
