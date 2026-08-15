/**
 * Fetching a URL this process did not choose.
 *
 * The moment a URL comes from a model, a search result, or something a person
 * pasted, an outbound request stops being a network call and becomes an
 * instruction we are executing on someone else's behalf. `http://169.254.169.254/`
 * is a perfectly ordinary URL, and on a cloud host it returns the instance's
 * credentials. So is `http://10.0.0.5:6379/`. The internet is not the only thing
 * a server can reach, and by default it will reach the rest quite happily.
 *
 * This is the one door out for that traffic. It is deliberately not a wrapper
 * around `fetch`: `fetch` follows redirects for you, and following a redirect is
 * the single most common way a validated URL turns into an unvalidated one.
 *
 * Built on `node:http`/`node:https` rather than undici, for three reasons that
 * all point the same way — redirects are opt-in rather than opt-out, `lookup`
 * is a supported option rather than an agent-internal hook, and the body arrives
 * as a stream that can be abandoned mid-flight instead of a promise that
 * buffers however much the far end decided to send. No new dependency either.
 *
 * Two failure modes here are not obvious, and both were verified rather than
 * assumed. They are documented at `hostIsAddressLiteral` and `guardedLookup`,
 * because each one silently defeats the guard that appears to be doing the work.
 */
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';

export type GuardedFetchRefusal =
  /** The URL was rejected before any request was made. */
  | 'unsafe_url'
  /** DNS pointed at an address inside the network this process sits in. */
  | 'blocked_address'
  | 'too_many_redirects'
  | 'unacceptable_type'
  | 'too_large'
  | 'timeout'
  | 'unreachable'
  | 'http_error';

export class GuardedFetchError extends Error {
  constructor(
    readonly reason: GuardedFetchRefusal,
    message: string,
    /** Present for `http_error`, so a caller can tell 404 from 503. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GuardedFetchError';
  }
}

export interface GuardedFetchOptions {
  /**
   * Content types this caller can actually use, as prefixes: `['image/']`,
   * `['text/html']`.
   *
   * An allowlist rather than a blocklist, and checked on the *response* rather
   * than requested with `Accept`, which is a wish rather than a constraint.
   */
  readonly accept: readonly string[];
  /** Bytes past which the response is abandoned rather than buffered. */
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Hops allowed. Each one is re-validated from scratch. */
  readonly maxRedirects: number;
}

export interface GuardedResponse {
  readonly body: Buffer;
  readonly contentType: string;
  /** Where the bytes actually came from, after any redirects. */
  readonly url: string;
}

/**
 * Hosts that are never worth a DNS lookup.
 *
 * `localhost` resolves through the system resolver — and on a machine with an
 * unusual `/etc/hosts` it can resolve to anything at all — so it is refused by
 * name as well as by address. `.local` is mDNS: a name that only means anything
 * inside the network this process is sitting in, which is the definition of what
 * this module exists to keep out.
 */
const REFUSED_HOST_SUFFIXES = ['localhost', '.localhost', '.local', '.internal', '.home.arpa'];

/**
 * Is the host an IP address written out, rather than a name?
 *
 * **This is the check that a DNS-based guard cannot make, and skipping it
 * defeats the whole module.** A `lookup` hook only runs when there is a name to
 * resolve. Point a request at `http://127.0.0.1/` or `http://169.254.169.254/`
 * and there is nothing to look up, so the hook is never called — verified
 * against Node v22: zero invocations. A guard implemented purely as a `lookup`
 * hook is therefore wide open to the exact address that matters most.
 *
 * So address literals are refused here, before a request exists. We lose the
 * ability to fetch an icon from a bare IP, which no real site is served from.
 */
function hostIsAddressLiteral(hostname: string): boolean {
  // A bracketed IPv6 host arrives as `[::1]` from `URL`.
  return isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;
}

/** IPv4 ranges that are not the public internet, as [firstOctetMatch, test]. */
function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    // Unparseable is refused: this function's answer is used to allow traffic.
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true;                                    // "this network"
  if (a === 10) return true;                                   // RFC1918
  if (a === 127) return true;                                  // loopback
  if (a === 169 && b === 254) return true;                     // link-local — cloud metadata lives here
  if (a === 172 && b >= 16 && b <= 31) return true;            // RFC1918
  if (a === 192 && b === 168) return true;                     // RFC1918
  if (a === 192 && b === 0) return true;                       // IETF protocol assignments + TEST-NET-1
  if (a === 100 && b >= 64 && b <= 127) return true;           // carrier NAT
  if (a === 198 && (b === 18 || b === 19)) return true;        // benchmarking
  if (a === 198 && b === 51) return true;                      // TEST-NET-2
  if (a === 203 && b === 0) return true;                       // TEST-NET-3
  if (a >= 224) return true;                                   // multicast, reserved, broadcast
  return false;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase().split('%')[0]!;           // drop any zone id
  if (value === '::1' || value === '::') return true;
  // An IPv4 address wearing an IPv6 hat still goes to the same machine.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  const head = value.split(':')[0] ?? '';
  if (/^f[cd]/.test(head)) return true;                        // unique local, fc00::/7
  if (/^fe[89ab]/.test(head)) return true;                     // link-local, fe80::/10
  if (/^ff/.test(head)) return true;                           // multicast
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

/**
 * The DNS hook, refusing to hand back an address inside our own network.
 *
 * **Every address is checked, not the first one.** Node calls `lookup` with
 * `all: true`, and a host with several A records comes back as a list —
 * `example.com` returns two. A guard that validates `addresses[0]` and passes
 * the array through is defeated by any attacker who can publish two records,
 * one public and one internal, which costs nothing. Verified rather than
 * assumed; it is the kind of thing that looks correct in review.
 *
 * Checking here rather than resolving up front is also what closes DNS
 * rebinding: this *is* the resolution the socket then connects with, so there
 * is no window between the check and the connection for the answer to change.
 */
const guardedLookup: LookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void => {
  dnsLookup(hostname, options, (error, address, family) => {
    if (error) return callback(error, '', undefined);

    const addresses: LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address: address as string, family: family as number }];

    if (addresses.length === 0 || addresses.some(entry => isBlockedAddress(entry.address))) {
      const refusal: NodeJS.ErrnoException = new Error(
        `refusing to connect to ${hostname}: resolves inside a private network`,
      );
      refusal.code = 'EBLOCKED';
      return callback(refusal, '', undefined);
    }

    return Array.isArray(address)
      ? callback(null, addresses)
      : callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};

/**
 * Everything decidable about a URL before a packet is sent.
 *
 * Re-run on every redirect hop. A URL that passed once says nothing about where
 * a `Location` header points, and "validate then follow redirects" is the
 * classic way a guard is bypassed by a server that answers `302` to somewhere
 * internal.
 */
export function assertFetchableUrl(raw: string): Result<URL, GuardedFetchError> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(new GuardedFetchError('unsafe_url', 'not a URL'));
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // `file:`, `data:`, `gopher:` — all of them read something this process can
    // reach and the caller cannot.
    return err(new GuardedFetchError('unsafe_url', `refused scheme ${url.protocol}`));
  }
  if (url.username || url.password) {
    // Credentials in a URL are either an attempt to reuse ours somewhere else,
    // or a leak of someone's into our logs. Neither is worth supporting.
    return err(new GuardedFetchError('unsafe_url', 'refused credentials in URL'));
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return err(new GuardedFetchError('unsafe_url', 'no host'));
  if (hostIsAddressLiteral(hostname)) {
    return err(new GuardedFetchError('unsafe_url', 'refused address literal'));
  }
  if (REFUSED_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(suffix))) {
    return err(new GuardedFetchError('unsafe_url', `refused local name ${hostname}`));
  }

  return ok(url);
}

