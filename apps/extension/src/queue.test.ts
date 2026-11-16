import type { ExamEvent } from "@exam-guard/shared";
import { describe, expect, it, vi } from "vitest";
import { MAX_QUEUED_EVENTS, RETRY_BASE_MS, UPLOAD_BATCH_SIZE } from "./config";
import { EventQueue } from "./queue";
import { makeEvent, MemoryStore } from "./test-helpers";
import type { SendResult } from "./transport";

function setup(send: (events: ExamEvent[]) => Promise<SendResult>) {
  const clock = { ms: 1_000_000 };
  const store = new MemoryStore();
  const sendMock = vi.fn(send);
  const queue = new EventQueue(
    store,
    { send: sendMock },
    () => clock.ms,
    () => 1,
  );
  return { clock, queue, send: sendMock, store };
}

describe("EventQueue", () => {
  it("removes events after successful delivery, in order and in batches", async () => {
    const { queue, send } = setup(() => Promise.resolve({ ok: true }));
    const total = UPLOAD_BATCH_SIZE + 1;
    for (let i = 0; i < total; i++) {
      await queue.add(makeEvent(`e${i}`));
    }

    await queue.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toHaveLength(UPLOAD_BATCH_SIZE);
    expect(send.mock.calls[0]?.[0][0]?.event_id).toBe("e0");
    expect((await queue.read()).events).toEqual([]);
  });

  it("keeps events and backs off after a failure, retrying with the same IDs", async () => {
    const { clock, queue, send } = setup(() =>
      Promise.resolve({ ok: false, error: "offline" }),
    );
    await queue.add(makeEvent("e1"));

    await queue.flush();
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);

    const state = await queue.read();
    expect(state.events.map((event) => event.event_id)).toEqual(["e1"]);
    expect(state.last_error).toBe("offline");
    expect(state.next_attempt_ms).toBe(clock.ms + RETRY_BASE_MS);

    clock.ms = state.next_attempt_ms;
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0][0]?.event_id).toBe("e1");
    expect((await queue.read()).attempts).toBe(2);
  });

  it("treats a thrown transport error as a retryable failure", async () => {
    const { queue } = setup(() => Promise.reject(new Error("network down")));
    await queue.add(makeEvent("e1"));

    await queue.flush();

    const state = await queue.read();
    expect(state.events).toHaveLength(1);
    expect(state.last_error).toBe("network down");
  });

  it("resets backoff once delivery recovers", async () => {
    const results: SendResult[] = [
      { ok: false, error: "offline" },
      { ok: true },
    ];
    const { clock, queue } = setup(() => Promise.resolve(results.shift()!));
    await queue.add(makeEvent("e1"));
    await queue.flush();
    clock.ms = (await queue.read()).next_attempt_ms;

    await queue.flush();

    const state = await queue.read();
    expect(state.events).toEqual([]);
    expect(state.attempts).toBe(0);
    expect(state.last_error).toBeNull();
  });

  it("survives a restart because state lives in the store", async () => {
    const { queue, store } = setup(() => Promise.resolve({ ok: true }));
    await queue.add(makeEvent("e1"));

    const restarted = new EventQueue(
      store,
      { send: () => Promise.resolve({ ok: true }) },
      () => 0,
      () => 0,
    );

    expect((await restarted.read()).events).toHaveLength(1);
  });

  it("sends each session's events in separate batches", async () => {
    const { queue, send } = setup(() => Promise.resolve({ ok: true }));
    await queue.add({ ...makeEvent("a"), session_id: "one" });
    await queue.add({ ...makeEvent("b"), session_id: "two" });
    await queue.add({ ...makeEvent("c"), session_id: "one" });

    await queue.flush();

    expect(
      send.mock.calls.map(([batch]) => batch.map((e) => e.event_id)),
    ).toEqual([["a", "c"], ["b"]]);
  });

  it("discards undeliverable events, counts them, and continues", async () => {
    const results: SendResult[] = [
      { ok: false, error: "expired", undeliverable: true },
      { ok: true },
    ];
    const { queue, send } = setup(() => Promise.resolve(results.shift()!));
    await queue.add({ ...makeEvent("old"), session_id: "one" });
    await queue.add({ ...makeEvent("new"), session_id: "two" });

    await queue.flush();

    expect(send).toHaveBeenCalledTimes(2);
    const state = await queue.read();
    expect(state.events).toEqual([]);
    expect(state.dropped).toBe(1);
  });

  it("discards the oldest events at the limit and counts them", async () => {
    const { queue, store } = setup(() => Promise.resolve({ ok: true }));
    await store.set("queue_state", {
      events: Array.from({ length: MAX_QUEUED_EVENTS }, (_, i) =>
        makeEvent(`e${i}`),
      ),
      dropped: 0,
      attempts: 0,
      next_attempt_ms: 0,
      last_error: null,
      last_delivered_at: null,
    });

    await queue.add(makeEvent("newest"));

    const state = await queue.read();
    expect(state.events).toHaveLength(MAX_QUEUED_EVENTS);
    expect(state.events[0]?.event_id).toBe("e1");
    expect(state.events.at(-1)?.event_id).toBe("newest");
    expect(state.dropped).toBe(1);
  });
});
