import type { Unit } from './types'

export const PX_PER_INCH = 96
export const MM_PER_INCH = 25.4

export function unitToPx(unit: Unit): number {
  switch (unit) {
    case 'px':
      return 1
    case 'inch':
      return PX_PER_INCH
    case 'cm':
      return PX_PER_INCH / (MM_PER_INCH / 10)
    case 'm':
      return PX_PER_INCH / (MM_PER_INCH / 1000)
    default:
      return PX_PER_INCH / MM_PER_INCH
  }
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

export function formatLength(v: number, unit: Unit): string {
  const digits = unit === 'px' ? 0 : unit === 'm' ? 3 : 2
  const s = Math.abs(v) < 1e-9 ? '0' : trimZeros(v.toFixed(digits))
  const suffix = unit === 'inch' ? 'in' : unit
  return `${s} ${suffix}`
}

export function formatScale(zoom: number): string {
  const r = zoom >= 1 ? zoom : 1 / zoom
  const s = r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2)
  return zoom >= 1 ? `${trimZeros(s)}:1` : `1:${trimZeros(s)}`
}
