const $ = (selector) => document.querySelector(selector);
const rail = $("#rail");
const prompt = $("#prompt");
const conversation = $("#conversation");
const welcome = $("#welcome");
const drawer = $("#agent-drawer");
const historyList = $("#history-list");
const storage = {
  get(key, fallback = "") { try { return localStorage.getItem(`allround.${key}`) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`allround.${key}`, value); } catch { /* browser storage can be disabled */ } },
};
const savedTheme = storage.get("theme");
if (savedTheme === "dark" || (savedTheme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches)) {
  document.documentElement.classList.add("dark");
}
if (storage.get("rail") === "collapsed") rail.classList.add("collapsed");

function startConversation(initialText = "") {
  // Starting from a suggestion, the drawer or the rail begins a new thread
  // rather than appending to the currently open one.
  activeConversationId = null;
  if (initialText) prompt.value = initialText;
  prompt.focus();
  if (matchMedia("(max-width: 640px)").matches) rail.classList.remove("mobile-open");
  drawer.classList.remove("open");
}

// ---------------------------------------------------------------------------
// Conversation history. The rail list is backed by the runtime's conversation
// API so history survives a reload; the document is scoped to the signed-in
// account server-side.
// ---------------------------------------------------------------------------
let activeConversationId = null;

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  if (response.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
    return null;
  }
  return response;
}

async function loadHistory() {
  let response;
  try {
    response = await apiRequest("/api/conversations");
  } catch {
    return;
  }
  if (!response?.ok) return;
  const { conversations } = await response.json();
  renderHistory(conversations);
}

function renderHistory(conversations) {
  historyList.replaceChildren();
  if (!conversations.length) {
    const empty = document.createElement("div");
    empty.className = "empty-history";
    empty.textContent = "新对话会显示在这里";
    historyList.append(empty);
    return;
  }
  for (const item of conversations) {
    const row = document.createElement("div");
    row.className = "history-row";
    const entry = document.createElement("button");
    entry.className = "history-entry";
    entry.textContent = item.title;
    entry.title = item.title;
    entry.classList.toggle("active", item.id === activeConversationId);
    entry.addEventListener("click", () => void openConversation(item.id));
    const remove = document.createElement("button");
    remove.className = "history-delete";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "删除该对话";
    remove.setAttribute("aria-label", `删除对话：${item.title}`);
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      const response = await apiRequest(`/api/conversations/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      if (!response) return;
      await response.json().catch(() => null);
      if (!response.ok) return;
      if (item.id === activeConversationId) {
        activeConversationId = null;
        conversation.replaceChildren();
        welcome.classList.remove("hidden");
      }
      await loadHistory();
    });
    row.append(entry, remove);
    historyList.append(row);
  }
}

async function openConversation(id) {
  const response = await apiRequest(`/api/conversations/${encodeURIComponent(id)}`);
  if (!response?.ok) return;
  const { conversation: document_ } = await response.json();
  activeConversationId = document_.id;
  conversation.replaceChildren();
  welcome.classList.add("hidden");
  for (const message of document_.messages) {
    appendMessage(message.role === "user" ? "" : "assistant-message", message.content);
  }
  await loadHistory();
}

async function ensureConversation() {
  if (activeConversationId) return activeConversationId;
  const response = await apiRequest("/api/conversations", { method: "POST", body: "{}" });
  if (!response?.ok) return null;
  const { conversation: created } = await response.json();
  activeConversationId = created.id;
  return activeConversationId;
}

async function saveMessage(role, content) {
  const id = await ensureConversation();
  if (!id) return false;
  const response = await apiRequest(`/api/conversations/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ role, content }),
  });
  if (!response) return false;
  // The body is drained even though only the status matters, so the request is
  // never left half-read (which browsers report as an aborted request).
  await response.json().catch(() => null);
  return response.ok;
}

function appendMessage(className, text = "") {
  const node = document.createElement("div");
  node.className = `message ${className}`;
  node.textContent = text;
  conversation.append(node);
  conversation.scrollTop = conversation.scrollHeight;
  return node;
}

