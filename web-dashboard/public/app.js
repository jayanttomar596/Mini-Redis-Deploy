const state = {
  socket: null,
  keys: [],
  sessions: [],
  activity: [],
  filter: "",
  backend: "127.0.0.1:8080",
  clientId: null,
  lastActivityId: null
};

const terminalLog = document.querySelector("#terminalLog");
const commandForm = document.querySelector("#commandForm");
const commandInput = document.querySelector("#commandInput");
const clearTerminal = document.querySelector("#clearTerminal");
const refreshKeys = document.querySelector("#refreshKeys");
const keyList = document.querySelector("#keyList");
const keySearch = document.querySelector("#keySearch");
const connectionDot = document.querySelector("#connectionDot");
const connectionText = document.querySelector("#connectionText");
const latencyText = document.querySelector("#latencyText");
const clientText = document.querySelector("#clientText");
const clientCountText = document.querySelector("#clientCountText");
const backendText = document.querySelector("#backendText");
const bridgeCountText = document.querySelector("#bridgeCountText");
const clientStack = document.querySelector("#clientStack");
const sessionList = document.querySelector("#sessionList");
const activityList = document.querySelector("#activityList");

function appendTerminalLine(kind, label, text) {
  const row = document.createElement("div");
  row.className = `terminal-line ${kind}`;

  const tag = document.createElement("strong");
  tag.textContent = label;

  const body = document.createElement("span");
  body.textContent = text;

  row.append(tag, body);
  terminalLog.append(row);
  terminalLog.scrollTop = terminalLog.scrollHeight;
}

function setStatus(status) {
  connectionDot.classList.toggle("connected", status.connected);
  connectionDot.classList.toggle("disconnected", !status.connected);
  connectionText.textContent = status.connected ? "Connected" : "Disconnected";
  latencyText.textContent = status.latencyMs === null ? "--" : `${status.latencyMs}ms`;
  backendText.textContent = status.backend || "127.0.0.1:8080";
  if (status.sessionId) {
    state.clientId = status.sessionId;
    clientText.textContent = status.sessionId;
  }
}

async function fetchStatus() {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "status" }));
  }
}

function formatTtl(ttl) {
  if (ttl === -1) return "persistent";
  if (ttl === -2) return "expired";
  if (ttl === null || Number.isNaN(ttl)) return "unknown";
  return `${ttl}s`;
}

function renderKeys() {
  const filter = state.filter.toLowerCase();
  const keys = state.keys.filter((item) => item.key.toLowerCase().includes(filter));
  keyList.replaceChildren();

  if (keys.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No observed active keys yet.";
    keyList.append(empty);
    return;
  }

  for (const item of keys) {
    const card = document.createElement("article");
    card.className = "key-card";

    const main = document.createElement("div");
    main.className = "key-main";

    const name = document.createElement("div");
    name.className = "key-name";
    name.textContent = item.key;

    const ttl = document.createElement("div");
    ttl.className = "key-ttl";
    ttl.textContent = formatTtl(item.ttl);

    const value = document.createElement("div");
    value.className = "key-value";
    value.textContent = item.value || "NULL";

    main.append(name, ttl);
    card.append(main, value);
    keyList.append(card);
  }
}

