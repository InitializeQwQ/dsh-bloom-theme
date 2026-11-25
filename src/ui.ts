import { buildSparkles } from './starlight.js'
import { buildLiquidLens } from './liquid-lens.js'
import { buildFogDefinitions } from './fog.js'

/** React comes from the host loader; no second React copy is bundled. */
export interface HostReact {
  createElement(type: string | (() => unknown), props: Record<string, unknown>): unknown
  useRef<T>(initial: T): { current: T }
  useEffect(setup: () => void | (() => void), deps: unknown[]): void
}

/** Shell overlay for decorations and the update notice. */
export function createBloomDecorations(React: HostReact, installUpdateCheck: (host: HTMLElement) => () => void) {
  return function Decorations() {
    const host = React.useRef<HTMLDivElement | null>(null)
    React.useEffect(() => {
      const container = host.current
      if (!container) return
      const sparkles = buildSparkles(container.ownerDocument)
      const lens = buildLiquidLens(container.ownerDocument)
      const fog = buildFogDefinitions(container.ownerDocument)
      container.append(lens, fog, sparkles)
      const stopUpdates = installUpdateCheck(container)
      return () => {
        stopUpdates()
        sparkles.remove()
        lens.remove()
        fog.remove()
      }
    }, [])
    return React.createElement('div', { ref: host, className: 'dsh-bloom-overlay', 'data-bloom-slot': 'decorations' })
  }
}
