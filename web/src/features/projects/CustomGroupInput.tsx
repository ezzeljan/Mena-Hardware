import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

/**
 * The custom door group name box. It keeps what's typed to itself and passes
 * it up after a short pause (or on blur / Enter): passing every keystroke up
 * re-rendered the whole Matching Review table, which made typing lag.
 */
export function CustomGroupInput({
  value,
  onCommit,
  ...props
}: {
  value: string
  onCommit: (value: string) => void
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value)
  const committed = useRef(value)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  // The name changed from outside (a saved custom group picked): show it.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value
      setText(value)
    }
  }, [value])

  const flush = (next: string) => {
    if (next === committed.current) return
    committed.current = next
    commitRef.current(next)
  }

  useEffect(() => {
    if (text === committed.current) return
    const t = setTimeout(() => flush(text), 300)
    return () => clearTimeout(t)
  }, [text])

  return (
    <Input
      {...props}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        flush(text)
        props.onBlur?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') flush(text)
        props.onKeyDown?.(e)
      }}
    />
  )
}
