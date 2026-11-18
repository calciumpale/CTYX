import type { CSSProperties } from 'react';

const svgBase: CSSProperties = {
  display: 'block',
  overflow: 'visible',
  flexShrink: 0,
};

/**
 * Login left-panel architectural vector graphic:
 * Precision orbital telemetry diagram on deep indigo (#0c1024) with zero raster blur.
 */
export function LoginShowcaseIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 380 132"
      fill="none"
      aria-hidden="true"
      className={className}
      style={{ ...svgBase, width: '100%', height: 'auto' }}
    >
      <defs>
        <linearGradient id="lg-card" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.13" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="lg-beam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#818cf8" stopOpacity="0.15" />
          <stop offset="50%" stopColor="#a5b4fc" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#34d399" stopOpacity="0.85" />
        </linearGradient>
        <radialGradient id="lg-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Ambient core glow */}
      <ellipse cx="190" cy="66" rx="128" ry="58" fill="url(#lg-glow)" />

      {/* Subtle architectural grid */}
      <g stroke="#ffffff" strokeOpacity="0.06" strokeWidth="1">
        <line x1="16" y1="26" x2="364" y2="26" />
        <line x1="16" y1="66" x2="364" y2="66" />
        <line x1="16" y1="106" x2="364" y2="106" />
        <line x1="95" y1="10" x2="95" y2="122" />
        <line x1="190" y1="10" x2="190" y2="122" />
        <line x1="285" y1="10" x2="285" y2="122" />
      </g>

      {/* Bezier telemetry streams */}
      <path d="M108 38 C 138 38, 142 66, 162 66" stroke="url(#lg-beam)" strokeWidth="1.5" strokeDasharray="3 3" />
      <path d="M108 94 C 138 94, 142 66, 162 66" stroke="url(#lg-beam)" strokeWidth="1.5" />
      <path d="M218 66 C 242 66, 246 42, 272 42" stroke="url(#lg-beam)" strokeWidth="1.5" />
      <path d="M218 66 C 242 66, 246 92, 272 92" stroke="url(#lg-beam)" strokeWidth="1.5" strokeDasharray="3 3" />

      {/* Left satellite card 1: Lead signal */}
      <g transform="translate(14, 18)">
        <rect width="94" height="40" rx="10" fill="url(#lg-card)" stroke="#ffffff" strokeOpacity="0.18" />
        <circle cx="18" cy="20" r="6" fill="#818cf8" fillOpacity="0.28" stroke="#a5b4fc" strokeWidth="1.2" />
        <circle cx="18" cy="20" r="2.2" fill="#c7d2fe" />
        <rect x="31" y="13" width="48" height="5" rx="2.5" fill="#f8fafc" fillOpacity="0.9" />
        <rect x="31" y="23" width="34" height="4" rx="2" fill="#cbd5e1" fillOpacity="0.55" />
      </g>

      {/* Left satellite card 2: Knowledge citation */}
      <g transform="translate(14, 74)">
        <rect width="94" height="40" rx="10" fill="url(#lg-card)" stroke="#ffffff" strokeOpacity="0.18" />
        <rect x="12" y="12" width="14" height="16" rx="3.5" fill="#38bdf8" fillOpacity="0.22" stroke="#7dd3fc" strokeWidth="1.2" />
        <rect x="32" y="13" width="42" height="5" rx="2.5" fill="#f8fafc" fillOpacity="0.88" />
        <rect x="32" y="23" width="50" height="4" rx="2" fill="#94a3b8" fillOpacity="0.6" />
      </g>

      {/* Central AI Orchestrator Hub */}
      <g transform="translate(154, 34)">
        <rect x="-5" y="-5" width="82" height="74" rx="20" fill="#6366f1" fillOpacity="0.16" stroke="#818cf8" strokeOpacity="0.32" />
        <rect width="72" height="64" rx="16" fill="#161d42" stroke="#a5b4fc" strokeOpacity="0.65" strokeWidth="1.25" />
        {/* Sparkle / Prism core */}
        <path
          d="M36 16 L40.2 27.8 L52 32 L40.2 36.2 L36 48 L31.8 36.2 L20 32 L31.8 27.8 Z"
          fill="#c7d2fe"
          stroke="#ffffff"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <circle cx="36" cy="32" r="3" fill="#4f46e5" />
      </g>

      {/* Right output card 1: High-intent score */}
      <g transform="translate(272, 20)">
        <rect width="96" height="42" rx="10" fill="url(#lg-card)" stroke="#34d399" strokeOpacity="0.45" />
        <rect x="11" y="11" width="30" height="18" rx="6" fill="#10b981" fillOpacity="0.24" />
        <text x="26" y="23.5" textAnchor="middle" fill="#6ee7b7" fontSize="10" fontWeight="700" fontFamily="ui-sans-serif, system-ui">96%</text>
        <rect x="47" y="13" width="38" height="5" rx="2.5" fill="#ffffff" fillOpacity="0.92" />
        <rect x="47" y="23" width="28" height="4" rx="2" fill="#a7f3d0" fillOpacity="0.7" />
      </g>

      {/* Right output card 2: Risk verified */}
      <g transform="translate(272, 72)">
        <rect width="96" height="42" rx="10" fill="url(#lg-card)" stroke="#ffffff" strokeOpacity="0.18" />
        <path d="M23 12 L31 15.5 V22 C31 26.8 27.6 30.2 23 32 C18.4 30.2 15 26.8 15 22 V15.5 Z" fill="#818cf8" fillOpacity="0.28" stroke="#c7d2fe" strokeWidth="1.2" />
        <path d="M19.8 21.8 L22.1 24.1 L26.6 19.5" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="40" y="13" width="44" height="5" rx="2.5" fill="#f8fafc" fillOpacity="0.9" />
        <rect x="40" y="23" width="34" height="4" rx="2" fill="#cbd5e1" fillOpacity="0.58" />
      </g>
    </svg>
  );
}

