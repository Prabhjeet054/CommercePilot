const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * CORS allow-list for FRONTEND_URL.
 * `localhost` and `127.0.0.1` are the same machine but different browser origins;
 * both are accepted when FRONTEND_URL uses either, as long as scheme and port match.
 * Any other host (including a different port) is rejected.
 */
export function isAllowedFrontendOrigin(
  requestOrigin: string | undefined,
  frontendUrl: string,
): boolean {
  if (!requestOrigin) {
    return true;
  }
  if (requestOrigin === frontendUrl) {
    return true;
  }

  try {
    const allowed = new URL(frontendUrl);
    const origin = new URL(requestOrigin);
    const allowedPort = allowed.port || (allowed.protocol === "https:" ? "443" : "80");
    const originPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
    return (
      origin.protocol === allowed.protocol &&
      originPort === allowedPort &&
      LOOPBACK_HOSTS.has(origin.hostname) &&
      LOOPBACK_HOSTS.has(allowed.hostname)
    );
  } catch {
    return false;
  }
}
