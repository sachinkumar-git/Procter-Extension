import type {
  BatchResponse,
  ExamEvent,
  HeartbeatResponse,
  PairingCodeResponse,
  StartSessionResponse,
} from "@exam-guard/shared";

const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface StartSessionBody {
  contest_id: string;
  candidate_id: string;
  access_code: string;
}

export interface SessionApi {
  startSession(body: StartSessionBody): Promise<StartSessionResponse>;
  heartbeat(token: string): Promise<HeartbeatResponse>;
  endSession(token: string): Promise<void>;
  createPairingCode(token: string): Promise<PairingCodeResponse>;
  sendEvents(token: string, events: ExamEvent[]): Promise<BatchResponse>;
}

/** Plain HTTP is accepted only for a server on this computer. */
export function assertSafeApiUrl(value: string): void {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) {
    throw new Error(`The API URL must use HTTPS: ${value}`);
  }
}

export function createApiClient(baseUrl: string): SessionApi {
  assertSafeApiUrl(baseUrl);

  async function post<T>(path: string, body: unknown, token?: string) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError(0, "network_error");
    }
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new ApiError(response.status, error?.error ?? "request_failed");
    }
    return (await response.json()) as T;
  }

  return {
    startSession: (body) => post("/v1/sessions", body),
    heartbeat: (token) => post("/v1/heartbeat", {}, token),
    endSession: async (token) => {
      await post("/v1/sessions/end", {}, token);
    },
    createPairingCode: (token) => post("/v1/sessions/pairing-code", {}, token),
    sendEvents: (token, events) => post("/v1/events/batch", { events }, token),
  };
}
