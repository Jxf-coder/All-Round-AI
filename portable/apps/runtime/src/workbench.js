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

// Whether a click happened inside an element. The composed path is used instead
// of the event target because a handler may rebuild a menu's contents, which
// detaches the clicked node before the document-level listener runs.
function isInside(event, element) {
  return event.composedPath().includes(element);
}

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
// The in-flight reply, if any: { controller, target }. Its presence is what
// turns the send button into a stop button.
let activeStream = null;
const sendButton = $(".send-button");

function setStreaming(on) {
  sendButton.classList.toggle("streaming", on);
  sendButton.textContent = on ? "■" : "↑";
  sendButton.title = on ? "停止生成" : "发送";
  sendButton.setAttribute("aria-label", on ? "停止生成" : "发送消息");
}

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
    response = await apiRequest(`/api/conversations?projectId=${encodeURIComponent(currentProjectId ?? "")}`);
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

// The stored conversation is the source of truth for what is on screen, so the
// view is re-rendered from the API after every turn instead of being assembled
// locally (which would drift from what the server actually kept).
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
  renderReplyActions(document_.messages);
  await loadHistory();
}

// Retry is offered on the last answer only: regenerating an older turn would
// leave the following turns inconsistent with it.
function renderReplyActions(messages) {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || activeStream) return;
  const actions = document.createElement("div");
  actions.className = "message-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "message-action";
  retry.textContent = "重新生成";
  retry.addEventListener("click", () => void regenerateLastReply());
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-action";
  copy.textContent = "复制";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(last.content);
      copy.textContent = "已复制";
      setTimeout(() => { copy.textContent = "复制"; }, 1500);
    } catch {
      copy.textContent = "复制失败";
    }
  });
  actions.append(retry, copy);
  conversation.append(actions);
  conversation.scrollTop = conversation.scrollHeight;
}

async function regenerateLastReply() {
  if (activeStream || !activeConversationId) return;
  activeStream = { controller: new AbortController(), target: appendMessage("assistant-message") };
  setStreaming(true);
  try {
    await streamReply({ conversationId: activeConversationId, retry: true }, activeStream);
  } finally {
    activeStream = null;
    setStreaming(false);
  }
  await openConversation(activeConversationId);
}

async function ensureConversation() {
  if (activeConversationId) return activeConversationId;
  const response = await apiRequest("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ projectId: currentProjectId }),
  });
  if (!response?.ok) return null;
  const { conversation: created } = await response.json();
  activeConversationId = created.id;
  return activeConversationId;
}

function appendMessage(className, text = "") {
  const node = document.createElement("div");
  node.className = `message ${className}`;
  node.textContent = text;
  conversation.append(node);
  conversation.scrollTop = conversation.scrollHeight;
  return node;
}

// ---------------------------------------------------------------------------
// Model picker. The active model is an installation setting read from the
// settings API; changing it is an admin action, so a refusal is surfaced to the
// user instead of being silently swallowed.
// ---------------------------------------------------------------------------
const modelButton = $("#model-button");
const modelLabel = $("#model-label");
const modelMenu = $("#model-menu");
let aiSettings = null;

function renderModel() {
  const active = aiSettings?.models.find((model) => model.id === aiSettings.model);
  modelLabel.textContent = active?.name ?? "选择模型";
  modelButton.title = aiSettings
    ? `当前模型：${active?.name ?? aiSettings.model}（${aiSettings.providerLabel}）`
    : "选择模型";
}

function closeModelMenu() {
  modelMenu.hidden = true;
  modelButton.setAttribute("aria-expanded", "false");
}

async function loadAiSettings() {
  let response;
  try {
    response = await apiRequest("/api/settings/ai");
  } catch {
    return;
  }
  if (!response?.ok) return;
  aiSettings = await response.json();
  renderModel();
}

async function selectModel(id) {
  const response = await apiRequest("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({ model: id }),
  });
  if (!response) return;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const note = modelMenu.querySelector(".model-note");
    if (note) note.textContent = payload.error || "无法保存模型设置";
    return;
  }
  aiSettings = payload;
  renderModel();
  closeModelMenu();
}

function openModelMenu() {
  modelMenu.replaceChildren();
  if (!aiSettings) {
    const note = document.createElement("div");
    note.className = "model-note";
    note.textContent = "模型列表暂时不可用。";
    modelMenu.append(note);
  } else {
    for (const model of aiSettings.models) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "model-option";
      option.setAttribute("role", "option");
      const isActive = model.id === aiSettings.model;
      option.setAttribute("aria-selected", String(isActive));
      option.classList.toggle("active", isActive);
      option.textContent = model.name;
      option.addEventListener("click", () => void selectModel(model.id));
      modelMenu.append(option);
    }
    const note = document.createElement("div");
    note.className = "model-note";
    note.textContent = aiSettings.apiKeyConfigured
      ? "已保存供应商密钥（加密存储，不会回显）。"
      : "尚未配置供应商密钥；当前由本地 Mock 提供回复。";
    modelMenu.append(note);
  }
  modelMenu.hidden = false;
  modelButton.setAttribute("aria-expanded", "true");
}