function formatAge(timestamp) {
  if (!timestamp) return "--";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m`;
}

function renderSessions() {
  const sessions = state.sessions;
  clientCountText.textContent = String(sessions.filter((session) => session.connected).length);
  bridgeCountText.textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;

  clientStack.replaceChildren();
  sessionList.replaceChildren();

  if (sessions.length === 0) {
    const emptyNode = document.createElement("div");
    emptyNode.className = "client-node empty";
    emptyNode.textContent = "No tabs";
    clientStack.append(emptyNode);

    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Open this dashboard in another tab to add a client.";
    sessionList.append(empty);
    return;
  }

  for (const session of sessions) {
    const node = document.createElement("div");
    node.className = `client-node ${session.connected ? "online" : "offline"} ${session.id === state.clientId ? "self" : ""}`;
    node.textContent = session.id === state.clientId ? `this tab ${session.id}` : `tab ${session.id}`;
    clientStack.append(node);

    const card = document.createElement("article");
    card.className = `session-card ${session.id === state.clientId ? "self" : ""}`;

    const main = document.createElement("div");
    main.className = "session-main";

    const id = document.createElement("strong");
    id.textContent = session.id === state.clientId ? `${session.id} · this tab` : session.id;

    const badge = document.createElement("span");
    badge.className = session.connected ? "badge online" : "badge offline";
    badge.textContent = session.inFlight > 0 ? "running" : session.connected ? "connected" : "closed";

    main.append(id, badge);

    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.innerHTML = `
      <span>${session.commandCount || 0} commands</span>
      <span>${session.lastLatencyMs === null ? "--" : `${session.lastLatencyMs}ms`}</span>
      <span>${formatAge(session.createdAt)} alive</span>
    `;

    const command = document.createElement("div");
    command.className = "session-command";
    command.textContent = session.lastCommand || "Waiting for first command";

    card.append(main, meta, command);
    sessionList.append(card);
  }
}

function renderActivity() {
  activityList.replaceChildren();

  if (state.activity.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Commands from any dashboard tab will appear here.";
    activityList.append(empty);
    return;
  }

  for (const entry of state.activity) {
    const row = document.createElement("article");
    row.className = `activity-row ${entry.ok ? "ok" : "fail"} ${entry.mutating ? "mutating" : ""}`;

    const time = document.createElement("span");
    time.className = "activity-time";
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    const client = document.createElement("strong");
    client.textContent = entry.sessionId === state.clientId ? `${entry.sessionId} · this tab` : entry.sessionId;

    const command = document.createElement("code");
    command.textContent = entry.command;

    const response = document.createElement("span");
    response.className = "activity-response";
    response.textContent = `${entry.response} · ${entry.latencyMs}ms`;

    row.append(time, client, command, response);
    activityList.append(row);
  }
}

async function fetchKeys() {
  refreshKeys.disabled = true;

  if (state.socket?.readyState !== WebSocket.OPEN) {
    appendTerminalLine("error", "error", "Bridge socket is not open yet.");
    refreshKeys.disabled = false;
    return;
  }

  state.socket.send(JSON.stringify({ type: "keys" }));
}

function connectSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${location.host}/ws`);

  state.socket.addEventListener("open", () => {
    appendTerminalLine("system", "bridge", "WebSocket bridge is open.");
  });

  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "system") {
      appendTerminalLine("system", "bridge", message.message);
      return;
    }

    if (message.type === "status") {
      state.backend = message.backend || state.backend;
      setStatus(message);
      if (message.connected) fetchKeys();
      return;
    }

    if (message.type === "sessions") {
      state.sessions = message.sessions || [];
      renderSessions();
      return;
    }

    if (message.type === "activity") {
      const newest = message.activity?.[0]?.id || null;
      const shouldRefreshKeys = newest && newest !== state.lastActivityId && message.activity[0]?.mutating && message.activity[0]?.sessionId !== state.clientId;
      state.lastActivityId = newest || state.lastActivityId;
      state.activity = message.activity || [];
      renderActivity();
      if (shouldRefreshKeys) fetchKeys();
      return;
    }

    if (message.type === "keys") {
      refreshKeys.disabled = false;
      if (message.error) appendTerminalLine("error", "error", `Key refresh failed: ${message.error}`);
      state.keys = message.keys || [];
      renderKeys();
      return;
    }

    if (message.type === "command") {
      appendTerminalLine("command", "command", message.command);
      return;
    }

    if (message.type === "response") {
      const text = message.ok ? `${message.response} (${message.latencyMs}ms)` : `${message.error} (${message.latencyMs}ms)`;
      appendTerminalLine(message.ok ? "response" : "error", message.ok ? "reply" : "error", text);
      setStatus({
        connected: message.ok,
        latencyMs: message.latencyMs,
        backend: state.backend
      });
      fetchKeys();
      return;
    }

    if (message.type === "error") {
      appendTerminalLine("error", "error", message.error);
    }
  });

  state.socket.addEventListener("close", () => {
    setStatus({ connected: false, latencyMs: null, backend: state.backend });
    state.sessions = state.sessions.map((session) => (
      session.id === state.clientId ? { ...session, connected: false } : session
    ));
    renderSessions();
    appendTerminalLine("error", "bridge", "WebSocket bridge closed. Reconnecting...");
    setTimeout(connectSocket, 1000);
  });
}

function runCommand(command) {
  const clean = command.trim();
  if (!clean) return;

  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ command: clean }));
  } else {
    appendTerminalLine("error", "error", "Bridge socket is not open yet.");
  }
}

commandForm.addEventListener("submit", (event) => {
  event.preventDefault();
  runCommand(commandInput.value);
  commandInput.value = "";
  commandInput.focus();
});

clearTerminal.addEventListener("click", () => {
  terminalLog.replaceChildren();
});

refreshKeys.addEventListener("click", fetchKeys);

keySearch.addEventListener("input", () => {
  state.filter = keySearch.value;
  renderKeys();
});

for (const button of document.querySelectorAll("[data-command]")) {
  button.addEventListener("click", () => {
    commandInput.value = button.dataset.command;
    commandInput.focus();
  });
}

appendTerminalLine("system", "ready", "Type a Mini Redis command and press Run.");
renderSessions();
renderActivity();
connectSocket();
