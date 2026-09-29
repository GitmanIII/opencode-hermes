/**
 * opencode plugin entrypoint for local/file loading.
 *
 * opencode's plugin loader expects a default-exported Plugin function, while
 * index.ts exports { id, server } (npm-package shape). This wrapper hands the
 * runtime the function directly.
 */
import mod from "./index.ts";

export default mod.server;
