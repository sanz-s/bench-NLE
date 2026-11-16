import { useEffect, useRef } from 'react'

/** Canvas thumbnail; `render(ctx, w, h, phase)` where phase loops 0..1 while hovered. */
export function Thumb({ render, animate = false, hovered, restPhase = 0.5 }: { render: (ctx: CanvasRenderingContext2D, w: number, h: number, phase: number) => void; animate?: boolean; hovered: boolean; restPhase?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!
    const dpr = window.devicePixelRatio || 1
    const w = cv.clientWidth
    const h = cv.clientHeight
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const ctx = cv.getContext('2d')!
    let raf = 0
    const start = performance.now()
    const paint = (phase: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      render(ctx, w, h, phase)
    }
    if (animate && hovered) {
      const loop = (now: number) => {
        paint(((now - start) / 1600) % 1)
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    } else paint(restPhase)
    return () => cancelAnimationFrame(raf)
  }, [render, animate, hovered, restPhase])
  return <canvas ref={ref} className="thumb-canvas" aria-hidden="true" />
}