/**
 * AI Prospecting Empty / Hero Illustration:
 * Social comment signals -> AI intent scoring radar -> High-intent lead card.
 */
export function ProspectingIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 248 104" width="248" height="104" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="pr-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="124" cy="54" rx="96" ry="44" fill="url(#pr-glow)" />

      {/* Left stacked comment stream card */}
      <g transform="translate(10, 22)">
        <rect x="4" y="6" width="84" height="56" rx="11" fill="var(--cds-surface-0, #f7f8fb)" stroke="var(--cds-border, #e2e6ef)" />
        <rect width="84" height="56" rx="11" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e6ef)" strokeWidth="1.2" />
        <circle cx="16" cy="18" r="6" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 16%, transparent)" />
        <rect x="27" y="14" width="44" height="4.5" rx="2.25" fill="var(--cds-text-primary, #111827)" fillOpacity="0.72" />
        <rect x="27" y="22" width="32" height="3.5" rx="1.75" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.5" />
        <line x1="11" y1="33" x2="73" y2="33" stroke="var(--cds-border, #e2e6ef)" />
        <circle cx="16" cy="43" r="5" fill="var(--cds-surface-3, #f1f3f8)" stroke="var(--cds-border-strong, #cdd4e2)" />
        <rect x="26" y="40" width="46" height="4.5" rx="2.25" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.45" />
      </g>

      {/* Connector left -> center */}
      <path d="M96 50 H112" stroke="var(--app-accent, #4f46e5)" strokeWidth="1.5" strokeDasharray="2.5 2.5" />

      {/* Center AI filter node */}
      <g transform="translate(110, 34)">
        <circle cx="18" cy="18" r="21" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.2" strokeWidth="1.2" />
        <rect width="36" height="36" rx="12" fill="var(--app-accent, #4f46e5)" />
        <path
          d="M18 9.5 L20.8 15.2 L26.5 18 L20.8 20.8 L18 26.5 L15.2 20.8 L9.5 18 L15.2 15.2 Z"
          fill="#ffffff"
        />
      </g>

      {/* Connector center -> right */}
      <path d="M148 50 H162" stroke="var(--app-accent, #4f46e5)" strokeWidth="1.5" />

      {/* Right qualified high-intent card */}
      <g transform="translate(162, 16)">
        <rect width="78" height="68" rx="12" fill="var(--cds-surface-2, #ffffff)" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.45" strokeWidth="1.35" />
        <rect x="9" y="10" width="42" height="15" rx="7.5" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 13%, transparent)" />
        <circle cx="16.5" cy="17.5" r="2.8" fill="var(--app-accent, #4f46e5)" />
        <text x="33" y="20.5" textAnchor="middle" fill="var(--app-accent, #4f46e5)" fontSize="8.5" fontWeight="700" fontFamily="ui-sans-serif, system-ui">94分</text>
        <rect x="9" y="33" width="58" height="5" rx="2.5" fill="var(--cds-text-primary, #111827)" fillOpacity="0.82" />
        <rect x="9" y="43" width="46" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.55" />
        <rect x="9" y="53" width="32" height="6" rx="3" fill="color-mix(in srgb, #10b981 18%, transparent)" />
        <circle cx="64" cy="56" r="6" fill="var(--app-accent, #4f46e5)" fillOpacity="0.14" />
        <path d="M61.5 56 L63.5 58 L67 54.2" stroke="var(--app-accent, #4f46e5)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/**
 * GEO Visibility Illustration:
 * 4 AI Engine nodes converging into a central verified brand citation card.
 */
