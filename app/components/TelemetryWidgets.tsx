import { type ReactNode } from 'react';

export type TelemetryTone = 'accent' | 'success' | 'warning' | 'danger';

const toneStroke: Record<TelemetryTone, string> = {
  accent: 'var(--app-accent)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
};

export function MiniRingGauge({
  value,
  size = 38,
  strokeWidth = 3.6,
  tone = 'accent',
  centerLabel,
  className = '',
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  tone?: TelemetryTone;
  centerLabel?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;
  const color = toneStroke[tone];

  return (
    <span className={`telemetry-ring ${className}`.trim()} style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="color-mix(in srgb, var(--cds-border-strong) 55%, transparent)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 480ms var(--cds-ease-enter)' }}
        />
      </svg>
      {centerLabel !== undefined && <small className="telemetry-ring-label">{centerLabel}</small>}
    </span>
  );
}

export function MiniSegmentBar({
  segments,
  className = '',
}: {
  segments: { value: number; tone?: TelemetryTone | 'muted' }[];
  className?: string;
}) {
  const nonEmpty = segments.filter(segment => segment.value > 0);
  if (!nonEmpty.length) return null;
  return (
    <div className={`telemetry-segbar ${className}`.trim()} aria-hidden="true">
      {nonEmpty.map((segment, index) => <span
        key={index}
        data-tone={segment.tone ?? 'accent'}
        style={{ flex: `${segment.value} 1 0` }}
      />)}
    </div>
  );
}

export function LiveSignalPill({
  children,
  tone = 'accent',
  shimmer = false,
  className = '',
}: {
  children: ReactNode;
  tone?: TelemetryTone;
  shimmer?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`telemetry-signal-pill ${shimmer ? 'has-shimmer' : ''} ${className}`.trim()}
      data-tone={tone}
    >
      <i className="telemetry-pulse-dot" aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
