// Module customization hook used only by `npm test` (see package.json).
// Node's native TypeScript support strips types but does NOT add bundler-
// style extensionless resolution — the rest of this codebase relies on
// Next.js/webpack for that (moduleResolution: "bundler" in tsconfig.json).
// This hook bridges the gap for `node --test` by retrying an unresolved
// relative import with a `.ts` extension appended, so lib/*.ts can keep
// importing each other the same way app code does, without editing any
// source file just to make it runnable outside Next.
export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
  const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier)
  if (isRelative && !hasExtension) {
    try {
      return await nextResolve(`${specifier}.ts`, context)
    } catch {
      // Fall through to default resolution (e.g. a directory import).
    }
  }
  return nextResolve(specifier, context)
}