export function GeoIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 260 106" width="260" height="106" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="geo-glow" cx="55%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="145" cy="53" rx="95" ry="44" fill="url(#geo-glow)" />

      {/* Bezier streams from 4 AI engines */}
      <g stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.42" strokeWidth="1.35">
        <path d="M52 22 C 84 22, 90 44, 118 46" />
        <path d="M52 44 C 82 44, 92 49, 118 50" strokeDasharray="3 2.5" />
        <path d="M52 66 C 82 66, 92 56, 118 55" />
        <path d="M52 88 C 84 88, 90 62, 118 59" strokeDasharray="3 2.5" />
      </g>

      {/* 4 Satellite AI Engine Pills */}
      {[
        { y: 13, label: 'DS', dot: '#4f46e5' },
        { y: 35, label: '豆包', dot: '#0ea5e9' },
        { y: 57, label: 'Kimi', dot: '#8b5cf6' },
        { y: 79, label: '千问', dot: '#10b981' },
      ].map(engine => (
        <g key={engine.label} transform={`translate(8, ${engine.y})`}>
          <rect width="46" height="18" rx="9" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e6ef)" strokeWidth="1.15" />
          <circle cx="10" cy="9" r="3" fill={engine.dot} />
          <text x="27" y="12" textAnchor="middle" fill="var(--cds-text-secondary, #4b5565)" fontSize="8" fontWeight="650" fontFamily="ui-sans-serif, system-ui">{engine.label}</text>
        </g>
      ))}

      {/* Central Elevated Citation Ranking Card */}
      <g transform="translate(116, 14)">
        <rect x="4" y="5" width="130" height="78" rx="14" fill="var(--cds-surface-0, #f7f8fb)" stroke="var(--cds-border, #e2e6ef)" />
        <rect width="130" height="78" rx="14" fill="var(--cds-surface-2, #ffffff)" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.45" strokeWidth="1.35" />

        {/* Top Rank Badge */}
        <rect x="12" y="11" width="54" height="16" rx="8" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 13%, transparent)" />
        <text x="39" y="21.8" textAnchor="middle" fill="var(--app-accent, #4f46e5)" fontSize="8.5" fontWeight="700" fontFamily="ui-sans-serif, system-ui">TOP 1 引用</text>

        {/* Verified dot */}
        <circle cx="114" cy="19" r="5" fill="color-mix(in srgb, #10b981 18%, transparent)" />
        <path d="M111.8 19 L113.5 20.7 L116.5 17.4" stroke="#10b981" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />

        {/* Citation lines */}
        <rect x="12" y="35" width="82" height="5" rx="2.5" fill="var(--cds-text-primary, #111827)" fillOpacity="0.82" />
        <rect x="12" y="45" width="64" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.52" />

        {/* Mini visibility lift bar chart */}
        <g transform="translate(12, 57)">
          <rect x="0" y="6" width="14" height="6" rx="2" fill="var(--cds-border, #e2e6ef)" />
          <rect x="18" y="4" width="14" height="8" rx="2" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 35%, transparent)" />
          <rect x="36" y="1" width="14" height="11" rx="2" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 65%, transparent)" />
          <rect x="54" y="-3" width="14" height="15" rx="2" fill="var(--app-accent, #4f46e5)" />
        </g>
      </g>
    </svg>
  );
}

/**
 * Knowledge Library Empty Illustration:
 * Multi-format documents -> Semantic chunking -> Hybrid search match.
 */