// Consumes the /api/ai/chat/stream SSE endpoint and renders deltas as they
// arrive. Falls back to a plain notice when no provider is reachable, so the
// prototype never shows a broken conversation.
async function requestReply(text, target) {
  let response;
  try {
    response = await fetch("/api/ai/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
    });
  } catch {
    target.textContent = "无法连接本地 AI 服务，请确认运行时仍在运行。";
    return null;
  }
  if (response.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
    return null;
  }
  if (!response.ok || !response.body) {
    target.textContent = "AI 服务暂时不可用，请稍后重试。";
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const line = event.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      let payload;
      try { payload = JSON.parse(line.slice(6)); } catch { continue; }
      if (payload.delta) { answer += payload.delta; target.textContent = answer; }
      if (payload.error) { target.textContent = payload.error; return null; }
      conversation.scrollTop = conversation.scrollHeight;
    }
  }
  if (!answer) target.textContent = "AI 服务未返回内容。";
  return answer || null;
}

async function submitMessage(event) {
  event?.preventDefault();
  const text = prompt.value.trim();
  if (!text) return;
  welcome.classList.add("hidden");
  appendMessage("", text);
  const reply = appendMessage("assistant-message");
  reply.dataset.pending = "true";
  prompt.value = "";
  prompt.dispatchEvent(new Event("input"));
  await saveMessage("user", text);
  const answer = await requestReply(text, reply);
  delete reply.dataset.pending;
  if (answer) await saveMessage("assistant", answer);
  await loadHistory();
}

$("#composer-form").addEventListener("submit", submitMessage);
prompt.addEventListener("input", () => {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 150)}px`;
  $(".send-button").classList.toggle("ready", Boolean(prompt.value.trim()));
});
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitMessage(event); }
});
document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => startConversation(button.dataset.prompt)));
$("#new-agent").addEventListener("click", () => { conversation.replaceChildren(); welcome.classList.remove("hidden"); startConversation(); });
$("#drawer-start").addEventListener("click", () => startConversation());
$("#agent-toggle").addEventListener("click", () => drawer.classList.toggle("open"));
$("#drawer-close").addEventListener("click", () => drawer.classList.remove("open"));
$("#rail-toggle").addEventListener("click", () => {
  rail.classList.toggle("collapsed");
  storage.set("rail", rail.classList.contains("collapsed") ? "collapsed" : "expanded");
});
$("#theme-toggle").addEventListener("click", () => {
  document.documentElement.classList.toggle("dark");
  storage.set("theme", document.documentElement.classList.contains("dark") ? "dark" : "light");
});
$(".mobile-menu").addEventListener("click", () => rail.classList.toggle("mobile-open"));

const searchModal = $("#search-modal");
function openSearch() { searchModal.hidden = false; $("#search-input").focus(); }
$("#search-open").addEventListener("click", openSearch);
$("#mobile-search").addEventListener("click", openSearch);
searchModal.addEventListener("click", (event) => { if (event.target === searchModal) searchModal.hidden = true; });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
  if (event.key === "Escape") { searchModal.hidden = true; drawer.classList.remove("open"); rail.classList.remove("mobile-open"); }
});
$("#search-input").addEventListener("input", (event) => {
  $(".search-empty").textContent = event.target.value.trim() ? "原型阶段尚未连接 Skill、知识与任务索引。" : "输入关键词开始搜索";
});
$("#history-more").addEventListener("click", () => void loadHistory());
document.querySelectorAll(".rail-item").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".rail-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  const label = button.querySelector(".rail-label").textContent;
  const panel = button.dataset.panel;
  $("#current-section").textContent = label;
  if (panel === "agent") { welcome.classList.remove("hidden"); conversation.replaceChildren(); activeConversationId = null; }
  else {
    welcome.classList.add("hidden");
    conversation.replaceChildren();
    const notice = document.createElement("div");
    notice.className = "message assistant-message";
    notice.textContent = `${label}工作区的完整功能正在按阶段迁移；此原型先验证工作台导航和视觉框架。`;
    conversation.append(notice);
  }
  if (matchMedia("(max-width: 640px)").matches) rail.classList.remove("mobile-open");
}));
document.querySelectorAll(".top-tab").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".top-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  const isOps = button.dataset.mode === "ops";
  $("#current-section").textContent = isOps ? "经营台" : "Agent";
  welcome.classList.toggle("hidden", isOps);
  conversation.replaceChildren();
  activeConversationId = null;
  if (isOps) {
    const notice = document.createElement("div");
    notice.className = "message assistant-message";
    notice.textContent = "经营台界面正在按阶段迁移；当前可核验顶栏模式切换与界面框架。";
    conversation.append(notice);
  }
}));

// History is loaded from the runtime so the rail reflects persisted threads.
void loadHistory();
