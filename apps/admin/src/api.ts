import type {
  ContestListItem,
  ContestSummary,
  LoginResponse,
  TimelineEvent,
} from "@exam-guard/shared";

export const API_BASE: string =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export interface EventFilters {
  candidate_id?: string;
  type?: string;
  from?: string;
  to?: string;
}

export class UnauthorizedError extends Error {}

/** Converts filter values to a query string, leaving out empty ones. */
export function filterQuery(filters: EventFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function request(path: string, token: string): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    throw new Error(`The server returned ${response.status}.`);
  }
  return response;
}

export async function login(
  username: string,
  password: string,
): Promise<LoginResponse> {
  const response = await fetch(`${API_BASE}/v1/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (response.status === 401) {
    throw new Error("Incorrect username or password.");
  }
  if (!response.ok) {
    throw new Error(`Sign-in failed (${response.status}).`);
  }
  return (await response.json()) as LoginResponse;
}

export async function fetchContests(token: string) {
  const response = await request("/v1/admin/contests", token);
  return ((await response.json()) as { contests: ContestListItem[] }).contests;
}

export async function fetchSummary(token: string, contestId: string) {
  const response = await request(
    `/v1/admin/contests/${encodeURIComponent(contestId)}/summary`,
    token,
  );
  return (await response.json()) as ContestSummary;
}

export async function fetchEvents(
  token: string,
  contestId: string,
  filters: EventFilters,
) {
  const response = await request(
    `/v1/admin/contests/${encodeURIComponent(contestId)}/events${filterQuery(filters)}`,
    token,
  );
  return ((await response.json()) as { events: TimelineEvent[] }).events;
}

export async function downloadCsv(
  token: string,
  contestId: string,
  filters: EventFilters,
): Promise<void> {
  const response = await request(
    `/v1/admin/contests/${encodeURIComponent(contestId)}/export.csv${filterQuery(filters)}`,
    token,
  );
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `exam-guard-${contestId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