/** One hop. Redirects are reported, never followed. */
function requestOnce(
  url: URL,
  options: GuardedFetchOptions,
  headers: Record<string, string>,
): Promise<Result<{ response: IncomingMessage } | { redirectTo: string }, GuardedFetchError>> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (
      result: Result<{ response: IncomingMessage } | { redirectTo: string }, GuardedFetchError>,
    ): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const requestOptions: RequestOptions = {
      method: 'GET',
      headers,
      lookup: guardedLookup,
      timeout: options.timeoutMs,
    };

    const outbound = send(url, requestOptions, response => {
      const status = response.statusCode ?? 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();                                     // drain, do not read
        // Resolved against the URL we actually asked, so a relative `Location`
        // lands where the browser would have put it.
        finish(ok({ redirectTo: new URL(response.headers.location, url).toString() }));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        finish(err(new GuardedFetchError('http_error', `HTTP ${status}`, status)));
        return;
      }
      finish(ok({ response }));
    });

    outbound.on('timeout', () => {
      outbound.destroy();
      finish(err(new GuardedFetchError('timeout', `no answer in ${options.timeoutMs}ms`)));
    });
    outbound.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'EBLOCKED'
        ? err(new GuardedFetchError('blocked_address', error.message))
        : err(new GuardedFetchError('unreachable', error.message)));
    });
    outbound.end();
  });
}

/**
 * Read a body, giving up rather than growing.
 *
 * The cap is enforced on what arrives, not on `content-length`: a header is a
 * claim by the far end, and the interesting case is the server that says 1KB
 * and sends forever. Checked per chunk and the socket destroyed on the one that
 * crosses the line, so the ceiling is the cap plus one chunk rather than
 * whatever the sender felt like.
 */
function readCapped(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Result<Buffer, GuardedFetchError>> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: Result<Buffer, GuardedFetchError>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        finish(err(new GuardedFetchError('too_large', `over ${maxBytes} bytes`)));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => finish(ok(Buffer.concat(chunks))));
    response.on('error', error => finish(err(new GuardedFetchError('unreachable', error.message))));
  });
}

/**
 * Fetch a URL nobody in this process chose, or refuse to.
 *
 * Every refusal is a `Result`, never a throw: a caller looking up a favicon for
 * a domain it has never seen is *expected* to be refused sometimes, and an
 * exception is the wrong shape for the normal case.
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions,
): Promise<Result<GuardedResponse, GuardedFetchError>> {
  let next = rawUrl;

  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    const checked = assertFetchableUrl(next);
    if (!checked.ok) return checked;
    const url = checked.value;

    const attempt = await requestOnce(url, options, {
      /* Named honestly. A crawler that pretends to be a browser is asking to be
         blocked by name later, and a site that refuses us is entitled to. */
      'user-agent': 'DivoBot/1.0 (+https://divo.outreachdeal.com)',
      accept: options.accept.map(type => `${type}*`).join(', '),
      'accept-encoding': 'identity',
    });
    if (!attempt.ok) return attempt;

    if ('redirectTo' in attempt.value) {
      next = attempt.value.redirectTo;
      continue;
    }

    const { response } = attempt.value;
    const contentType = (response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!options.accept.some(prefix => contentType.startsWith(prefix))) {
      response.resume();
      return err(new GuardedFetchError('unacceptable_type', `refused ${contentType || 'unknown type'}`));
    }

    const body = await readCapped(response, options.maxBytes);
    if (!body.ok) return body;
    if (body.value.length === 0) {
      return err(new GuardedFetchError('http_error', 'empty body'));
    }

    return ok({ body: body.value, contentType, url: url.toString() });
  }

  return err(new GuardedFetchError('too_many_redirects', `over ${options.maxRedirects} hops`));
}
