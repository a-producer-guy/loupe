// fal.ai, spoken directly over its queue API (no package needed): submit a
// request, wait for it, fetch the result. Files go in as Base64 data URIs, so
// nothing is left behind in B2 or anywhere else. The key comes from FAL_KEY.

export type FalRunOptions = { signal?: AbortSignal; timeoutMs?: number; pollMs?: number };

/** A request in fal's queue: where to ask how it's going, and where its result will be. */
export type FalRequest = { request_id: string; status_url: string; response_url: string };

export class FalError extends Error {}
/** fal is still working on it: the request carries on, and waiting again later picks it up. */
export class FalTimeout extends FalError {}

export class FalClient {
  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { Authorization: `Key ${this.key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new FalError(`fal answered ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Runs one request on an endpoint (like "fal-ai/whisper") and returns its result. */
  async run<T>(endpoint: string, input: Record<string, unknown>, options: FalRunOptions = {}): Promise<T> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    return this.wait<T>(await this.submit(endpoint, input, options.signal), { ...options, timeoutMs: deadline - Date.now() });
  }

  /** Puts a request in fal's queue; keep what comes back to wait for it later (even from another process). */
  submit(endpoint: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<FalRequest> {
    return this.call<FalRequest>(`https://queue.fal.run/${endpoint}`, { method: "POST", body: JSON.stringify(input), signal });
  }

  /** Waits for a queued request to finish and returns its result. */
  async wait<T>(request: FalRequest, options: FalRunOptions = {}): Promise<T> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Stopped");
      const { status } = await this.call<{ status: string }>(request.status_url, { signal: options.signal });
      if (status === "COMPLETED") break;
      if (Date.now() > deadline) throw new FalTimeout(`fal took too long (request ${request.request_id}).`);
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000));
    }
    return this.call<T>(request.response_url, { signal: options.signal });
  }
}

/** A file as a data URI, for fal's file inputs. */
export const dataUri = (bytes: Buffer, contentType: string) => `data:${contentType};base64,${bytes.toString("base64")}`;

export type WhisperWord = { timestamp: [number, number | null]; text: string };
