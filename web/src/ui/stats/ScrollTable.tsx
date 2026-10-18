import { type ReactNode, useLayoutEffect, useRef } from 'react'

/**
 * A box around a table that may scroll sideways on a narrow screen, reachable by keyboard so it can be scrolled
 * without a pointer (as code blocks are, ui/render/Sanitized.tsx). Named by the table's heading.
 */
export function ScrollTable({
  className,
  labelledBy,
  children,
}: {
  className?: string
  labelledBy?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.tabIndex = 0
  }, [])
  return (
    <section ref={ref} className={className} aria-labelledby={labelledBy}>
      {children}
    </section>
  )
}
