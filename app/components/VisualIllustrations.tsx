import type { CSSProperties } from 'react';

const svgBase: CSSProperties = {
  display: 'block',
  overflow: 'visible',
  flexShrink: 0,
};

/**
 * Login left-panel sculptural optical orbital constellation:
 * Pure geometric light rings, orbital nodes, and luminous AI core prism — zero text clutter.
 */
export function LoginShowcaseIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 340 168"
      fill="none"
      aria-hidden="true"
      className={className}
      style={{ ...svgBase, width: '100%', height: 'auto' }}
    >
      <defs>
        <radialGradient id="lg-aura" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#818cf8" stopOpacity="0.45" />
          <stop offset="55%" stopColor="#38bdf8" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="lg-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="lg-orbit" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#818cf8" stopOpacity="0.1" />
          <stop offset="50%" stopColor="#c7d2fe" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.15" />
        </linearGradient>
      </defs>

      <ellipse cx="170" cy="84" rx="136" ry="72" fill="url(#lg-aura)" />

      {/* Concentric optical orbital rings */}
      <ellipse cx="170" cy="84" rx="126" ry="54" stroke="url(#lg-orbit)" strokeWidth="1.2" />
      <ellipse cx="170" cy="84" rx="88" ry="38" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="1" strokeDasharray="3 4" />
      <circle cx="170" cy="84" r="46" stroke="#a5b4fc" strokeOpacity="0.26" strokeWidth="1" />

      {/* Luminous orbital signal satellites (pure geometric nodes, zero text) */}
      <circle cx="52" cy="66" r="6" fill="#38bdf8" fillOpacity="0.24" stroke="#7dd3fc" strokeWidth="1.2" />
      <circle cx="52" cy="66" r="2.4" fill="#e0f2fe" />

      <circle cx="286" cy="64" r="7" fill="#34d399" fillOpacity="0.22" stroke="#6ee7b7" strokeWidth="1.2" />
      <circle cx="286" cy="64" r="2.6" fill="#d1fae5" />

      <circle cx="106" cy="116" r="5" fill="#a78bfa" fillOpacity="0.28" stroke="#ddd6fe" strokeWidth="1.1" />
      <circle cx="242" cy="114" r="5" fill="#818cf8" fillOpacity="0.28" stroke="#c7d2fe" strokeWidth="1.1" />

      {/* Central Frosted Optical Prism Lens */}
      <g transform="translate(138, 52)">
        <rect x="-6" y="-6" width="76" height="76" rx="24" fill="#6366f1" fillOpacity="0.16" stroke="#a5b4fc" strokeOpacity="0.28" />
        <rect width="64" height="64" rx="20" fill="url(#lg-glass)" stroke="#ffffff" strokeOpacity="0.42" strokeWidth="1.25" />
        <path
          d="M32 15 L36.6 27.4 L49 32 L36.6 36.6 L32 49 L27.4 36.6 L15 32 L27.4 27.4 Z"
          fill="#e0e7ff"
          stroke="#ffffff"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <circle cx="32" cy="32" r="3.2" fill="#6366f1" />
      </g>
    </svg>
  );
}

/**
 * AI Prospecting Optical Radar Emblem (80x80, zero text, clean luminous radar lens).
 */
export function ProspectingIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 84 84" width="80" height="80" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="pr-aura" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="pr-sweep" x1="42" y1="10" x2="72" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="42" cy="42" r="40" fill="url(#pr-aura)" />
      <circle cx="42" cy="42" r="32" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e8f0)" strokeWidth="1.2" />
      <path d="M42 42 L42 10 A32 32 0 0 1 71 29 Z" fill="url(#pr-sweep)" />
      <circle cx="42" cy="42" r="21" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.24" strokeWidth="1.1" strokeDasharray="2.5 3" />
      <circle cx="56" cy="25" r="4.5" fill="var(--app-accent, #4f46e5)" fillOpacity="0.18" />
      <circle cx="56" cy="25" r="2.2" fill="var(--app-accent, #4f46e5)" />
      <circle cx="26" cy="52" r="2.2" fill="var(--success, #0d9488)" />
      <rect x="30" y="30" width="24" height="24" rx="8" fill="var(--app-accent, #4f46e5)" />
      <path d="M42 35.5 L44 40 L48.5 42 L44 44 L42 48.5 L40 44 L35.5 42 L40 40 Z" fill="#ffffff" />
    </svg>
  );
}

/**
 * GEO Visibility Optical Orbit Emblem (80x80, zero text, multi-node citation constellation).
 */
