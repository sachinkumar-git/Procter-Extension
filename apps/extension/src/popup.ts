import type {
  ExtensionRequest,
  ExtensionResponse,
  FocusTarget,
  MonitoringState,
  StatusView,
} from "./types";

const REFRESH_MS = 2000;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing element #${id}`);
  }
  return found as T;
}

const pill = element("state-pill");
const errorBox = element("error");
const form = element<HTMLFormElement>("start-form");
const contestInput = element<HTMLInputElement>("contest-id");
const candidateInput = element<HTMLInputElement>("candidate-id");
const accessInput = element<HTMLInputElement>("access-code");
const pairButton = element<HTMLButtonElement>("pair");
const pairingCode = element("pairing-code");
const acknowledge = element<HTMLInputElement>("acknowledge");
const sessionView = element("session-view");
const attention = element("attention");
const endButton = element<HTMLButtonElement>("end");
const endConfirm = element<HTMLButtonElement>("end-confirm");
const storageLine = element("storage-line");
const uploadLine = element("upload-line");
const recent = element("recent");

const PILL_TEXT: Record<MonitoringState, string> = {
  idle: "Not monitoring",
  active: "Monitoring",
  attention: "Attention",
};

const FOCUS_TEXT: Record<FocusTarget, string> = {
  exam: "Exam window",
  other_chrome_window: "Another Chrome window",
  outside_chrome: "Outside Chrome",
};

function showError(message: string | null): void {
  errorBox.textContent = message ?? "";
  errorBox.hidden = message === null;
}

function showDisconnected(): void {
  pill.dataset.state = "error";
  pill.textContent = "Not monitoring";
  form.hidden = true;
  sessionView.hidden = true;
  showError("The monitor is not responding. Tell your invigilator.");
}

function render(status: StatusView): void {
  pill.dataset.state = status.monitoring;
  pill.textContent = PILL_TEXT[status.monitoring];
  form.hidden = status.session !== null;
  sessionView.hidden = status.session === null;
  attention.hidden = status.monitoring !== "attention";

  if (status.session) {
    element("session-contest").textContent = status.session.contest_id;
    element("session-candidate").textContent = status.session.candidate_id;
    element("session-id").textContent = status.session.session_id;
    element("session-focus").textContent = status.focus
      ? FOCUS_TEXT[status.focus]
      : "Unknown";
    element("session-fullscreen").textContent =
      status.browser_fullscreen === null
        ? "Unknown"
        : status.browser_fullscreen
          ? "Yes"
          : "No";
  } else {
    endButton.hidden = false;
    endConfirm.hidden = true;
  }

  const dropped = status.dropped
    ? ` ${status.dropped} oldest events were discarded (storage limit).`
    : "";
  storageLine.textContent = `${status.queued} events stored on this computer.${dropped}`;
  uploadLine.textContent =
    status.connection === "auth_expired"
      ? "Session credential expired. Tell your invigilator. Events are kept on this computer."
      : status.connection === "offline"
        ? "Cannot reach the exam server. Events are kept and will be sent later."
        : status.upload_error
          ? `Upload failing; will retry: ${status.upload_error}`
          : "";

  recent.replaceChildren(
    ...status.recent.map((event) => {
      const item = document.createElement("li");
      item.textContent = `${new Date(event.occurred_at).toLocaleTimeString()} ${event.type}`;
      return item;
    }),
  );
}

async function send(request: ExtensionRequest): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as
      ExtensionResponse | undefined;
    if (!response) {
      showDisconnected();
    } else if (response.ok) {
      if (request.type !== "status") {
        showError(null);
      }
      render(response.status);
      if (response.pairing_code) {
        pairingCode.textContent = `Enter in the Windows agent: ${response.pairing_code}`;
        pairingCode.hidden = false;
      }
    } else {
      showError(response.error);
    }
  } catch {
    showDisconnected();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void send({
    type: "start",
    contest_id: contestInput.value,
    candidate_id: candidateInput.value,
    access_code: accessInput.value,
    acknowledged: acknowledge.checked,
  });
});

pairButton.addEventListener("click", () => {
  void send({ type: "pairing" });
});

endButton.addEventListener("click", () => {
  endButton.hidden = true;
  endConfirm.hidden = false;
});

endConfirm.addEventListener("click", () => {
  endButton.hidden = false;
  endConfirm.hidden = true;
  void send({ type: "end" });
});

void send({ type: "status" });
setInterval(() => void send({ type: "status" }), REFRESH_MS);
