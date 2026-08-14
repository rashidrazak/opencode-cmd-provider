// tests/harness.ts
let failures = 0
export function assert(cond: unknown, msg?: string): void {
  if (!cond) throw new Error(msg ?? "assertion failed")
}
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    return (
      aKeys.length === bKeys.length &&
      aKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(b, key) &&
          deepEqual(a[key as keyof typeof a], b[key as keyof typeof b]),
      )
    )
  }
  return false
}
export function assertEqual(actual: unknown, expected: unknown, msg?: string): void {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      `${msg ?? "assertion"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}
export async function rejects(
  promise: Promise<unknown>,
  matcher: RegExp | ((err: unknown) => boolean),
  msg?: string,
): Promise<void> {
  try {
    await promise
    throw new Error(`${msg ?? "expected rejection"} — promise resolved`)
  } catch (err) {
    if (err instanceof Error && err.message.includes("expected rejection")) throw err
    if (typeof matcher === "function") {
      if (!matcher(err)) throw new Error(`rejection did not match: ${String(err)}`)
      return
    }
    if (!(err instanceof Error) || !matcher.test(err.message)) {
      throw new Error(`rejection did not match ${matcher}: ${String(err)}`)
    }
  }
}
export async function run(suite: Array<[string, () => Promise<void> | void]>): Promise<void> {
  for (const [name, fn] of suite) {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (err) {
      failures++
      console.error(`FAIL - ${name}: ${(err as Error).message}`)
    }
  }
  if (failures > 0) process.exit(1)
}