// ---------------------------------------------------------------------------
// Project switcher. Chat history is scoped by project, so the selected project
// decides which threads the rail lists. The choice is remembered per browser;
// creating a project mirrors the reference tree (公司根项目 → 岗位 → 子岗位).
// ---------------------------------------------------------------------------
const PROJECT_TYPE_LABELS = { root: "公司根项目", child: "岗位", seat: "子岗位" };
const projectButton = $("#project-button");
const projectLabel = $("#project-label");
const projectMenu = $("#project-menu");
const projectContext = $("#project-context");
let projects = [];
let currentProjectId = null;

// The flat list the menu renders: roots first, then their roles indented, then
// each role's seats indented once more.
function flattenProjects(tree) {
  const flat = [];
  for (const node of tree) {
    flat.push({ ...node.root, depth: 0 });
    for (const child of node.children) {
      flat.push({ ...child, depth: 1 });
      for (const seat of child.seats) flat.push({ ...seat, depth: 2 });
    }
  }
  return flat;
}

function projectNameOf(id) {
  return projects.find((project) => project.id === id)?.name ?? "默认项目";
}

function renderProjectLabel() {
  const name = projectNameOf(currentProjectId);
  projectLabel.textContent = name;
  projectContext.textContent = name;
  projectButton.title = `当前项目：${name}`;
}

function closeProjectMenu() {
  projectMenu.hidden = true;
  projectButton.setAttribute("aria-expanded", "false");
}

async function loadProjects() {
  let response;
  try {
    response = await apiRequest("/api/projects");
  } catch {
    return;
  }
  if (!response?.ok) return;
  const payload = await response.json();
  projects = flattenProjects(payload.tree);
  const remembered = storage.get("projectId");
  currentProjectId = projects.some((project) => project.id === remembered)
    ? remembered
    : payload.defaultProjectId ?? projects[0]?.id ?? null;
  renderProjectLabel();
}

function buildProjectForm() {
  projectMenu.replaceChildren();
  const form = document.createElement("form");
  form.className = "project-form";
  const name = document.createElement("input");
  name.className = "project-form-field";
  name.placeholder = "名称";
  name.setAttribute("aria-label", "项目名称");
  name.required = true;

  const type = document.createElement("select");
  type.className = "project-form-field";
  type.setAttribute("aria-label", "项目类型");
  for (const [value, label] of [["child", "岗位"], ["seat", "子岗位"], ["root", "公司根项目"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    type.append(option);
  }
  const parent = document.createElement("select");
  parent.className = "project-form-field";
  parent.setAttribute("aria-label", "所属上级");

  // A role hangs off a company root, a seat off a role; a new root has no parent.
  function refreshParents() {
    const wanted = type.value === "child" ? "root" : "child";
    const candidates = projects.filter((project) => project.type === wanted);
    parent.replaceChildren();
    for (const candidate of candidates) {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent = `所属${PROJECT_TYPE_LABELS[wanted]}：${candidate.name}`;
      parent.append(option);
    }
    parent.hidden = type.value === "root";
  }
  refreshParents();
  type.addEventListener("change", refreshParents);

  const actions = document.createElement("div");
  actions.className = "project-form-actions";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary-button";
  submit.textContent = "创建";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "quiet-button";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => openProjectMenu());
  actions.append(submit, cancel);

  const error = document.createElement("p");
  error.className = "project-form-error";
  error.hidden = true;

  form.append(name, type, parent, actions, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = "创建中…";
    const response = await apiRequest("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: name.value,
        type: type.value,
        parentId: type.value === "root" ? undefined : parent.value,
      }),
    });
    submit.disabled = false;
    submit.textContent = "创建";
    const payload = await response?.json().catch(() => ({}));
    if (!response?.ok) {
      error.hidden = false;
      error.textContent = payload?.error || "创建项目失败";
      return;
    }
    await loadProjects();
    await selectProject(payload.project.id);
  });
  projectMenu.append(form);
  name.focus();
}

