// Registers ./test-ts-resolve-hook.mjs as a module customization hook — see
// that file for why this is needed. Loaded via `node --import` (see the
// "test" script in package.json), which is the non-deprecated replacement
// for `--experimental-loader`.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./test-ts-resolve-hook.mjs', pathToFileURL(`${import.meta.dirname}/`))
