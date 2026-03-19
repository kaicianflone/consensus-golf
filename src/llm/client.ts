import { type ZodType } from 'zod'

export interface LlmClient {
  call(systemPrompt: string, userMessage: string, maxTokens: number): Promise<string>
}

export function extractJson(text: string): string {
  // Check for markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    return fenceMatch[1].trim()
  }

  // Find first `{` and match to closing `}` tracking brace depth
  const start = text.indexOf('{')
  if (start === -1) {
    throw new Error('No JSON object found in response')
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\' && inString) {
      escaped = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return text.slice(start, i + 1)
      }
    }
  }

  throw new Error('No JSON object found in response')
}

export async function callLlmAndParse<T>(
  client: LlmClient,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number,
  schema: ZodType<T>,
): Promise<T> {
  const response = await client.call(systemPrompt, userMessage, maxTokens)
  const jsonStr = extractJson(response)
  const parsed = JSON.parse(jsonStr)
  const result = schema.safeParse(parsed)

  if (result.success) {
    return result.data
  }

  // Build error message from issues
  const issues = result.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ')
  const errorFeedback = `\n\nvalidation failed: ${issues}. Please fix and return valid JSON.`
  const retryUserMessage = userMessage + errorFeedback

  const retryResponse = await client.call(systemPrompt, retryUserMessage, maxTokens)
  const retryJsonStr = extractJson(retryResponse)
  const retryParsed = JSON.parse(retryJsonStr)
  const retryResult = schema.safeParse(retryParsed)

  if (retryResult.success) {
    return retryResult.data
  }

  const retryIssues = retryResult.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join(', ')
  throw new Error(`LLM response failed validation after retry: ${retryIssues}`)
}