function openProjectMenu() {
  projectMenu.replaceChildren();
  for (const project of projects) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "project-option";
    option.setAttribute("role", "option");
    option.style.paddingLeft = `${10 + project.depth * 14}px`;
    const isActive = project.id === currentProjectId;
    option.classList.toggle("active", isActive);
    option.setAttribute("aria-selected", String(isActive));
    const name = document.createElement("span");
    name.className = "project-option-name";
    name.textContent = project.name;
    const kind = document.createElement("span");
    kind.className = "project-option-kind";
    kind.textContent = PROJECT_TYPE_LABELS[project.type] ?? "";
    option.append(name, kind);
    option.addEventListener("click", () => void selectProject(project.id));
    projectMenu.append(option);
  }
  const create = document.createElement("button");
  create.type = "button";
  create.className = "project-option project-create";
  create.textContent = "＋ 新建项目";
  create.addEventListener("click", buildProjectForm);
  projectMenu.append(create);
  projectMenu.hidden = false;
  projectButton.setAttribute("aria-expanded", "true");
}

async function selectProject(id) {
  closeProjectMenu();
  if (id === currentProjectId) return;
  currentProjectId = id;
  storage.set("projectId", id);
  renderProjectLabel();
  // The open thread belongs to the previous project, so the view is reset and
  // the rail is re-read for the new scope.
  activeConversationId = null;
  conversation.replaceChildren();
  welcome.classList.remove("hidden");
  await loadHistory();
}

// Consumes the /api/ai/chat/stream SSE endpoint. The server owns the exchange
// (it appends the question, replays context and stores the answer), so this
// only renders deltas and reports how the turn ended.
async function streamReply(payload, stream) {
  let response;
  try {
    response = await fetch("/api/ai/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: stream.controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") return "cancelled";
    stream.target.textContent = "无法连接本地 AI 服务，请确认运行时仍在运行。";
    return "failed";
  }
  if (response.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
    return "failed";
  }
  if (!response.ok || !response.body) {
    const failure = await response.json().catch(() => ({}));
    stream.target.textContent = failure.error || "AI 服务暂时不可用，请稍后重试。";
    return "failed";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let outcome = "done";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const line = event.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      let chunk;
      try { chunk = JSON.parse(line.slice(6)); } catch { continue; }
      if (chunk.delta) { answer += chunk.delta; stream.target.textContent = answer; }
      if (chunk.error) { stream.target.textContent = chunk.error; outcome = "failed"; }
      if (chunk.done && chunk.cancelled) outcome = "cancelled";
      conversation.scrollTop = conversation.scrollHeight;
    }
  }
  if (outcome === "done" && !answer) {
    stream.target.textContent = "AI 服务未返回内容。";
    outcome = "failed";
  }
  return outcome;
}

// Guards against a double submit: Enter plus a click, or two fast presses, can
// both reach the handler before the first one has created its conversation.
let submitInFlight = false;

async function submitMessage(event) {
  event?.preventDefault();
  if (submitInFlight || activeStream) return;
  const text = prompt.value.trim();
  if (!text) return;
  submitInFlight = true;
  try {
    const id = await ensureConversation();
    if (!id) return;
    welcome.classList.add("hidden");
    appendMessage("", text);
    activeStream = { controller: new AbortController(), target: appendMessage("assistant-message") };
    setStreaming(true);
    prompt.value = "";
    prompt.dispatchEvent(new Event("input"));
    try {
      await streamReply({ conversationId: id, content: text }, activeStream);
    } finally {
      activeStream = null;
      setStreaming(false);
    }
    // Re-render from storage so a cancelled or failed turn still shows exactly
    // what the server kept.
    await openConversation(id);
  } finally {
    submitInFlight = false;
  }
}

$("#composer-form").addEventListener("submit", submitMessage);
// While a reply streams the same button stops it; preventDefault keeps the
// click from also submitting the composer.
sendButton.addEventListener("click", (event) => {
  if (!activeStream) return;
  event.preventDefault();
  activeStream.controller.abort();
});
prompt.addEventListener("input", () => {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 150)}px`;
  $(".send-button").classList.toggle("ready", Boolean(prompt.value.trim()));
});
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submitMessage(event); }
});
modelButton.addEventListener("click", () => {
  if (modelMenu.hidden) openModelMenu();
  else closeModelMenu();
});
projectButton.addEventListener("click", () => {
  if (projectMenu.hidden) openProjectMenu();
  else closeProjectMenu();
});
document.addEventListener("click", (event) => {
  if (modelMenu.hidden) return;
  if (isInside(event, modelMenu) || isInside(event, modelButton)) return;
  closeModelMenu();
});
document.addEventListener("click", (event) => {
  if (projectMenu.hidden) return;
  if (isInside(event, projectMenu) || isInside(event, projectButton)) return;
  closeProjectMenu();
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
  if (event.key === "Escape") { searchModal.hidden = true; drawer.classList.remove("open"); rail.classList.remove("mobile-open"); closeModelMenu(); closeProjectMenu(); }
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

// The project scope has to be known before the rail is read, so bootstrapping
// resolves the project first and then loads the history and model in parallel.
async function bootstrap() {
  await loadProjects();
  await Promise.all([loadHistory(), loadAiSettings()]);
}
void bootstrap();
