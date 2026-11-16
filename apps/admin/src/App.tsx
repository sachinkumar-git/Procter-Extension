import type {
  ContestListItem,
  ContestSummary,
  TimelineEvent,
} from "@exam-guard/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  downloadCsv,
  fetchContests,
  fetchEvents,
  fetchSummary,
  login,
  UnauthorizedError,
  type EventFilters,
} from "./api";
import { FilterBar, SummaryView, TimelineView } from "./views";

const REFRESH_MS =
  Number(import.meta.env.VITE_REFRESH_INTERVAL_SECONDS ?? 10) * 1000;
const STORAGE_KEY = "exam-guard-admin";

interface Auth {
  token: string;
  role: "admin" | "viewer";
}

function loadAuth(): Auth | null {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as Auth;
  } catch {
    return null;
  }
}

function saveAuth(auth: Auth | null): void {
  try {
    if (auth) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Without storage, the session simply lasts until the page reloads.
  }
}

function Login({ onLogin }: { onLogin: (auth: Auth) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await login(username, password);
      onLogin({ token: result.token, role: result.role });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The server could not be reached.",
      );
    }
  }

  return (
    <form className="login" onSubmit={(event) => void submit(event)}>
      <label>
        Username
        <input
          value={username}
          autoComplete="username"
          required
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          autoComplete="current-password"
          required
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  );
}

function Dashboard({ auth, onExpired }: { auth: Auth; onExpired: () => void }) {
  const [contests, setContests] = useState<ContestListItem[]>([]);
  const [contestId, setContestId] = useState("");
  const [summary, setSummary] = useState<ContestSummary | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [filters, setFilters] = useState<EventFilters>({});
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);

  const handleFailure = useCallback(
    (failure: unknown) => {
      if (failure instanceof UnauthorizedError) {
        onExpired();
      } else {
        setError(
          failure instanceof Error ? failure.message : "Request failed.",
        );
      }
    },
    [onExpired],
  );

  useEffect(() => {
    fetchContests(auth.token)
      .then((list) => {
        setContests(list);
        setContestId((current) => current || (list[0]?.id ?? ""));
      })
      .catch(handleFailure);
  }, [auth.token, handleFailure]);

  useEffect(() => {
    if (!contestId) {
      return;
    }
    let active = true;
    const refresh = () => {
      Promise.all([
        fetchSummary(auth.token, contestId),
        fetchEvents(auth.token, contestId, filters),
      ])
        .then(([nextSummary, nextEvents]) => {
          if (active) {
            setSummary(nextSummary);
            setEvents(nextEvents);
            setUpdated(new Date());
            setError(null);
          }
        })
        .catch(handleFailure);
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [auth.token, contestId, filters, handleFailure]);

  return (
    <>
      <div className="toolbar">
        <label>
          Contest
          <select
            value={contestId}
            onChange={(e) => setContestId(e.target.value)}
          >
            {contests.map((contest) => (
              <option key={contest.id} value={contest.id}>
                {contest.name} ({contest.status})
              </option>
            ))}
          </select>
        </label>
        {updated && (
          <span className="muted">
            Updated {updated.toLocaleTimeString()}; refreshes every{" "}
            {REFRESH_MS / 1000} seconds
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {contests.length === 0 && <p className="note">No contests exist yet.</p>}
      {summary && (
        <SummaryView
          summary={summary}
          onSelect={(candidate) =>
            setFilters({ ...filters, candidate_id: candidate })
          }
        />
      )}
      {contestId && (
        <section>
          <div className="toolbar">
            <h2>Activity timeline</h2>
            {auth.role === "admin" && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void downloadCsv(auth.token, contestId, filters).catch(
                    handleFailure,
                  )
                }
              >
                Export CSV
              </button>
            )}
          </div>
          <FilterBar filters={filters} onChange={setFilters} />
          <TimelineView events={events} />
        </section>
      )}
    </>
  );
}

export function App() {
  const [auth, setAuth] = useState<Auth | null>(loadAuth);

  const update = useCallback((next: Auth | null) => {
    saveAuth(next);
    setAuth(next);
  }, []);
  const expire = useCallback(() => update(null), [update]);

  return (
    <main>
      <header>
        <div>
          <p className="brand">CodeWallah</p>
          <h1>CodeWallah Exam Guard</h1>
        </div>
        {auth && (
          <button type="button" className="secondary" onClick={expire}>
            Sign out
          </button>
        )}
      </header>
      {auth ? (
        <Dashboard auth={auth} onExpired={expire} />
      ) : (
        <Login onLogin={update} />
      )}
    </main>
  );
}
