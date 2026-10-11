// Which build this is, for the screen page's footer and the services it fetches from.

// The commit the server was built from, with a * for changes not committed: set by scripts/build
// (empty outside a git checkout), missing in tests and the dev server
declare const BUILD_VERSION: string | undefined;
export const version = typeof BUILD_VERSION === "string" && BUILD_VERSION !== "" ? BUILD_VERSION : undefined;

/**
 * Sent with every request to other services (Transitous, OpenFreeMap, MVG): the application's name,
 * its version and a contact, as Transitous' usage policy asks, so they can reach us if needed.
 */
export const USER_AGENT = `TRMNLx/${version ?? "dev"} (self-hosted e-ink display server; trmnlx@example.com)`;
