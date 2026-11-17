const MAX_URL_LENGTH = 2048;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** An absolute http(s) URL, or null for anything else. */
export function parseHttpUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/** True for an http(s) URL pointing at this machine's loopback interface. */
export function isLoopbackHttpUrl(value) {
  const url = parseHttpUrl(value);
  return url !== null && LOOPBACK_HOSTS.has(url.hostname);
}