export function KnowledgeDocsIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 220 98" width="220" height="98" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="kb-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="110" cy="50" rx="88" ry="40" fill="url(#kb-glow)" />

      {/* Left fanned document stack */}
      <g transform="translate(18, 18) rotate(-5)">
        <rect width="52" height="64" rx="9" fill="var(--cds-surface-0, #f7f8fb)" stroke="var(--cds-border-strong, #cdd4e2)" />
        <rect x="8" y="10" width="20" height="8" rx="3" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 16%, transparent)" />
        <rect x="8" y="24" width="34" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.45" />
        <rect x="8" y="32" width="28" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.35" />
      </g>

      <g transform="translate(36, 14)">
        <rect width="58" height="68" rx="10" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e6ef)" strokeWidth="1.25" />
        <rect x="9" y="10" width="24" height="10" rx="4" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 14%, transparent)" />
        <text x="21" y="17.5" textAnchor="middle" fill="var(--app-accent, #4f46e5)" fontSize="7" fontWeight="700" fontFamily="ui-sans-serif, system-ui">DOCX</text>
        <rect x="9" y="26" width="40" height="4.5" rx="2.25" fill="var(--cds-text-primary, #111827)" fillOpacity="0.75" />
        <rect x="9" y="35" width="34" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.5" />
        <rect x="9" y="44" width="38" height="8" rx="3" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 14%, transparent)" />
        <rect x="9" y="56" width="26" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.4" />
      </g>

      {/* Connector */}
      <path d="M98 48 H118" stroke="var(--app-accent, #4f46e5)" strokeWidth="1.4" strokeDasharray="2.5 2.5" />

      {/* Right semantic chunk + search loupe card */}
      <g transform="translate(120, 16)">
        <rect width="82" height="66" rx="12" fill="var(--cds-surface-2, #ffffff)" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.42" strokeWidth="1.3" />
        <rect x="10" y="11" width="62" height="16" rx="5" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 11%, transparent)" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.28" />
        <rect x="15" y="17" width="38" height="4" rx="2" fill="var(--app-accent, #4f46e5)" />
        <rect x="10" y="33" width="62" height="12" rx="4" fill="var(--cds-surface-0, #f7f8fb)" />
        <rect x="15" y="37.5" width="44" height="3.5" rx="1.75" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.5" />
        <rect x="10" y="49" width="42" height="8" rx="4" fill="var(--cds-surface-0, #f7f8fb)" />

        {/* Floating search badge */}
        <g transform="translate(56, 42)">
          <circle cx="14" cy="14" r="14" fill="var(--app-accent, #4f46e5)" />
          <circle cx="12.5" cy="12.5" r="4.8" stroke="#ffffff" strokeWidth="1.6" />
          <line x1="16.2" y1="16.2" x2="19.5" y2="19.5" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}

/**
 * AI Content Factory Illustration:
 * Poster artboard + multi-channel copywriting card + AI sparkle wand.
 */
export function CreativeCanvasIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 228 100" width="228" height="100" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="cf-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.17" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="114" cy="50" rx="90" ry="42" fill="url(#cf-glow)" />

      {/* Left Poster Artboard */}
      <g transform="translate(22, 14)">
        <rect width="86" height="70" rx="12" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e6ef)" strokeWidth="1.25" />
        <rect x="8" y="8" width="70" height="40" rx="7" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 12%, var(--cds-surface-0, #f7f8fb))" />
        <circle cx="60" cy="21" r="6" fill="var(--app-accent, #4f46e5)" fillOpacity="0.32" />
        <path d="M12 46 L32 25 L48 39 L58 30 L74 46 Z" fill="var(--app-accent, #4f46e5)" fillOpacity="0.24" />
        <rect x="10" y="55" width="42" height="5" rx="2.5" fill="var(--cds-text-primary, #111827)" fillOpacity="0.76" />
        <circle cx="64" cy="57.5" r="3.5" fill="var(--app-accent, #4f46e5)" />
        <circle cx="73" cy="57.5" r="3.5" fill="var(--app-accent-secondary, #7c3aed)" fillOpacity="0.6" />
      </g>

      {/* Overlapping Copywriting Card */}
      <g transform="translate(102, 22)">
        <rect width="102" height="64" rx="12" fill="var(--cds-surface-2, #ffffff)" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.42" strokeWidth="1.3" />
        <rect x="11" y="11" width="44" height="13" rx="6.5" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 13%, transparent)" />
        <text x="33" y="20" textAnchor="middle" fill="var(--app-accent, #4f46e5)" fontSize="7.5" fontWeight="700" fontFamily="ui-sans-serif, system-ui">多渠道成稿</text>
        <rect x="11" y="31" width="78" height="4.5" rx="2.25" fill="var(--cds-text-primary, #111827)" fillOpacity="0.8" />
        <rect x="11" y="40" width="68" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.52" />
        <rect x="11" y="49" width="50" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.42" />

        {/* Sparkle badge */}
        <g transform="translate(76, -8)">
          <rect width="28" height="28" rx="9" fill="var(--app-accent, #4f46e5)" />
          <path d="M14 6.5 L16.1 11.9 L21.5 14 L16.1 16.1 L14 21.5 L11.9 16.1 L6.5 14 L11.9 11.9 Z" fill="#ffffff" />
        </g>
      </g>
    </svg>
  );
}

