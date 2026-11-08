// One consistent, hand-picked line icon set (no icon dependency). Always decorative: the visible
// text next to each icon gives the name.
type Props = { size?: number; className?: string };

function Svg({ size = 26, className, children }: Props & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  );
}

export const CameraIcon = (p: Props) => (
  <Svg {...p}><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.6l1.3-2h7.2l1.3 2h2.6A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /><circle cx="12" cy="13" r="3.5" /></Svg>
);
export const CameraOffIcon = (p: Props) => (
  <Svg {...p}><path d="m3 3 18 18" /><path d="M9.2 5h5.6l1.3 2h3.4A1.5 1.5 0 0 1 21 8.5v8.3" /><path d="M18 19H4.5A1.5 1.5 0 0 1 3 17.5v-9A1.5 1.5 0 0 1 4.5 7H6" /><path d="M9.6 10.6a3.5 3.5 0 0 0 4.9 4.9" /></Svg>
);
export const MicIcon = (p: Props) => (
  <Svg {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v3" /></Svg>
);
export const MicOffIcon = (p: Props) => (
  <Svg {...p}><path d="m3 3 18 18" /><path d="M15 10V6a3 3 0 0 0-5.6-1.5" /><path d="M9 9v2a3 3 0 0 0 4.6 2.5" /><path d="M5.5 11.5a6.5 6.5 0 0 0 10.2 5.3" /><path d="M18.5 11.5a6.4 6.4 0 0 1-.5 2.5" /><path d="M12 18v3" /></Svg>
);
export const AskIcon = (p: Props) => (
  <Svg {...p}><path d="M4 12a8 8 0 1 1 3.3 6.5L4 19.5l1-3.2A8 8 0 0 1 4 12z" /><path d="M9.8 9.8a2.3 2.3 0 1 1 3.4 2c-.8.5-1.2 1-1.2 1.8" /><path d="M12 16.2v.01" /></Svg>
);
export const SilenceIcon = (p: Props) => (
  <Svg {...p}><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" /><path d="m16 10 4.5 4.5" /><path d="m20.5 10-4.5 4.5" /></Svg>
);
export const PauseIcon = (p: Props) => (
  <Svg {...p}><path d="M9 5.5v13" /><path d="M15 5.5v13" /></Svg>
);
export const PlayIcon = (p: Props) => (
  <Svg {...p}><path d="M17 5.5v13L7 12z" /></Svg>
);
export const RepeatIcon = (p: Props) => (
  <Svg {...p}><path d="M20 12a8 8 0 1 1-2.5-5.8L20 8.5" /><path d="M20 4v4.5h-4.5" /></Svg>
);
export const SettingsIcon = (p: Props) => (
  <Svg {...p}><path d="M4 7h9" /><path d="M18 7h2" /><circle cx="15.5" cy="7" r="2.5" /><path d="M4 17h2" /><path d="M11 17h9" /><circle cx="8.5" cy="17" r="2.5" /></Svg>
);
export const ShieldIcon = (p: Props) => (
  <Svg {...p}><path d="M12 3 5 5.8v5.4c0 4.6 2.9 8 7 9.8 4.1-1.8 7-5.2 7-9.8V5.8z" /></Svg>
);
export const CloseIcon = (p: Props) => (
  <Svg {...p}><path d="m6 6 12 12" /><path d="M18 6 6 18" /></Svg>
);
export const ForwardIcon = (p: Props) => (
  <Svg {...p}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></Svg>
);
export const ChevronIcon = (p: Props) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);
/** The brand mark: the iris reduced to its essentials. */
export const LogoMark = () => (
  <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="shrink-0 text-glow" aria-hidden="true">
    <circle cx="20" cy="20" r="18.5" stroke="var(--edge)" />
    <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M20 8v4M20 28v4M8 20h4M28 20h4M11.5 11.5l2.8 2.8M25.7 25.7l2.8 2.8M28.5 11.5l-2.8 2.8M14.3 25.7l-2.8 2.8" />
    </g>
    <circle cx="20" cy="20" r="4.5" fill="currentColor" />
  </svg>
);
