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
export const SettingsIcon = (p: Props) => (
  <Svg {...p}><path d="M4 7h9" /><path d="M18 7h2" /><circle cx="15.5" cy="7" r="2.5" /><path d="M4 17h2" /><path d="M11 17h9" /><circle cx="8.5" cy="17" r="2.5" /></Svg>
);
export const ShieldIcon = (p: Props) => (
  <Svg {...p}><path d="M12 3 5 5.8v5.4c0 4.6 2.9 8 7 9.8 4.1-1.8 7-5.2 7-9.8V5.8z" /></Svg>
);
export const CloseIcon = (p: Props) => (
  <Svg {...p}><path d="m6 6 12 12" /><path d="M18 6 6 18" /></Svg>
);
/** Front ↔ back camera: a camera with turning arrows. */
export const SwitchCameraIcon = (p: Props) => (
  <Svg {...p}><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.6l1.3-2h7.2l1.3 2h2.6A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /><path d="M9 11.6a3.3 3.3 0 0 1 5.6-1" /><path d="M14.9 9v1.9H13" /><path d="M15 14.4a3.3 3.3 0 0 1-5.6 1" /><path d="M9.1 17v-1.9H11" /></Svg>
);
export const ExpandIcon = (p: Props) => (
  <Svg {...p}><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></Svg>
);
export const CollapseIcon = (p: Props) => (
  <Svg {...p}><path d="M9 4v5H4" /><path d="M15 4v5h5" /><path d="M9 20v-5H4" /><path d="M15 20v-5h5" /></Svg>
);
/** Gemini: the work is done online. */
export const CloudIcon = (p: Props) => (
  <Svg {...p}><path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 9.6 4.5 4.5 0 0 0 7 18.5z" /></Svg>
);
/** Nadhra: the work stays on this device. */
export const DeviceIcon = (p: Props) => (
  <Svg {...p}><rect x="6.5" y="3" width="11" height="18" rx="2.5" /><path d="M10.5 17.5h3" /><circle cx="12" cy="10" r="2.2" /></Svg>
);
export const ChevronIcon = (p: Props) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);
export const PhoneIcon = (p: Props) => (
  <Svg {...p}><path d="M5 3.5h3.2l1.6 4.2-2.2 1.4a11 11 0 0 0 5.3 5.3l1.4-2.2 4.2 1.6V17a2 2 0 0 1-2 2A14.5 14.5 0 0 1 3 5.5a2 2 0 0 1 2-2z" /></Svg>
);
export const MessageIcon = (p: Props) => (
  <Svg {...p}><path d="M4 5.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4.5 3.5v-3.5H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" /><path d="M7.5 10h9" /><path d="M7.5 13.5h6" /></Svg>
);
export const GlobeIcon = (p: Props) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></Svg>
);
// The main-screen actions (the same drawings as before the redesign).
export const DescribeIcon = (p: Props) => (
  <Svg {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></Svg>
);
export const ReadIcon = (p: Props) => (
  <Svg {...p}><path d="M4 5.5h16" /><path d="M4 10h16" /><path d="M4 14.5h10" /><path d="M4 19h7" /></Svg>
);
export const IdentifyIcon = (p: Props) => (
  <Svg {...p}><path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1a1 1 0 0 1 .7.3l7.4 7.4a1 1 0 0 1 0 1.4l-8.1 8.1a1 1 0 0 1-1.4 0l-7.4-7.4a1 1 0 0 1-.3-.7z" /><circle cx="8.5" cy="8.5" r="1.5" /></Svg>
);
export const AskIcon = (p: Props) => (
  <Svg {...p}><path d="M4 12a8 8 0 1 1 3.3 6.5L4 19.5l1-3.2A8 8 0 0 1 4 12z" /><path d="M9.8 9.8a2.3 2.3 0 1 1 3.4 2c-.8.5-1.2 1-1.2 1.8" /><path d="M12 16.2v.01" /></Svg>
);
export const PauseIcon = (p: Props) => (
  <Svg {...p}><path d="M9 5.5v13" /><path d="M15 5.5v13" /></Svg>
);
export const PlayIcon = (p: Props) => (
  <Svg {...p}><path d="M7 5.5v13L17 12z" /></Svg>
);
/** The brand mark: an eye whose iris is wired to two circuit nodes, on a white tile. Same drawing as src/app/icon.svg. */
export const LogoMark = () => (
  <svg width="40" height="40" viewBox="0 0 512 512" fill="none" className="logo shrink-0" aria-hidden="true">
    <rect width="512" height="512" rx="140" fill="#fff" />
    <g stroke="#0066d3" strokeWidth="26">
      <path d="M346.5 165.5A128 128 0 0 0 165.5 165.5L75 256L106.2 287.2M145.8 287.2L216.4 216.4A56 56 0 0 1 310.1 270.5M216.4 216.4A56 56 0 0 0 200 256A56 56 0 0 0 295.6 295.6L366.2 224.8M405.8 224.8L437 256L346.5 346.5A128 128 0 0 1 165.5 346.5" />
      <circle cx="126" cy="307" r="22.5" strokeWidth="21" />
      <circle cx="386" cy="205" r="22.5" strokeWidth="21" />
    </g>
    <path fill="#0066d3" fillRule="evenodd" d="M230 256a26 26 0 1 0 52 0a26 26 0 1 0-52 0zM260 248a9 9 0 1 0 18 0a9 9 0 1 0-18 0z" />
  </svg>
);
