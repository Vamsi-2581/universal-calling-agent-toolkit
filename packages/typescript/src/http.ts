/** Minimal injectable HTTP layer for provider REST APIs. Tests pass a mock; production uses fetch. */
import { ProviderError, type ProviderErrorCode } from "./errors.js";
import { isObject, type JsonObject } from "./parse.js";

export interface HttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export const fetchHttpClient: HttpClient = async ({ method, url, headers, body, signal }) => {
  const res = await fetch(url, { method, headers, ...(body !== undefined && { body }), ...(signal && { signal }) });
  return { status: res.status, body: await res.text() };
};

export function basicAuth(user: string, secret: string): string {
  return "Basic " + Buffer.from(`${user}:${secret}`, "utf8").toString("base64");
}

function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  if (status === 400 || status === 404 || status === 422) return "invalid_configuration";
  return "unknown";
}

/** Maps an HTTP error response to a ProviderError. Only the provider's own message is kept, truncated. */
export function errorFromResponse(provider: string, res: HttpResponse): ProviderError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = undefined;
  }
  const obj = isObject(parsed) ? parsed : {};
  const rawCode = obj["code"];
  const detail = typeof obj["message"] === "string" ? obj["message"] : typeof obj["error"] === "string" ? obj["error"] : "";
  return new ProviderError({
    code: codeForStatus(res.status),
    provider,
    message: `${provider} API returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    ...(typeof rawCode === "number" || typeof rawCode === "string" ? { providerCode: String(rawCode) } : {}),
  });
}

export interface CallApiOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Sends a request with a timeout; non-2xx responses become typed ProviderErrors. */
export async function callApi(provider: string, client: HttpClient, request: HttpRequest, options: CallApiOptions = {}): Promise<HttpResponse> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 10_000);
  let res: HttpResponse;
  try {
    res = await client({ ...request, signal: controller.signal });
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (timedOut) throw new ProviderError({ code: "timeout", provider, message: `${provider} API did not respond in time.`, cause: err });
    if (options.signal?.aborted) throw new ProviderError({ code: "unknown", provider, message: "Request was cancelled.", retryable: false, cause: err });
    throw new ProviderError({ code: "provider_unavailable", provider, message: `${provider} API request failed.`, cause: err });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (res.status < 200 || res.status >= 300) throw errorFromResponse(provider, res);
  return res;
}

export function jsonBody(provider: string, res: HttpResponse): JsonObject {
  try {
    const parsed: unknown = JSON.parse(res.body);
    if (isObject(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new ProviderError({ code: "protocol_violation", provider, message: `${provider} API returned an unexpected response body.` });
}