export function GeoIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 84 84" width="80" height="80" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="geo-aura" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="42" cy="42" r="40" fill="url(#geo-aura)" />
      <circle cx="42" cy="42" r="32" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e8f0)" strokeWidth="1.2" />
      <ellipse cx="42" cy="42" rx="25" ry="12" transform="rotate(-24 42 42)" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.34" strokeWidth="1.2" />
      <ellipse cx="42" cy="42" rx="25" ry="12" transform="rotate(36 42 42)" stroke="var(--app-accent-secondary, #0d9488)" strokeOpacity="0.3" strokeWidth="1.2" />
      <circle cx="20" cy="33" r="3" fill="var(--app-accent, #4f46e5)" />
      <circle cx="63" cy="31" r="2.8" fill="#0ea5e9" />
      <circle cx="58" cy="56" r="2.8" fill="var(--success, #10b981)" />
      <circle cx="42" cy="42" r="10" fill="var(--app-accent, #4f46e5)" />
      <path d="M38.5 42.2 L41 44.6 L46 39.5" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Knowledge Library Optical Prism Sheets Emblem (76x76, zero text).
 */
export function KnowledgeDocsIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 80" width="76" height="76" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="kb-aura" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="40" cy="40" r="38" fill="url(#kb-aura)" />
      <rect x="17" y="18" width="34" height="42" rx="9" transform="rotate(-6 17 18)" fill="var(--cds-surface-0, #f7f8fb)" stroke="var(--cds-border-strong, #cbd5e1)" strokeWidth="1.2" />
      <rect x="26" y="16" width="36" height="44" rx="10" fill="var(--cds-surface-2, #ffffff)" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.42" strokeWidth="1.3" />
      <rect x="33" y="26" width="18" height="3.5" rx="1.75" fill="var(--app-accent, #4f46e5)" fillOpacity="0.75" />
      <rect x="33" y="34" width="22" height="3" rx="1.5" fill="var(--cds-text-muted, #94a3b8)" fillOpacity="0.45" />
      <rect x="33" y="41" width="15" height="3" rx="1.5" fill="var(--cds-text-muted, #94a3b8)" fillOpacity="0.35" />
      <circle cx="55" cy="52" r="9" fill="var(--app-accent, #4f46e5)" />
      <circle cx="54" cy="51" r="3.4" stroke="#ffffff" strokeWidth="1.5" />
      <path d="M56.6 53.6 L59 56" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Creative Studio Optical Frame Emblem (76x76, zero text).
 */
export function CreativeCanvasIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 80" width="76" height="76" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="cf-aura" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="40" cy="40" r="38" fill="url(#cf-aura)" />
      <rect x="14" y="18" width="52" height="44" rx="12" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e8f0)" strokeWidth="1.3" />
      <circle cx="28" cy="31" r="4.5" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 22%, transparent)" />
      <path d="M18 54 L31 41 L41 49 L50 38 L62 54 Z" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 14%, transparent)" />
      <circle cx="56" cy="22" r="9" fill="var(--app-accent, #4f46e5)" />
      <path d="M56 17 L57.4 20.6 L61 22 L57.4 23.4 L56 27 L54.6 23.4 L51 22 L54.6 20.6 Z" fill="#ffffff" />
    </svg>
  );
}

/**
 * Contract Shield Optical Emblem (76x76, zero text).
 */
export function ContractShieldIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 80" width="76" height="76" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="cs-aura" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="40" cy="40" r="38" fill="url(#cs-aura)" />
      <circle cx="40" cy="40" r="30" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e8f0)" strokeWidth="1.2" />
      <path
        d="M40 19 L56 25.5 V39.5 C56 49.8 49.2 57.4 40 61 C30.8 57.4 24 49.8 24 39.5 V25.5 Z"
        fill="color-mix(in srgb, var(--app-accent, #4f46e5) 12%, var(--cds-surface-2, #ffffff))"
        stroke="var(--app-accent, #4f46e5)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M34.5 40.2 L38.4 44 L46.2 35.8" stroke="var(--app-accent, #4f46e5)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Acoustic Voiceprint Optical Emblem (76x76, zero text).
 */
export function AudioWaveIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 80 80" width="76" height="76" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="aw-aura" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.2" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="40" cy="40" r="38" fill="url(#aw-aura)" />
      <circle cx="40" cy="40" r="30" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e8f0)" strokeWidth="1.2" />
      {[
        { x: 23, h: 12, op: 0.4 },
        { x: 30, h: 22, op: 0.65 },
        { x: 37, h: 30, op: 1 },
        { x: 44, h: 20, op: 0.85 },
        { x: 51, h: 26, op: 0.7 },
        { x: 58, h: 14, op: 0.45 },
      ].map((bar, idx) => (
        <rect
          key={idx}
          x={bar.x - 2}
          y={40 - bar.h / 2}
          width="4"
          height={bar.h}
          rx="2"
          fill="var(--app-accent, #4f46e5)"
          fillOpacity={bar.op}
        />
      ))}
    </svg>
  );
}
