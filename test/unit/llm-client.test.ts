import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { extractJson, callLlmAndParse, type LlmClient } from '../../src/llm/client.js'

const TestSchema = z.object({ name: z.string(), value: z.number() })

describe('extractJson', () => {
  it('extracts bare JSON object', () => {
    const result = extractJson('{"name":"test","value":42}')
    expect(result).toBe('{"name":"test","value":42}')
  })

  it('strips markdown fences (```json)', () => {
    const result = extractJson('```json\n{"name":"test","value":42}\n```')
    expect(result).toBe('{"name":"test","value":42}')
  })

  it('strips plain markdown fences (```)', () => {
    const result = extractJson('```\n{"name":"test","value":42}\n```')
    expect(result).toBe('{"name":"test","value":42}')
  })

  it('extracts JSON from surrounding text', () => {
    const result = extractJson('Here is the result: {"name":"test","value":42} done.')
    expect(result).toBe('{"name":"test","value":42}')
  })

  it('throws on no JSON found', () => {
    expect(() => extractJson('no json here')).toThrow('No JSON object found in response')
  })
})

describe('callLlmAndParse', () => {
  it('parses valid response on first try', async () => {
    const mockClient: LlmClient = {
      call: vi.fn().mockResolvedValue('{"name":"hello","value":123}'),
    }

    const result = await callLlmAndParse(
      mockClient,
      'system',
      'user',
      100,
      TestSchema,
    )

    expect(result).toEqual({ name: 'hello', value: 123 })
    expect(mockClient.call).toHaveBeenCalledTimes(1)
  })

  it('retries with error feedback on Zod failure', async () => {
    const mockClient: LlmClient = {
      call: vi
        .fn()
        .mockResolvedValueOnce('{"name":"hello","value":"not-a-number"}')
        .mockResolvedValueOnce('{"name":"hello","value":42}'),
    }

    const result = await callLlmAndParse(
      mockClient,
      'system',
      'user message',
      100,
      TestSchema,
    )

    expect(result).toEqual({ name: 'hello', value: 42 })
    expect(mockClient.call).toHaveBeenCalledTimes(2)

    const secondCallUserMessage = (mockClient.call as ReturnType<typeof vi.fn>).mock.calls[1][1] as string
    expect(secondCallUserMessage).toContain('validation')
  })

  it('throws after second Zod failure', async () => {
    const mockClient: LlmClient = {
      call: vi
        .fn()
        .mockResolvedValueOnce('{"name":"hello","value":"bad"}')
        .mockResolvedValueOnce('{"name":123,"value":"also-bad"}'),
    }

    await expect(
      callLlmAndParse(mockClient, 'system', 'user', 100, TestSchema),
    ).rejects.toThrow('LLM response failed validation after retry')

    expect(mockClient.call).toHaveBeenCalledTimes(2)
  })
})
