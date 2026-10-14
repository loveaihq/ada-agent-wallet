/**
 * Redirects, which this wallet never follows on the agent's behalf.
 *
 * The URL signerd checks against `allowedResources` is the one the agent asked for. A client that
 * follows a redirect pays whatever answers 402 at the destination, so a seller (or anything on the
 * path to one) could send a request for an allowed URL to an address the policy never saw, and the
 * payment header would go with it. Handing the 3xx back unpaid puts the destination in the agent's
 * hands instead: it has to ask for it, and that request is checked as a resource of its own.
 *
 * No chain, no keys, no I/O of its own — the fetch is given.
 */

/** A fetch that returns a redirect as it is, whatever the caller's `init` says. */
export function withoutRedirects(base: typeof fetch = fetch): typeof fetch {
  return ((input, init) => base(input, { ...init, redirect: "manual" })) as typeof fetch;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Where a redirect response points, as an absolute URL, or undefined when the response is not a
 * redirect or says nowhere. Resolved against the URL that was asked for, because `Location` may be
 * relative.
 */
export function redirectTo(requestUrl: string, status: number, location: string | null): string | undefined {
  if (!REDIRECT_STATUSES.has(status) || !location) return undefined;
  try {
    return new URL(location, requestUrl).href;
  } catch {
    return undefined;
  }
}

/**
 * For `@modelcontextprotocol/sdk`'s HTTP and SSE transports. Their own default follows a redirect
 * within the origin, which still leaves the path (and so `allowedResources`); `redirectPolicy:
 * "follow"` hands the decision to the `fetch` given, which does not follow. The `fetch` alone is
 * what holds on an SDK that predates the option.
 */
export const MCP_NO_REDIRECTS = { fetch: withoutRedirects(), redirectPolicy: "follow" } as const;
