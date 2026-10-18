/**
 * opencode-hermes — legacy file-loading entrypoint.
 *
 * Re-exports the dual entry (`index.ts`) so an existing config that points at
 * `plugin.ts` keeps working. New installs can point at the package directory.
 */
export { default } from "./index.ts";
