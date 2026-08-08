/**
 * Reads a fetch Response body as JSON without throwing on an empty body,
 * which native `response.json()` does ("Unexpected end of JSON input").
 * Returns null for an empty body, parses otherwise, and throws a descriptive
 * error (including a snippet of the raw body) if the body is non-empty but
 * not valid JSON.
 */
export async function readJsonSafe<T = unknown>(response: Response): Promise<T | null> {
  const text = await response.text()
  if (!text.trim()) {
    return null
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(
      `Invalid JSON response (${response.status}): ${text.slice(0, 500)}`,
    )
  }
}
