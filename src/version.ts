// Which build this is, for the screen page's footer and the services it fetches from.

// The commit the server was built from, with a * for changes not committed: set by scripts/build
// (empty outside a git checkout), missing in tests and the dev server
declare const BUILD_VERSION: string | undefined;
export const version =
  typeof BUILD_VERSION === "string" && BUILD_VERSION !== "" ? BUILD_VERSION : undefined;

// Who runs this server, e.g. an email address: CONTACT in .env. Each deployment gives its own, so
// the services hear from whoever runs it
const contact = process.env.CONTACT?.trim();

/**
 * Sent with every request to other services (Transitous, OpenFreeMap, MVG): the application's name,
 * its version and the contact if there is one, as Transitous' usage policy asks, so they can reach
 * whoever runs it if needed.
 */
export const USER_AGENT = `TRMNLx/${version ?? "dev"} (self-hosted e-ink display server${contact ? `; ${contact}` : ""})`;
