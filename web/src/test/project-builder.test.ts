import { describe, expect, it } from 'vitest'
import { projectBuilder } from '@/lib/projectName'

const quotes = [
  { id: 'q1', builder_name: 'DECODE' },
  { id: 'q2', builder_name: 'TEST' },
]

describe('projectBuilder', () => {
  it('is empty during tender when no builder was entered', () => {
    expect(
      projectBuilder({
        client: '',
        stage: 'tender',
        awarded_quote_id: null,
        hardware_quotes: quotes,
      }),
    ).toBe('')
  })

  it('keeps the optional builder entered on the project during tender', () => {
    expect(
      projectBuilder({
        client: ' Acme ',
        stage: 'tender',
        awarded_quote_id: null,
        hardware_quotes: quotes,
      }),
    ).toBe('Acme')
  })

  it("is the awarded quote's builder once awarded", () => {
    expect(
      projectBuilder({
        client: 'DECODE',
        stage: 'awarded',
        awarded_quote_id: 'q2',
        hardware_quotes: quotes,
      }),
    ).toBe('TEST')
  })

  it('falls back to the entered builder when the awarded quote is not loaded', () => {
    expect(projectBuilder({ client: 'Acme', stage: 'awarded', awarded_quote_id: 'q9' })).toBe(
      'Acme',
    )
  })
})