/**
 * Contract Risk Review Illustration:
 * Clause highlight lines + precision risk shield badge.
 */
export function ContractShieldIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 208 92" width="208" height="92" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <defs>
        <radialGradient id="ct-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--app-accent, #4f46e5)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="104" cy="46" rx="84" ry="38" fill="url(#ct-glow)" />

      <g transform="translate(32, 10)">
        <rect width="124" height="72" rx="12" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e6ef)" strokeWidth="1.25" />
        <rect x="12" y="12" width="54" height="5" rx="2.5" fill="var(--cds-text-primary, #111827)" fillOpacity="0.8" />
        <rect x="12" y="23" width="96" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.45" />
        {/* Highlighted risk clause */}
        <rect x="10" y="33" width="100" height="16" rx="5" fill="color-mix(in srgb, #f59e0b 14%, transparent)" stroke="#f59e0b" strokeOpacity="0.45" />
        <rect x="16" y="39" width="72" height="4.5" rx="2.25" fill="#d97706" fillOpacity="0.85" />
        <rect x="12" y="56" width="80" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.45" />
      </g>

      {/* Floating Verification Shield */}
      <g transform="translate(134, 34)">
        <rect width="42" height="42" rx="13" fill="var(--app-accent, #4f46e5)" />
        <path
          d="M21 10 L30 13.8 V21.2 C30 26.8 26.1 30.8 21 32.8 C15.9 30.8 12 26.8 12 21.2 V13.8 Z"
          fill="#ffffff"
          fillOpacity="0.2"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
        <path d="M17.2 21.2 L19.9 23.9 L25.2 18.5" stroke="#ffffff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/**
 * Audio Waveform -> Speaker Diarized Transcript Illustration.
 */
export function AudioWaveIllustration({ className }: { className?: string }) {
  const bars = [10, 18, 28, 16, 34, 24, 14, 26, 20, 12];
  return (
    <svg viewBox="0 0 220 88" width="220" height="88" fill="none" aria-hidden="true" className={className} style={svgBase}>
      <g transform="translate(16, 22)">
        <rect width="78" height="44" rx="11" fill="var(--cds-surface-2, #ffffff)" stroke="var(--cds-border, #e2e6ef)" strokeWidth="1.2" />
        {bars.map((h, i) => (
          <rect
            key={i}
            x={10 + i * 6}
            y={22 - h / 2}
            width="3.2"
            height={h}
            rx="1.6"
            fill={i >= 3 && i <= 6 ? 'var(--app-accent, #4f46e5)' : 'var(--cds-border-strong, #cdd4e2)'}
          />
        ))}
      </g>
      <path d="M98 44 H116" stroke="var(--app-accent, #4f46e5)" strokeWidth="1.4" strokeDasharray="2.5 2.5" />
      <g transform="translate(118, 14)">
        <rect width="88" height="60" rx="11" fill="var(--cds-surface-2, #ffffff)" stroke="var(--app-accent, #4f46e5)" strokeOpacity="0.4" strokeWidth="1.25" />
        <rect x="10" y="10" width="26" height="10" rx="5" fill="color-mix(in srgb, var(--app-accent, #4f46e5) 14%, transparent)" />
        <rect x="10" y="25" width="66" height="4.5" rx="2.25" fill="var(--cds-text-primary, #111827)" fillOpacity="0.78" />
        <rect x="10" y="34" width="54" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.5" />
        <rect x="10" y="44" width="40" height="4" rx="2" fill="var(--cds-text-muted, #8b95a7)" fillOpacity="0.4" />
      </g>
    </svg>
  );
}
