import Anthropic from '@anthropic-ai/sdk'
import type { LlmClient } from './client.js'

export class AnthropicLlmClient implements LlmClient {
  private client: Anthropic
  private model: string
  private temperature: number

  constructor(model: string, temperature: number) {
    this.model = model
    this.temperature = temperature
    this.client = new Anthropic()
  }

  async call(systemPrompt: string, userMessage: string, maxTokens: number): Promise<string> {
    const maxRetries = 3
    const retryBackoffs: Record<string, number[]> = {
      rate_limit: [5000, 10000, 20000],
      server_error: [2000, 4000],
      timeout: [2000, 4000],
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const stream = this.client.messages.stream({
          model: this.model,
          max_tokens: maxTokens,
          temperature: this.temperature,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        })

        const response = await stream.finalMessage()
        const textBlocks = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
        return textBlocks.join('')
      } catch (error: unknown) {
        const err = error as {
          status?: number
          code?: string
          message?: string
        }

        const is429 =
          err.status === 429 ||
          (err.message && err.message.toLowerCase().includes('rate limit'))
        const is500or503 = err.status === 500 || err.status === 503
        const isTimeout =
          err.code === 'ETIMEDOUT' ||
          (err.message && err.message.toLowerCase().includes('timeout'))

        let backoffMs: number | undefined

        if (is429) {
          backoffMs = retryBackoffs.rate_limit[attempt] ?? retryBackoffs.rate_limit[retryBackoffs.rate_limit.length - 1]
        } else if (is500or503) {
          backoffMs = retryBackoffs.server_error[attempt] ?? retryBackoffs.server_error[retryBackoffs.server_error.length - 1]
        } else if (isTimeout) {
          backoffMs = retryBackoffs.timeout[attempt] ?? retryBackoffs.timeout[retryBackoffs.timeout.length - 1]
        } else {
          throw error
        }

        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
        } else {
          throw error
        }
      }
    }

    throw new Error('Max retries exceeded')
  }
}
