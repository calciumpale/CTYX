import type { StudioBoard, StudioLayer } from './creative-studio-types.ts';

export function studioColor(value: string, fallback: string): string {
  return /^(?:transparent|#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8}))$/i.test(value) ? value : fallback;
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function studioBoardSize(board: StudioBoard) {
  return {
    width: Math.max(1, Math.min(4096, Math.round(finite(board.width, 1080)))),
    height: Math.max(1, Math.min(4096, Math.round(finite(board.height, 1080)))),
  };
}

export function studioLayerStyle(layer: StudioLayer) {
  return {
    left: `${finite(layer.x, 0)}%`,
    top: `${finite(layer.y, 0)}%`,
    width: `${Math.max(0, finite(layer.width, 0))}%`,
    height: `${Math.max(0, finite(layer.height, 0))}%`,
    backgroundColor: studioColor(layer.fill, 'transparent'),
    color: studioColor(layer.color, '#171a1e'),
    fontSize: `${Math.max(1, finite(layer.fontSize, 16))}px`,
    borderRadius: `${Math.max(0, finite(layer.radius, 0))}px`,
    fontWeight: layer.weight === 'bold' ? 'bold' : 'normal',
    textAlign: layer.align === 'right' ? 'right' : layer.align === 'center' ? 'center' : 'left',
  } as const;
}
