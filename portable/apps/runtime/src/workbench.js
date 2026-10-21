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
  ensureAgentView();
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
// The in-flight reply, if any: { controller, target, conversationId, turnId }.
// Its presence is what turns the send button into a stop button.
let activeStream = null;
const sendButton = $(".send-button");

// A per-send id so a retried request is answered from the turn it already
// started instead of producing a second reply.
function newClientTurnId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function setStreaming(on) {
  sendButton.classList.toggle("streaming", on);
  sendButton.textContent = on ? "■" : "↑";
  sendButton.title = on ? "停止生成" : "发送";
  sendButton.setAttribute("aria-label", on ? "停止生成" : "发送消息");
}

// Stopping is a server-side cancel, not a socket close: the runtime keeps the
// partial answer and marks the turn cancelled. Aborting the fetch is only a
// fallback for when the cancel request itself cannot be delivered.
async function cancelActiveTurn() {
  const stream = activeStream;
  if (!stream) return;
  const payload = { conversationId: stream.conversationId };
  if (stream.turnId) payload.turnId = stream.turnId;
  try {
    const response = await fetch("/api/ai/chat/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) stream.controller.abort();
  } catch {
    stream.controller.abort();
  }
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
  ensureAgentView();
  const response = await apiRequest(`/api/conversations/${encodeURIComponent(id)}`);
  if (!response?.ok) return;
  const { conversation: document_ } = await response.json();
  activeConversationId = document_.id;
  conversation.replaceChildren();
  welcome.classList.add("hidden");
  for (const message of document_.messages) {
    const bubble = appendMessage(message.role === "user" ? "" : "assistant-message", message.content);
    if (message.role === "assistant") renderCitations(bubble, message.citations);
  }
  renderReplyActions(document_.messages);
  // Offer the panel this conversation was last viewed in, without hiding the
  // reply the user just opened.
  renderPageContextHint(document_.pageContext);
  await loadHistory();
  // A reply can still be running on the server after a refresh or a reopen;
  // reattach to its live stream so the answer keeps appearing.
  await reattachLiveTurn(document_.id);
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
  activeStream = {
    controller: new AbortController(),
    target: appendMessage("assistant-message"),
    conversationId: activeConversationId,
    turnId: null,
  };
  setStreaming(true);
  resolvedEffort = null;
  startLiveHint();
  try {
    await streamReply(
      { conversationId: activeConversationId, retry: true, clientTurnId: newClientTurnId(), ...turnOptions() },
      activeStream,
    );
  } finally {
    activeStream = null;
    setStreaming(false);
    stopLiveHint();
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

// Answer provenance: the knowledge cards the runtime actually injected. Kept
// next to the bubble instead of inside it so copy actions never include it.
function renderCitations(bubble, citations) {
  if (!bubble || !Array.isArray(citations) || citations.length === 0) return;
  const text = `引用：${[...new Set(citations.map((citation) => citation.title))].join("、")}`;
  const sibling = bubble.nextElementSibling;
  if (sibling?.classList?.contains("message-citations")) {
    sibling.textContent = text;
    return;
  }
  const node = document.createElement("div");
  node.className = "message-citations";
  node.textContent = text;
  bubble.after(node);
}

// ---------------------------------------------------------------------------
// Composer pickers. The model list is an installation setting read from the
// settings API (changing it is an admin action), while thinking effort and Fast
// mode are per-turn choices remembered for this browser. Both pickers share one
// menu element, so opening either replaces the other.
// ---------------------------------------------------------------------------
const modelButton = $("#model-button");
const modelLabel = $("#model-label");
const engineButton = $("#engine-button");
const engineLabel = $("#engine-label");
const effortButton = $("#effort-button");
const effortLabel = $("#effort-label");
const fastToggle = $("#fast-toggle");
const modelMenu = $("#model-menu");
let aiSettings = null;
let efforts = [];
let engines = [];
let menuMode = "model";
// Empty engine means "use the installation default"; the runtime reports which
// engine it actually used in the reply's meta event.
let engineChoice = storage.get("engine") || "";
let defaultEngine = "";
let resolvedEngine = null;
// "auto" leaves the level to the runtime, which reports the level it picked in
// the reply's meta event; an explicit level always wins.
let effortChoice = storage.get("effort") || "auto";
let fastMode = storage.get("fast") === "1";
let resolvedEffort = null;

function effortZh(id) {
  return efforts.find((item) => item.id === id)?.zh ?? id;
}

function effortDisplay() {
  if (effortChoice !== "auto") return effortZh(effortChoice);
  return resolvedEffort ? `自动（${effortZh(resolvedEffort)}）` : "自动";
}

function modelName() {
  return aiSettings?.models.find((model) => model.id === aiSettings.model)?.name ?? "选择模型";
}

function engineName() {
  const id = engineChoice || resolvedEngine || defaultEngine;
  return engines.find((engine) => engine.id === id)?.label ?? id ?? "引擎";
}

function renderModel() {
  modelLabel.textContent = [modelName(), effortDisplay(), fastMode ? "Fast" : null].filter(Boolean).join(" · ");
  modelButton.title = aiSettings
    ? `当前模型：${modelName()}（${aiSettings.providerLabel}）`
    : "选择模型";
  engineLabel.textContent = engineName();
  engineButton.title = `当前引擎：${engineName()}`;
  effortLabel.textContent = effortDisplay();
  effortButton.title = `思考强度：${effortDisplay()}${fastMode ? " · Fast" : ""}`;
  fastToggle.classList.toggle("active", fastMode);
  fastToggle.setAttribute("aria-pressed", String(fastMode));
}

function closeModelMenu() {
  modelMenu.hidden = true;
  modelButton.setAttribute("aria-expanded", "false");
  engineButton.setAttribute("aria-expanded", "false");
  effortButton.setAttribute("aria-expanded", "false");
}

async function loadAiSettings() {
  let settingsResponse;
  let modelsResponse;
  try {
    // Effort levels ship with the model list so they are defined in one place.
    [settingsResponse, modelsResponse] = await Promise.all([
      apiRequest("/api/settings/ai"),
      apiRequest("/api/ai/models"),
    ]);
  } catch {
    return;
  }
  if (settingsResponse?.ok) aiSettings = await settingsResponse.json();
  if (modelsResponse?.ok) {
    const payload = await modelsResponse.json();
    efforts = payload.efforts ?? [];
    engines = payload.engines ?? [];
    defaultEngine = payload.provider ?? "";
  }
  // A remembered engine that no longer exists falls back to the default instead
  // of sending an unknown id on every turn.
  if (engineChoice && !engines.some((engine) => engine.id === engineChoice)) {
    engineChoice = "";
    storage.set("engine", "");
  }
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

function selectEngine(id) {
  // Storing the default as "" keeps "follow the installation default" working
  // if the default ever changes.
  engineChoice = id === defaultEngine ? "" : id;
  resolvedEngine = null;
  storage.set("engine", engineChoice);
  renderModel();
  closeModelMenu();
}

function selectEffort(id) {
  effortChoice = id;
  resolvedEffort = null;
  storage.set("effort", id);
  renderModel();
  closeModelMenu();
}

function toggleFast() {
  fastMode = !fastMode;
  storage.set("fast", fastMode ? "1" : "0");
  renderModel();
}

// Sent with every turn: an omitted effort means "let the runtime decide", and
// an omitted engine means "use the installation default".
function turnOptions() {
  return {
    ...(effortChoice === "auto" ? {} : { effort: effortChoice }),
    fast: fastMode,
    ...(engineChoice ? { engine: engineChoice } : {}),
  };
}

function menuOption(label, note, isActive, onSelect) {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "model-option";
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", String(isActive));
  option.classList.toggle("active", isActive);
  option.textContent = note ? `${label} · ${note}` : label;
  option.addEventListener("click", onSelect);
  return option;
}

function openModelMenu() {
  menuMode = "model";
  modelMenu.replaceChildren();
  if (!aiSettings) {
    const note = document.createElement("div");
    note.className = "model-note";
    note.textContent = "模型列表暂时不可用。";
    modelMenu.append(note);
  } else {
    for (const model of aiSettings.models) {
      modelMenu.append(menuOption(model.name, "", model.id === aiSettings.model, () => void selectModel(model.id)));
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

function openEngineMenu() {
  menuMode = "engine";
  modelMenu.replaceChildren();
  const active = engineChoice || resolvedEngine || defaultEngine;
  if (!engines.length) {
    const note = document.createElement("div");
    note.className = "model-note";
    note.textContent = "引擎列表暂时不可用。";
    modelMenu.append(note);
  } else {
    for (const engine of engines) {
      modelMenu.append(menuOption(
        engine.label,
        engine.id === defaultEngine ? "默认" : "",
        engine.id === active,
        () => selectEngine(engine.id),
      ));
    }
  }
  modelMenu.hidden = false;
  engineButton.setAttribute("aria-expanded", "true");
}

function openEffortMenu() {
  menuMode = "effort";
  modelMenu.replaceChildren();
  modelMenu.append(menuOption("自动", "按问题选择", effortChoice === "auto", () => selectEffort("auto")));
  for (const effort of efforts) {
    modelMenu.append(menuOption(effort.zh, effort.hint, effort.id === effortChoice, () => selectEffort(effort.id)));
  }
  modelMenu.hidden = false;
  effortButton.setAttribute("aria-expanded", "true");
}

// ---------------------------------------------------------------------------
// Live hint. While a reply is being produced the composer shows what the
// runtime is doing plus how long the user has waited, with a rotating companion
// line once the wait stops feeling instant.
// ---------------------------------------------------------------------------
const liveHint = $("#live-hint");
const liveHintText = $("#live-hint-text");
const WAIT_HINTS = ["正在思考…", "正在组织语言…", "正在把要点排好…", "内容不少，再等一小会儿…"];
const LONG_WAIT_HINTS = ["还在生成，可以继续等或点停止…", "这次生成时间较长，不需要可以停止。"];
let liveHintTimer = null;
let liveHintBase = "正在准备…";
let liveHintStartedAt = 0;

function renderLiveHint() {
  const seconds = Math.round((Date.now() - liveHintStartedAt) / 1000);
  liveHintText.textContent = `${liveHintBase}（${seconds}s）`;
}

function startLiveHint(base = "正在准备…") {
  if (liveHintTimer) clearInterval(liveHintTimer);
  liveHintBase = base;
  liveHintStartedAt = Date.now();
  liveHint.hidden = false;
  renderLiveHint();
  liveHintTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - liveHintStartedAt) / 1000);
    if (seconds >= 20) liveHintBase = LONG_WAIT_HINTS[Math.floor(seconds / 8) % LONG_WAIT_HINTS.length];
    else if (seconds >= 7) liveHintBase = WAIT_HINTS[Math.floor(seconds / 6) % WAIT_HINTS.length];
    renderLiveHint();
  }, 1000);
}

function setLiveStage(text) {
  if (typeof text !== "string" || !text) return;
  liveHintBase = text;
  renderLiveHint();
}

function stopLiveHint() {
  if (liveHintTimer) clearInterval(liveHintTimer);
  liveHintTimer = null;
  liveHint.hidden = true;
  liveHintText.textContent = "";
}

// The runtime reports the level it actually used, so "自动" can show what it
// resolved to instead of staying opaque.
function applyTurnMeta(meta) {
  if (!meta) return;
  if (meta.effort) resolvedEffort = meta.effort;
  if (meta.engine) resolvedEngine = meta.engine;
  renderModel();
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
  // Whatever is on screen belongs to the previous project: the open thread is
  // dropped and the rail is re-read, and an open panel is re-read in place
  // rather than left showing the old project's content.
  if (activePanel === "agent") {
    activeConversationId = null;
    conversation.replaceChildren();
    welcome.classList.remove("hidden");
    await loadHistory();
    return;
  }
  if (activePanel === "database") await refreshKnowledge();
}

// ---------------------------------------------------------------------------
// Agent memory (人格 SOUL.md / 长期记忆 MEMORY.md). The two documents live on the
// server per project and are replayed into every chat turn, so what is saved
// here actually changes how the assistant replies.
// ---------------------------------------------------------------------------
const memoryModal = $("#memory-modal");
const memoryTitle = $("#memory-title");
const memoryEditor = $("#memory-editor");
const memoryHint = $("#memory-hint");
const memoryStatus = $("#memory-status");
const memorySave = $("#memory-save");
const memoryPendingList = $("#memory-pending");
const memorySoulButton = $("#memory-generate-soul");
const memoryDistillButton = $("#memory-distill");
const MEMORY_HINTS = {
  soul: "人格：说明这个 Agent 是谁、为谁服务，以及职责、风格与禁忌。",
  memory: "长期记忆：跨会话有效的事实、决策与偏好写在这里。",
};
const MEMORY_PLACEHOLDERS = {
  soul: "例：你是内容策划 Agent，为电商团队服务。回答简洁可执行，先给结论再给理由；不确定时直说。",
  memory: "例：主推产品是折叠彩虹琴；短视频统一 9:16、30 秒以内；回答用中文。",
};
let memoryTab = "soul";
let memoryDraft = { soul: "", memory: "" };
let memoryPending = [];
let memoryWorking = false;

function applyMemoryState(payload) {
  memoryDraft = {
    soul: payload?.soul ?? memoryDraft.soul,
    memory: payload?.memory ?? memoryDraft.memory,
  };
  memoryPending = Array.isArray(payload?.pending) ? payload.pending : memoryPending;
}

function renderMemoryPending() {
  const visible = memoryTab === "memory";
  memoryPendingList.hidden = !visible;
  memoryPendingList.replaceChildren();
  if (!visible) return;
  if (memoryPending.length === 0) {
    memoryPendingList.append(element("p", "memory-pending-empty", "暂无待确认条目。对话提炼后会出现在这里。"));
    return;
  }
  for (const item of memoryPending) {
    const row = element("div", "memory-pending-item");
    row.append(element("p", "memory-pending-kind", `[${item.kind}]`));
    row.append(element("p", "memory-pending-text", item.text));
    const actions = element("div", "memory-pending-actions");
    const confirm = element("button", "confirm", "采纳");
    confirm.type = "button";
    confirm.disabled = memoryWorking;
    confirm.addEventListener("click", () => void actOnPending("confirm", item));
    const discard = element("button", "discard", "丢弃");
    discard.type = "button";
    discard.disabled = memoryWorking;
    discard.addEventListener("click", () => void actOnPending("discard", item));
    actions.append(confirm, discard);
    row.append(actions);
    memoryPendingList.append(row);
  }
}

function renderMemory() {
  memoryEditor.value = memoryDraft[memoryTab] ?? "";
  memoryEditor.placeholder = MEMORY_PLACEHOLDERS[memoryTab];
  memoryHint.textContent = MEMORY_HINTS[memoryTab];
  for (const tab of document.querySelectorAll(".memory-tab")) {
    const active = tab.dataset.memoryTab === memoryTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  memorySoulButton.hidden = memoryTab !== "soul";
  memoryDistillButton.hidden = memoryTab !== "memory";
  memorySoulButton.disabled = memoryWorking;
  memoryDistillButton.disabled = memoryWorking || !activeConversationId;
  renderMemoryPending();
}

async function openMemory() {
  memoryModal.hidden = false;
  memoryTitle.textContent = `人格与记忆 · ${projectNameOf(currentProjectId)}`;
  memoryTab = "soul";
  memoryDraft = { soul: "", memory: "" };
  memoryPending = [];
  memoryStatus.textContent = "加载中…";
  renderMemory();
  const response = await apiRequest(`/api/memory?projectId=${encodeURIComponent(currentProjectId ?? "")}`);
  if (!response?.ok) {
    memoryStatus.textContent = "无法读取记忆";
    return;
  }
  const payload = await response.json();
  applyMemoryState(payload);
  memoryStatus.textContent = payload.updatedAt
    ? `上次保存：${new Date(payload.updatedAt).toLocaleString()}`
    : "";
  renderMemory();
}

function closeMemory() {
  memoryModal.hidden = true;
}

async function saveMemory() {
  memorySave.disabled = true;
  memorySave.textContent = "保存中…";
  try {
    const response = await apiRequest("/api/memory", {
      method: "POST",
      body: JSON.stringify({ projectId: currentProjectId, soul: memoryDraft.soul, memory: memoryDraft.memory }),
    });
    const payload = await response?.json().catch(() => ({}));
    if (!response?.ok) {
      memoryStatus.textContent = payload?.error || "保存失败";
      return;
    }
    applyMemoryState(payload);
    memoryStatus.textContent = `已保存 ${new Date(payload.updatedAt).toLocaleString()}`;
    renderMemory();
  } finally {
    memorySave.disabled = false;
    memorySave.textContent = "保存";
  }
}

// Candidates distilled from a conversation are accepted or dropped one by one;
// nothing reaches MEMORY.md before 采纳.
async function actOnPending(action, item) {
  if (memoryWorking) return;
  memoryWorking = true;
  memoryStatus.textContent = action === "confirm" ? "正在采纳…" : "正在丢弃…";
  renderMemory();
  try {
    const response = await apiRequest("/api/memory/pending", {
      method: "POST",
      body: JSON.stringify({ projectId: currentProjectId, action, id: item.id }),
    });
    const payload = await response?.json().catch(() => ({}));
    if (!response?.ok) {
      memoryStatus.textContent = payload?.error || "操作失败";
      return;
    }
    applyMemoryState(payload);
    memoryStatus.textContent = action === "confirm" ? "已采纳到长期记忆" : "已丢弃";
  } finally {
    memoryWorking = false;
    renderMemory();
  }
}

async function generateSoulDraft() {
  if (memoryWorking) return;
  memoryWorking = true;
  memoryStatus.textContent = "正在生成人格初稿…";
  renderMemory();
  try {
    const response = await apiRequest("/api/memory/soul-draft", {
      method: "POST",
      body: JSON.stringify({ projectId: currentProjectId }),
    });
    const payload = await response?.json().catch(() => ({}));
    if (!response?.ok) {
      memoryStatus.textContent = payload?.error || "生成失败";
      return;
    }
    memoryDraft.soul = payload.draft ?? memoryDraft.soul;
    memoryTab = "soul";
    memoryStatus.textContent = "初稿已放入编辑框，保存后才会生效";
  } finally {
    memoryWorking = false;
    renderMemory();
  }
}

async function distillCurrentConversation() {
  if (memoryWorking) return;
  if (!activeConversationId) {
    memoryStatus.textContent = "先打开一个对话再提炼";
    return;
  }
  memoryWorking = true;
  memoryStatus.textContent = "正在提炼当前会话…";
  renderMemory();
  try {
    const response = await apiRequest("/api/memory/distill", {
      method: "POST",
      body: JSON.stringify({ projectId: currentProjectId, conversationId: activeConversationId }),
    });
    const payload = await response?.json().catch(() => ({}));
    if (!response?.ok) {
      memoryStatus.textContent = payload?.error || "提炼失败";
      return;
    }
    applyMemoryState(payload);
    memoryStatus.textContent = payload.added > 0
      ? `已加入 ${payload.added} 条待确认`
      : "没有新的可提炼条目";
  } finally {
    memoryWorking = false;
    renderMemory();
  }
}

// ---------------------------------------------------------------------------
// Knowledge panel (rail → 知识库). Knowledge cards are proposed first and only
// become model context once confirmed, so the list keeps the two states apart;
// the gap list records what the assistant could not answer.
// ---------------------------------------------------------------------------
const panelView = $("#panel-view");
const panelTitle = $("#panel-title");
const panelCopy = $("#panel-copy");
const panelBody = $("#panel-body");
const composer = $("#composer-form");
const CARD_KIND_LABELS = { fact: "事实", decision: "决策", preference: "偏好", faq: "问答", method: "方法" };
const CARD_STATUS_LABELS = { pending: "待确认", confirmed: "已确认", dropped: "已丢弃" };

function element(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

function actionButton(label, onClick) {
  const button = element("button", "knowledge-action", label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function knowledgeStats(stats) {
  const row = element("div", "knowledge-stats");
  for (const [label, value] of [
    ["知识卡", stats.cards],
    ["待确认", stats.pending],
    ["已确认", stats.confirmed],
    ["缺口（未关闭）", stats.gapsOpen],
    ["已关闭", stats.gapsClosed],
  ]) {
    const cell = element("div", "knowledge-stat");
    cell.append(element("b", null, String(value)), element("span", null, label));
    row.append(cell);
  }
  return row;
}

function cardNode(card, onChanged) {
  const node = element("article", "knowledge-card");
  const head = element("div", "knowledge-card-head");
  head.append(
    element("span", `knowledge-kind kind-${card.kind}`, CARD_KIND_LABELS[card.kind] ?? card.kind),
    element("span", "knowledge-card-title", card.title),
    element("span", `knowledge-status status-${card.status}`, CARD_STATUS_LABELS[card.status] ?? card.status),
  );
  node.append(head, element("p", "knowledge-card-body", card.body));
  const actions = element("div", "knowledge-card-actions");
  const send = (action, extra = {}) => async () => {
    await knowledgeAction({ action, id: card.id, ...extra });
    await onChanged();
  };
  if (card.status !== "confirmed") actions.append(actionButton("确认采纳", () => void send("cardStatus", { status: "confirmed" })()));
  if (card.status !== "pending") actions.append(actionButton("改回待确认", () => void send("cardStatus", { status: "pending" })()));
  if (card.status !== "dropped") actions.append(actionButton("丢弃", () => void send("cardStatus", { status: "dropped" })()));
  actions.append(actionButton("删除", () => void send("cardRemove")()));
  node.append(actions);
  return node;
}

function gapNode(gap, onChanged) {
  const node = element("article", "knowledge-card");
  const head = element("div", "knowledge-card-head");
  head.append(
    element("span", `knowledge-status gap-${gap.status}`, gap.status === "open" ? "未关闭" : "已关闭"),
    element("span", "knowledge-card-title", gap.question),
  );
  node.append(head);
  if (gap.note) node.append(element("p", "knowledge-card-body", gap.note));
  const actions = element("div", "knowledge-card-actions");
  const send = (action) => async () => {
    await knowledgeAction({ action, id: gap.id });
    await onChanged();
  };
  actions.append(actionButton(gap.status === "open" ? "关闭缺口" : "重新打开",
    () => void send(gap.status === "open" ? "gapClose" : "gapReopen")()));
  node.append(actions);
  return node;
}

// A new card is a proposal, which is why the form offers the kind but not the
// status: confirming is a separate, deliberate step.
function cardForm(onDone, onCancel) {
  const form = element("form", "knowledge-form");
  const kind = element("select", "knowledge-field");
  kind.setAttribute("aria-label", "知识卡类型");
  for (const [value, label] of Object.entries(CARD_KIND_LABELS)) {
    const option = element("option", null, label);
    option.value = value;
    kind.append(option);
  }
  const title = element("input", "knowledge-field");
  title.placeholder = "标题，例如：主推产品";
  title.setAttribute("aria-label", "知识卡标题");
  const body = element("textarea", "knowledge-field");
  body.placeholder = "内容，例如：主推产品是折叠彩虹琴。";
  body.setAttribute("aria-label", "知识卡内容");
  const error = element("p", "knowledge-error");
  error.hidden = true;
  const actions = element("div", "knowledge-form-actions");
  const submit = element("button", "primary-button", "创建");
  submit.type = "submit";
  const cancel = element("button", "quiet-button", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", onCancel);
  actions.append(submit, cancel);
  form.append(kind, title, body, actions, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const failure = await knowledgeAction({ action: "card", kind: kind.value, title: title.value, body: body.value });
    if (failure) {
      error.hidden = false;
      error.textContent = failure;
      return;
    }
    await onDone();
  });
  return form;
}

function gapForm(onDone, onCancel) {
  const form = element("form", "knowledge-form");
  const question = element("input", "knowledge-field");
  question.placeholder = "没能回答的问题，例如：优惠券和会员价能否叠加？";
  question.setAttribute("aria-label", "缺口问题");
  const note = element("input", "knowledge-field");
  note.placeholder = "备注（可选）";
  note.setAttribute("aria-label", "缺口备注");
  const error = element("p", "knowledge-error");
  error.hidden = true;
  const actions = element("div", "knowledge-form-actions");
  const submit = element("button", "primary-button", "添加");
  submit.type = "submit";
  const cancel = element("button", "quiet-button", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", onCancel);
  actions.append(submit, cancel);
  form.append(question, note, actions, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const failure = await knowledgeAction({ action: "gapAdd", question: question.value, note: note.value });
    if (failure) {
      error.hidden = false;
      error.textContent = failure;
      return;
    }
    await onDone();
  });
  return form;
}

let knowledgeState = null;
// Desk devices: the list is readable by any signed-in account; tickets and
// revocation are admin actions and surface the server's 403 in the panel.
let deviceState = null;
let deviceTicket = null;
// One inline probe at a time: which device the operator opened, the absolute
// path they typed, and the last command outcome.
let deviceProbe = null;
let handoverState = null;
let intakeEditing = false;
let intakeNotice = "";
// The report of one scout run, kept outside knowledgeState because the list
// endpoint deliberately returns summaries only.
let scoutReport = null;
let scoutNotice = "";
let scoutError = "";

// Same order and short labels as the reference knowledge panel:范围与边界在前，
// 营销 Plan 的细节在后。`wide` fields also span both columns.
const INTAKE_FIELDS = [
  ["product", "主打产品"],
  ["customer", "主要客户"],
  ["platform", "主要平台"],
  ["materialsWhere", "资料在哪", true],
  ["nas", "NAS 型号"],
  ["devOs", "执行电脑系统"],
  ["forbidden", "禁入内容", true, true],
  ["externalOk", "可对外的内容", true],
  ["redLines", "红线", true, true],
  ["questions", "客户最常问的 10 个问题", true, true],
  ["versioning", "版本怎么管"],
  ["hours", "每周能投入"],
  ["positioning", "一句话定位"],
  ["sellingPoints", "核心卖点与证明", true],
  ["contentThemes", "选题方向", true],
  ["knowledgeNeeds", "知识库必须有的事实", true],
];

async function knowledgeAction(payload) {
  const response = await apiRequest("/api/knowledge", {
    method: "POST",
    body: JSON.stringify({ projectId: currentProjectId, ...payload }),
  });
  if (!response) return "请先登录";
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return body.error || "操作失败";
  knowledgeState = body;
  return null;
}

function renderIntakeBlock() {
  const block = element("section", "knowledge-block intake-block");
  const head = element("div", "knowledge-block-head");
  head.append(element("h3", null, "开工前问答"));
  const intake = knowledgeState?.intake ?? null;
  if (!intakeEditing) {
    const toggle = element("button", "quiet-button", intake ? "修改" : "现在填写");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      intakeEditing = true;
      intakeNotice = "";
      renderKnowledgeBody();
    });
    head.append(toggle);
  }
  const body = element("div", "knowledge-list");
  if (intakeEditing) {
    body.append(intakeForm(intake?.fields ?? {}));
  } else if (intake) {
    const grid = element("div", "intake-readonly");
    for (const [key, label] of INTAKE_FIELDS) {
      const item = element("div", "intake-item");
      item.append(element("span", "intake-label", label));
      item.append(element("span", "intake-value", intake.fields[key] || "—"));
      grid.append(item);
    }
    const confirmed = element("div", "intake-item");
    confirmed.append(element("span", "intake-label", "老板已确认"));
    confirmed.append(element("span", "intake-value", intake.fields.bossConfirmed ? "是" : "否"));
    grid.append(confirmed);
    body.append(grid);
    body.append(element("p", "panel-note",
      `填写于 ${new Date(intake.at).toLocaleString()}`
      + (intake.by ? ` · ${intake.by}` : "")
      + "；保存后自动更新 4 张标准卡，客户常问问题并入回归题。"));
  } else {
    body.append(element("p", "knowledge-empty",
      "先用 16 个问题定下知识库的范围、禁入、红线和沉淀标准。保存后自动生成 4 张标准卡，客户常问的问题进回归题。"));
  }
  if (intakeNotice) body.append(element("p", "intake-notice", intakeNotice));
  block.append(head, body);
  return block;
}

function intakeForm(fields) {
  const form = element("form", "intake-grid");
  for (const [key, label, multiline, wide] of INTAKE_FIELDS) {
    const wrap = element("label", `intake-field${wide ? " wide" : ""}`);
    wrap.append(element("span", "intake-label", label));
    const input = document.createElement(multiline ? "textarea" : "input");
    input.className = "knowledge-field";
    input.name = key;
    input.value = fields[key] ?? "";
    if (key === "questions") input.placeholder = "一行一个，10 个左右";
    wrap.append(input);
    form.append(wrap);
  }
  const check = element("label", "intake-check");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.name = "bossConfirmed";
  box.checked = fields.bossConfirmed === true;
  check.append(box, document.createTextNode("老板已确认（勾选后四张标准卡直接记为已确认）"));
  form.append(check);

  const error = element("p", "knowledge-error wide");
  error.hidden = true;
  const actions = element("div", "knowledge-form-actions wide");
  const submit = element("button", "primary-button", "保存");
  submit.type = "submit";
  const cancel = element("button", "quiet-button", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    intakeEditing = false;
    intakeNotice = "";
    renderKnowledgeBody();
  });
  actions.append(submit, cancel);
  form.append(actions, error);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {};
    for (const [key] of INTAKE_FIELDS) {
      values[key] = form.elements.namedItem(key)?.value ?? "";
    }
    values.bossConfirmed = form.elements.namedItem("bossConfirmed")?.checked === true;
    submit.disabled = true;
    const failure = await knowledgeAction({ action: "intake", fields: values });
    if (failure) {
      submit.disabled = false;
      error.hidden = false;
      error.textContent = failure;
      return;
    }
    intakeEditing = false;
    intakeNotice = "开工前问答已保存，四张标准卡与回归题已更新。";
    await refreshKnowledge();
  });
  return form;
}

function renderSourcesBlock() {
  const sources = knowledgeState?.sources ?? { roots: [], canEdit: false };
  const block = element("section", "knowledge-block sources-block");
  const head = element("div", "knowledge-block-head");
  head.append(element("h3", null, "来源配置"));
  const status = element("p", "knowledge-error");
  status.hidden = true;
  const area = document.createElement("textarea");
  area.className = "knowledge-field source-roots";
  area.value = sources.roots.join("\n");
  area.placeholder = "一行一个绝对路径，例如：\n/mnt/nas/产品资料\nD:\\资料\\产品";
  area.setAttribute("aria-label", "可巡读目录");
  area.disabled = sources.canEdit !== true;
  if (sources.canEdit) {
    const save = element("button", "primary-button", "保存来源");
    save.type = "button";
    save.addEventListener("click", () => void saveSources(area, status));
    head.append(save);
  }
  const body = element("div", "knowledge-list");
  body.append(area);
  body.append(element("p", "panel-note", sources.canEdit
    ? "一行一个绝对路径；巡读只能读这些目录之内，不会修改源文件。"
    : "只有管理员可以修改来源目录。"));
  if (sources.updatedAt) {
    body.append(element("p", "panel-note",
      `上次修改 ${new Date(sources.updatedAt).toLocaleString()}`
      + (sources.updatedBy ? ` · ${sources.updatedBy}` : "")));
  }
  block.append(head, status, body);
  return block;
}

async function saveSources(area, statusNode) {
  statusNode.hidden = true;
  const roots = area.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  try {
    const response = await apiRequest("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({ action: "sourcesSave", projectId: currentProjectId, roots }),
    });
    if (!response) return;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      statusNode.hidden = false;
      statusNode.textContent = body.error || "保存失败";
      return;
    }
    knowledgeState = body;
    renderKnowledgeBody();
  } catch {
    statusNode.hidden = false;
    statusNode.textContent = "保存失败，请稍后重试";
  }
}

function scoutField(label, control, wide = false) {
  const wrap = element("label", `scout-field${wide ? " wide" : ""}`);
  wrap.append(element("span", "intake-label", label), control);
  return wrap;
}

function renderScoutBlock() {
  const sources = knowledgeState?.sources ?? { roots: [] };
  const scouts = knowledgeState?.scouts ?? [];
  const block = element("section", "knowledge-block scout-block");
  const head = element("div", "knowledge-block-head");
  head.append(element("h3", null, "巡读"));
  head.append(element("span", "panel-note", "只读扫描 · 规则筛选"));

  const form = element("form", "scout-form");
  const rootInput = document.createElement("input");
  rootInput.className = "knowledge-field";
  rootInput.name = "scout-root";
  rootInput.value = sources.roots[0] ?? "";
  rootInput.placeholder = "绝对路径，例如 /mnt/nas/产品资料";
  const goalInput = document.createElement("input");
  goalInput.className = "knowledge-field";
  goalInput.name = "scout-goal";
  goalInput.placeholder = "这次要找什么，例如：产品参数、客户常问问题；合同、工资不要";
  const labelInput = document.createElement("input");
  labelInput.className = "knowledge-field";
  labelInput.name = "scout-label";
  labelInput.placeholder = "标签，如 产品资料";
  const submit = element("button", "primary-button", "开始巡读");
  submit.type = "submit";
  const status = element("p", "knowledge-error wide");
  status.hidden = true;
  const actions = element("div", "knowledge-form-actions wide");
  actions.append(submit);
  form.append(
    scoutField("目录（来源配置里的白名单）", rootInput, true),
    scoutField("目标", goalInput, true),
    scoutField("标签", labelInput),
    actions,
    status,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.hidden = true;
    submit.disabled = true;
    try {
      const response = await apiRequest("/api/knowledge", {
        method: "POST",
        body: JSON.stringify({
          action: "scoutRun",
          projectId: currentProjectId,
          root: rootInput.value,
          goal: goalInput.value,
          label: labelInput.value,
        }),
      });
      if (!response) return;
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        submit.disabled = false;
        status.hidden = false;
        status.textContent = body.error || "巡读失败";
        return;
      }
      scoutReport = { id: body.run.id, text: body.report };
      await refreshKnowledge();
    } catch {
      submit.disabled = false;
      status.hidden = false;
      status.textContent = "巡读失败，请稍后重试";
    }
  });

  const list = element("div", "knowledge-list scout-runs");
  if (!scouts.length) {
    list.append(element("p", "knowledge-empty", "还没有巡读记录。配置来源目录后，从上面发起一次只读扫描。"));
  }
  for (const run of scouts.slice(0, 5)) {
    const row = element("div", "scout-run");
    row.append(element("span", "scout-title", run.label));
    row.append(element("span", "scout-meta",
      `${new Date(run.createdAt).toLocaleString()} · 扫 ${run.counts.files} · 留 ${run.counts.keep} · 筛 ${run.counts.rule}`
      + (run.distill ? ` · 提炼 ${run.distill.cards} 张` : "")));
    if (!run.distill && run.kept?.length) {
      const distill = actionButton("提炼候选", () => void distillScoutRun(run.id, distill));
      row.append(distill);
    }
    const open = actionButton(scoutReport?.id === run.id ? "收起报告" : "报告",
      () => void openScoutReport(run.id));
    row.append(open);
    list.append(row);
    if (scoutReport?.id === run.id) {
      const details = document.createElement("details");
      details.className = "scout-report-box";
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = "巡读报告";
      const pre = element("pre", "scout-report", scoutReport.text);
      details.append(summary, pre);
      list.append(details);
    }
  }
  if (scoutNotice) list.append(element("p", "intake-notice", scoutNotice));
  if (scoutError) list.append(element("p", "knowledge-error", scoutError));
  block.append(head, form, list);
  return block;
}

async function distillScoutRun(runId, button) {
  button.disabled = true;
  button.textContent = "提炼中…";
  scoutNotice = "";
  scoutError = "";
  try {
    const response = await apiRequest("/api/knowledge", {
      method: "POST",
      body: JSON.stringify({
        action: "scoutDistill",
        projectId: currentProjectId,
        runId,
      }),
    });
    if (!response) return;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      button.disabled = false;
      button.textContent = "提炼候选";
      scoutError = body.error || "提炼失败";
      renderKnowledgeBody();
      return;
    }
    const summary = body.summary;
    scoutNotice = `提炼完成：新增 ${summary.cards} 张待确认卡，合并 ${summary.merged}，`
      + `丢弃未核对 ${summary.dropped}，跳过 ${summary.skipped.length}，出错 ${summary.errors.length}。`
      + (summary.errors[0] ? `（${summary.errors[0].message}）` : "");
    scoutReport = null;
    await refreshKnowledge();
  } catch {
    button.disabled = false;
    button.textContent = "提炼候选";
    scoutError = "提炼失败，请稍后重试";
    renderKnowledgeBody();
  }
}

async function openScoutReport(id) {
  if (scoutReport?.id === id) {
    scoutReport = null;
    renderKnowledgeBody();
    return;
  }
  try {
    const response = await apiRequest(
      `/api/knowledge?projectId=${encodeURIComponent(currentProjectId ?? "")}&scout=${encodeURIComponent(id)}`,
    );
    if (!response?.ok) return;
    const body = await response.json();
    scoutReport = { id, text: body.run?.report ?? "" };
    renderKnowledgeBody();
  } catch {
    /* the run list already explains failures; a report read is best-effort */
  }
}

function deviceTime(value) {
  if (!value) return "从未上报";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

async function refreshDevices() {
  try {
    const response = await apiRequest("/api/devices");
    if (!response?.ok) {
      deviceState = { devices: [], error: "设备列表暂时不可用。" };
    } else {
      deviceState = await response.json();
    }
  } catch {
    deviceState = { devices: [], error: "连不上运行时，稍后再试。" };
  }
  renderDeviceBody();
}

function deviceCard(device) {
  const card = element("div", "device-card");
  const head = element("div", "device-card-head");
  head.append(element("b", null, device.name));
  head.append(element(
    "span",
    `device-badge${device.online ? " online" : ""}`,
    device.online ? "在线" : "离线",
  ));
  card.append(head);
  card.append(element(
    "p",
    "device-meta",
    `${device.platform || "未知平台"} · ${device.version || "未上报版本"} · 最近心跳 ${deviceTime(device.lastSeenAt)}`,
  ));
  const capabilities = Array.isArray(device.capabilities) && device.capabilities.length
    ? device.capabilities.join("、")
    : "未声明能力";
  card.append(element("p", "device-meta", `能力：${capabilities} · 配对于 ${deviceTime(device.pairedAt)}`));
  const actions = element("div", "device-actions");
  const remove = actionButton("移除", async () => {
    remove.disabled = true;
    try {
      const response = await apiRequest(`/api/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      if (!response?.ok) {
        const body = await response?.json().catch(() => null);
        deviceState = { ...(deviceState ?? { devices: [] }), error: body?.error || "移除失败。" };
        renderDeviceBody();
        return;
      }
      await refreshDevices();
    } catch {
      deviceState = { ...(deviceState ?? { devices: [] }), error: "移除失败，稍后再试。" };
      renderDeviceBody();
    } finally {
      remove.disabled = false;
    }
  });
  actions.append(remove);
  const browse = actionButton("本机文件", () => {
    deviceProbe = deviceProbe?.deviceId === device.id
      ? null
      : { deviceId: device.id, path: "", busy: false, result: null, error: null };
    renderDeviceBody();
  });
  if (!device.online) {
    browse.disabled = true;
    browse.title = "设备离线时无法执行命令";
  }
  actions.append(browse);
  card.append(actions);
  if (deviceProbe?.deviceId === device.id) card.append(deviceProbeBlock(device));
  return card;
}

async function runDeviceCommand(device, type) {
  if (!deviceProbe) return;
  const target = deviceProbe.path.trim();
  if (!target) {
    deviceProbe = { ...deviceProbe, error: "请先填写设备上的绝对路径。", result: null };
    renderDeviceBody();
    return;
  }
  deviceProbe = { ...deviceProbe, busy: true, error: null, result: null };
  renderDeviceBody();
  try {
    const response = await apiRequest(
      `/api/devices/${encodeURIComponent(device.id)}/commands`,
      { method: "POST", body: JSON.stringify({ type, path: target }) },
    );
    const body = await response?.json().catch(() => null);
    deviceProbe = response?.ok
      ? { ...deviceProbe, busy: false, result: { type, value: body?.result ?? null } }
      : { ...deviceProbe, busy: false, error: body?.error || "设备没有响应。" };
  } catch {
    deviceProbe = { ...deviceProbe, busy: false, error: "连不上运行时，稍后再试。" };
  }
  renderDeviceBody();
}

function deviceProbeBlock(device) {
  const block = element("div", "device-probe");
  const input = element("input", "device-probe-input");
  input.type = "text";
  input.placeholder = "设备上的绝对路径，例如 /Users/me/project 或 D:\\project";
  input.value = deviceProbe.path;
  input.addEventListener("input", () => {
    deviceProbe = { ...deviceProbe, path: input.value };
  });
  block.append(input);

  const actions = element("div", "device-actions");
  const list = actionButton("列出目录", () => void runDeviceCommand(device, "files.list"));
  const read = actionButton("读取文件", () => void runDeviceCommand(device, "files.read"));
  if (deviceProbe.busy) {
    list.disabled = true;
    read.disabled = true;
  }
  actions.append(list, read);
  block.append(actions);

  block.append(element(
    "p",
    "panel-note",
    "只读取配对时 --root 指定的目录；越界路径、二进制与超过 256 KB 的文件会被设备拒绝。",
  ));
  if (deviceProbe.busy) block.append(element("p", "panel-note", "已发给设备，等待响应（最多 20 秒）…"));
  if (deviceProbe.error) block.append(element("p", "device-error", deviceProbe.error));

  const result = deviceProbe.result;
  if (result?.type === "files.list") {
    const items = Array.isArray(result.value?.entries) ? result.value.entries : [];
    block.append(element(
      "p",
      "device-meta",
      `${result.value?.path || ""}${result.value?.truncated ? "（条目过多，已截断）" : ""}`,
    ));
    const listNode = element("ul", "device-files");
    if (!items.length) listNode.append(element("li", null, "空目录"));
    for (const entry of items) {
      const item = element(
        "li",
        entry.type === "directory" ? "directory" : null,
        `${entry.type === "directory" ? "▸" : "·"} ${entry.name}`,
      );
      listNode.append(item);
    }
    block.append(listNode);
  } else if (result?.type === "files.read") {
    block.append(element(
      "p",
      "device-meta",
      `${result.value?.path || ""} · ${result.value?.size ?? 0} 字节`,
    ));
    const pre = element("pre", "device-file-text");
    pre.textContent = result.value?.text ?? "";
    block.append(pre);
  }
  return block;
}

function renderDeviceBody() {
  panelBody.replaceChildren();

  const pairBlock = element("section", "device-block");
  const pairHead = element("div", "device-block-head");
  pairHead.append(element("h3", null, "配对票据"));
  const issue = actionButton("生成配对票据", async () => {
    issue.disabled = true;
    try {
      const response = await apiRequest("/api/devices/tickets", { method: "POST", body: "{}" });
      const body = await response?.json().catch(() => null);
      deviceTicket = response?.ok ? body : { error: body?.error || "生成失败。" };
      renderDeviceBody();
    } catch {
      deviceTicket = { error: "生成失败，稍后再试。" };
      renderDeviceBody();
    } finally {
      issue.disabled = false;
    }
  });
  issue.classList.add("primary-button");
  pairHead.append(issue);
  pairBlock.append(pairHead);
  pairBlock.append(element(
    "p",
    "panel-note",
    "在 desk 设备上执行 npm run desk -- pair --server <本地址> --ticket <票据> --name <设备名> --root <允许目录>，再用 npm run desk -- run 常驻。票据十分钟内有效，且只能使用一次。",
  ));
  if (deviceTicket?.ticket) {
    const box = element("div", "device-ticket");
    box.textContent = deviceTicket.ticket;
    box.append(element("small", null, `有效期至 ${deviceTime(deviceTicket.expiresAt)}`));
    pairBlock.append(box);
  } else if (deviceTicket?.error) {
    pairBlock.append(element("p", "device-error", deviceTicket.error));
  }
  panelBody.append(pairBlock);

  const listBlock = element("section", "device-block");
  const listHead = element("div", "device-block-head");
  listHead.append(element("h3", null, "已配对设备"));
  listHead.append(actionButton("刷新", () => void refreshDevices()));
  listBlock.append(listHead);

  if (deviceState?.error) listBlock.append(element("p", "device-error", deviceState.error));
  const list = element("div", "device-list");
  const devices = deviceState?.devices ?? [];
  if (!deviceState) {
    list.append(element("p", "knowledge-empty", "正在读取设备…"));
  } else if (!devices.length) {
    list.append(element("p", "knowledge-empty", "还没有配对设备。生成票据后，在 desk 上执行 pair 命令。"));
  }
  for (const device of devices) list.append(deviceCard(device));
  listBlock.append(list);
  panelBody.append(listBlock);
}

function renderKnowledgeBody() {
  panelBody.replaceChildren();
  if (!knowledgeState) {
    panelBody.append(element("p", "panel-note", "知识库暂时不可用。"));
    return;
  }
  panelBody.append(knowledgeStats(knowledgeState.stats));
  panelBody.append(renderIntakeBlock());
  panelBody.append(renderSourcesBlock());
  panelBody.append(renderScoutBlock());

  const columns = element("div", "knowledge-columns");

  const cardBlock = element("section", "knowledge-block");
  const cardHead = element("div", "knowledge-block-head");
  cardHead.append(element("h3", null, "知识卡"));
  const cardList = element("div", "knowledge-list");
  const addCard = element("button", "quiet-button", "＋ 新建知识卡");
  addCard.type = "button";
  addCard.addEventListener("click", () => {
    cardHead.hidden = true;
    const form = cardForm(refreshKnowledge, () => { cardHead.hidden = false; form.remove(); });
    cardList.prepend(form);
    form.querySelector("input").focus();
  });
  cardHead.append(addCard);
  if (!knowledgeState.cards.length) {
    cardList.append(element("p", "knowledge-empty", "还没有知识卡。确认过的卡片会在提问时按关键词带进上下文。"));
  }
  for (const card of knowledgeState.cards) cardList.append(cardNode(card, refreshKnowledge));
  cardBlock.append(cardHead, cardList);

  const gapBlock = element("section", "knowledge-block");
  const gapHead = element("div", "knowledge-block-head");
  gapHead.append(element("h3", null, "缺口清单"));
  const gapList = element("div", "knowledge-list");
  const addGap = element("button", "quiet-button", "＋ 新建缺口");
  addGap.type = "button";
  addGap.addEventListener("click", () => {
    gapHead.hidden = true;
    const form = gapForm(refreshKnowledge, () => { gapHead.hidden = false; form.remove(); });
    gapList.prepend(form);
    form.querySelector("input").focus();
  });
  gapHead.append(addGap);
  if (!knowledgeState.gaps.length) {
    gapList.append(element("p", "knowledge-empty", "还没有缺口。把答不上来的问题记在这里，补齐后关闭。"));
  }
  for (const gap of knowledgeState.gaps) gapList.append(gapNode(gap, refreshKnowledge));
  gapBlock.append(gapHead, gapList);

  columns.append(cardBlock, gapBlock);
  panelBody.append(columns);

  const regression = knowledgeState.regression ?? { questions: [], runs: [] };
  const regressionBlock = element("section", "knowledge-block regression-block");
  const regressionHead = element("div", "knowledge-block-head");
  regressionHead.append(element("h3", null, "回归题"));
  const regressionList = element("div", "knowledge-list");
  const regressionStatus = element("p", "knowledge-error");
  regressionStatus.hidden = true;
  const runRegressionButton = actionButton("运行回归", () => void runKnowledgeRegression(regressionStatus));
  runRegressionButton.classList.add("primary-button");
  runRegressionButton.disabled = regression.questions.length === 0;
  const addQuestion = element("button", "quiet-button", "＋ 添加回归题");
  addQuestion.type = "button";
  addQuestion.addEventListener("click", () => {
    regressionHead.hidden = true;
    const form = regressionForm(refreshKnowledge, () => { regressionHead.hidden = false; form.remove(); });
    regressionList.prepend(form);
    form.querySelector("input").focus();
  });
  regressionHead.append(runRegressionButton, addQuestion);

  if (regression.questions.length === 0) {
    regressionList.append(element("p", "knowledge-empty",
      "还没有回归题。把客户常问的问题加进来，升级后跑一遍就知道检索有没有退化。"));
  }
  for (const question of regression.questions) {
    const row = element("div", "regression-row");
    row.append(element("span", "regression-question", question.q));
    row.append(element("span", "regression-meta",
      question.baseline?.length ? `基线 ${question.baseline.length} 张卡` : "尚无基线"));
    row.append(actionButton("删除", () => void (async () => {
      const failure = await knowledgeAction({ action: "regressionRemove", id: question.id });
      if (!failure) await refreshKnowledge();
    })()));
    regressionList.append(row);
  }

  const lastRun = regression.runs.at(-1) ?? null;
  // Keep the empty state unambiguous: a run without questions is history, not
  // something to act on.
  if (lastRun && regression.questions.length > 0) {
    regressionList.append(element("p", "regression-summary",
      `上次运行：${new Date(lastRun.at).toLocaleString()} · 通过 ${lastRun.passed}/${lastRun.total}`
      + (lastRun.retained === null ? "" : ` · 保留 ${Math.round(lastRun.retained * 100)}%`)
      + (lastRun.reason ? ` · ${lastRun.reason}` : "")));
    for (const item of lastRun.items) {
      const row = element("div", "regression-row");
      row.append(element("span", `regression-mark ${item.pass ? "pass" : "fail"}`, item.pass ? "✓" : "✗"));
      row.append(element("span", "regression-question", item.q));
      row.append(element("span", "regression-meta",
        `命中 ${item.hits.length}`
        + (item.retained === null ? "" : ` · 保留 ${Math.round(item.retained * 100)}%`)));
      regressionList.append(row);
    }
  }

  regressionBlock.append(regressionHead, regressionStatus, regressionList);
  panelBody.append(regressionBlock);

  // Handover export. The bundle stays local, so this block explains where the
  // file goes and offers the most recent one for download instead of showing a
  // list that would grow without bound.
  const handoverBlock = element("section", "knowledge-block handover-block");
  const handoverHead = element("div", "knowledge-block-head");
  handoverHead.append(element("h3", null, "知识交接"));
  const handoverList = element("div", "knowledge-list");
  const handoverStatus = element("p", "knowledge-error");
  handoverStatus.hidden = true;
  const exportButton = actionButton("导出交接包", () => void exportHandover(handoverStatus));
  exportButton.classList.add("primary-button");
  handoverHead.append(exportButton);
  if (handoverState) {
    const row = element("div", "handover-row");
    row.append(element("span", "handover-meta",
      `最近导出：${new Date(handoverState.at).toLocaleString()} · ${handoverState.bytes} 字节`
      + (handoverState.by ? ` · ${handoverState.by}` : "")));
    row.append(actionButton("下载", () => downloadHandover(handoverState.file)));
    handoverList.append(row);
  } else {
    handoverList.append(element("p", "knowledge-empty",
      "导出内容包含知识卡、缺口、回归题与记忆，只写入本机数据目录，不会上传。"));
  }
  handoverBlock.append(handoverHead, handoverStatus, handoverList);
  panelBody.append(handoverBlock);

  panelBody.append(element("p", "panel-note",
    "回归题会在每次升级后重放本地检索；条目索引与交接包导入尚未迁移。"));
}

async function exportHandover(statusNode) {
  statusNode.hidden = true;
  try {
    const response = await apiRequest("/api/handover", {
      method: "POST",
      body: JSON.stringify({ projectId: currentProjectId }),
    });
    if (!response) return;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      statusNode.hidden = false;
      statusNode.textContent = body.error || "导出失败";
      return;
    }
    handoverState = body.info;
    renderKnowledgeBody();
  } catch {
    statusNode.hidden = false;
    statusNode.textContent = "导出失败，请稍后重试";
  }
}

function downloadHandover(file) {
  const link = document.createElement("a");
  link.href = `/api/handover/${encodeURIComponent(file)}`;
  link.download = file;
  document.body.append(link);
  link.click();
  link.remove();
}

async function runKnowledgeRegression(statusNode) {
  const failure = await knowledgeAction({ action: "regressionRun", reason: "手动运行" });
  if (failure) {
    statusNode.hidden = false;
    statusNode.textContent = failure;
    return;
  }
  await renderKnowledgeBody();
}

function regressionForm(onDone, onCancel) {
  const form = element("form", "knowledge-form");
  const question = element("input", "knowledge-field");
  question.placeholder = "客户常问的问题，例如：主推产品是什么？";
  question.setAttribute("aria-label", "回归题");
  const error = element("p", "knowledge-error");
  error.hidden = true;
  const actions = element("div", "knowledge-form-actions");
  const submit = element("button", "primary-button", "添加");
  submit.type = "submit";
  const cancel = element("button", "quiet-button", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", onCancel);
  actions.append(submit, cancel);
  form.append(question, actions, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const failure = await knowledgeAction({ action: "regressionAdd", question: question.value });
    if (failure) {
      error.hidden = false;
      error.textContent = failure;
      return;
    }
    await onDone();
  });
  return form;
}

async function refreshKnowledge() {
  intakeEditing = false;
  let response;
  try {
    response = await apiRequest(`/api/knowledge?projectId=${encodeURIComponent(currentProjectId ?? "")}`);
  } catch {
    response = null;
  }
  knowledgeState = response?.ok ? await response.json() : null;
  try {
    const latest = await apiRequest(`/api/handover/latest?projectId=${encodeURIComponent(currentProjectId ?? "")}`);
    handoverState = latest?.ok ? (await latest.json()).info : null;
  } catch {
    handoverState = null;
  }
  renderKnowledgeBody();
}

function renderPlaceholderPanel(label) {
  knowledgeState = null;
  panelBody.replaceChildren(element("p", "panel-note",
    `${label}工作区的完整功能正在按阶段迁移；此原型先验证工作台导航、项目与知识框架。`));
}

// Switching between the chat view and a rail panel swaps what the main area
// shows; the composer only belongs to the chat.
// Which view the main area is showing, so switching project can refresh it
// instead of leaving the previous project's panel on screen.
let activePanel = "agent";
const pageContextHint = $("#page-context-hint");
const pageContextLabel = $("#page-context-label");
const pageContextOpen = $("#page-context-open");
let rememberedPanel = null;

// Switching back to the chat keeps the open conversation; only an explicit
// "new conversation" action starts a fresh one.
function showAgentView({ keepConversation = false } = {}) {
  activePanel = "agent";
  panelView.hidden = true;
  conversation.hidden = false;
  composer.hidden = false;
  if (keepConversation && activeConversationId) {
    welcome.classList.add("hidden");
  } else {
    welcome.classList.remove("hidden");
    conversation.replaceChildren();
    activeConversationId = null;
  }
  pageContextHint.hidden = true;
  rememberedPanel = null;
}

// The runtime remembers the panel per conversation, but opening a panel hides
// the chat. It is therefore offered back as a one-click hint rather than
// replacing the conversation the user just opened.
function renderPageContextHint(pageContext) {
  const panel = pageContext?.panel ?? null;
  if (!panel || panel === "agent" || panel === activePanel) {
    pageContextHint.hidden = true;
    rememberedPanel = null;
    return;
  }
  rememberedPanel = { panel, label: pageContext.label || panel };
  pageContextLabel.textContent = rememberedPanel.label;
  pageContextHint.hidden = false;
}

// Fire-and-forget: bookkeeping must never block navigation or surface errors.
function rememberPageContext(panel, label) {
  if (!activeConversationId) return;
  void fetch(`/api/conversations/${encodeURIComponent(activeConversationId)}/context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ panel, label }),
  }).catch(() => {});
}

function openRememberedPanel() {
  if (!rememberedPanel) return;
  const { panel, label } = rememberedPanel;
  document.querySelectorAll(".rail-item").forEach(
    (item) => item.classList.toggle("active", item.dataset.panel === panel),
  );
  $("#current-section").textContent = label;
  showPanelView(panel, label);
  pageContextHint.hidden = true;
  rememberedPanel = null;
  rememberPageContext(panel, label);
}

function showPanelView(panel, label) {
  activePanel = panel;
  panelView.hidden = false;
  conversation.hidden = true;
  composer.hidden = true;
  welcome.classList.add("hidden");
  panelTitle.textContent = label;
  if (panel === "devices") {
    panelCopy.textContent = "把本机 desk 代理配对到工作台。工作台只保存令牌哈希，令牌本身留在设备上。";
    deviceState = null;
    deviceTicket = null;
    renderDeviceBody();
    void refreshDevices();
    return;
  }
  if (panel === "database") {
    panelCopy.textContent = '只把"已确认"的知识卡喂给模型：每次提问按关键词匹配，最多带上 3 张。';
    knowledgeState = null;
    renderKnowledgeBody();
    void refreshKnowledge();
    return;
  }
  panelCopy.textContent = "";
  renderPlaceholderPanel(label);
}

// Anything that belongs to the chat brings the main area back to it first.
function ensureAgentView() {
  if (!panelView.hidden) showAgentView();
}

// Consumes the /api/ai/chat/stream SSE endpoint. The server owns the exchange
// (it appends the question, replays context and stores the answer), so this
// only renders deltas and reports how the turn ended.
async function streamReply(payload, stream) {
  let response;
  try {
    // Chromium flags a fully-consumed streaming fetch as net::ERR_ABORTED in
    // DevTools even when the body arrived complete; a standalone SSE probe
    // reproduces it, so the signal is kept only as a cancel fallback.
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
      if (chunk.meta?.turnId) stream.turnId = chunk.meta.turnId;
      if (chunk.meta) applyTurnMeta(chunk.meta);
      if (chunk.meta?.citations) renderCitations(stream.target, chunk.meta.citations);
      if (chunk.stage) setLiveStage(chunk.status);
      if (chunk.delta) { answer += chunk.delta; stream.target.textContent = answer; }
      if (chunk.error) { stream.target.textContent = chunk.error; outcome = "failed"; }
      if (chunk.done) {
        if (chunk.cancelled || chunk.status === "cancelled") outcome = "cancelled";
        else if (chunk.status === "error") outcome = "failed";
      }
      conversation.scrollTop = conversation.scrollHeight;
    }
  }
  if (outcome === "done" && !answer) {
    stream.target.textContent = "AI 服务未返回内容。";
    outcome = "failed";
  }
  return outcome;
}

// Follows a turn that is already running on the server, starting from the
// sequence number a snapshot reported. Used after a refresh or when reopening a
// conversation whose reply has not finished yet.
async function followLiveTurn(conversationId, after, stream) {
  let response;
  try {
    response = await fetch(
      `/api/ai/chat/live?conversationId=${encodeURIComponent(conversationId)}&stream=1&after=${after}`,
      { signal: stream.controller.signal },
    );
  } catch (error) {
    if (error.name === "AbortError") return "cancelled";
    stream.target.textContent = "无法连接本地 AI 服务，请确认运行时仍在运行。";
    return "failed";
  }
  if (response.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
    return "failed";
  }
  if (!response.ok || !response.body) return "failed";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = stream.target.textContent || "";
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
      if (chunk.meta) applyTurnMeta(chunk.meta);
      if (chunk.meta?.citations) renderCitations(stream.target, chunk.meta.citations);
      if (chunk.delta) { answer += chunk.delta; stream.target.textContent = answer; }
      if (chunk.error) { stream.target.textContent = chunk.error; outcome = "failed"; }
      if (chunk.done) {
        if (chunk.status === "cancelled") outcome = "cancelled";
        else if (chunk.status === "error") outcome = "failed";
      }
      conversation.scrollTop = conversation.scrollHeight;
    }
  }
  return outcome;
}

// Asks the runtime whether the conversation has a reply in flight and, if so,
// renders what exists so far and follows it to completion.
async function reattachLiveTurn(conversationId) {
  if (activeStream) return;
  let response;
  try {
    response = await apiRequest(`/api/ai/chat/live?conversationId=${encodeURIComponent(conversationId)}`);
  } catch {
    return;
  }
  if (!response?.ok) return;
  const { turn } = await response.json().catch(() => ({}));
  if (!turn || turn.status !== "running") return;
  const target = appendMessage("assistant-message", turn.text || "");
  activeStream = { controller: new AbortController(), target, conversationId, turnId: turn.id };
  setStreaming(true);
  if (turn.effort) resolvedEffort = turn.effort;
  renderModel();
  startLiveHint("正在继续生成…");
  try {
    await followLiveTurn(conversationId, turn.seq || 0, activeStream);
  } finally {
    activeStream = null;
    setStreaming(false);
    stopLiveHint();
    // Re-render from storage so the finished answer replaces the streaming bubble.
    await openConversation(conversationId);
  }
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
    activeStream = {
      controller: new AbortController(),
      target: appendMessage("assistant-message"),
      conversationId: id,
      turnId: null,
    };
    setStreaming(true);
    resolvedEffort = null;
    startLiveHint();
    prompt.value = "";
    prompt.dispatchEvent(new Event("input"));
    try {
      await streamReply(
        { conversationId: id, content: text, clientTurnId: newClientTurnId(), ...turnOptions() },
        activeStream,
      );
    } finally {
      activeStream = null;
      setStreaming(false);
      stopLiveHint();
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
  void cancelActiveTurn();
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
  if (!modelMenu.hidden && menuMode === "model") closeModelMenu();
  else openModelMenu();
});
engineButton.addEventListener("click", () => {
  if (!modelMenu.hidden && menuMode === "engine") closeModelMenu();
  else openEngineMenu();
});
effortButton.addEventListener("click", () => {
  if (!modelMenu.hidden && menuMode === "effort") closeModelMenu();
  else openEffortMenu();
});
fastToggle.addEventListener("click", () => toggleFast());
projectButton.addEventListener("click", () => {
  if (projectMenu.hidden) openProjectMenu();
  else closeProjectMenu();
});
document.addEventListener("click", (event) => {
  if (modelMenu.hidden) return;
  if (isInside(event, modelMenu) || isInside(event, modelButton)
    || isInside(event, engineButton) || isInside(event, effortButton)
    || isInside(event, fastToggle)) return;
  closeModelMenu();
});
document.addEventListener("click", (event) => {
  if (projectMenu.hidden) return;
  if (isInside(event, projectMenu) || isInside(event, projectButton)) return;
  closeProjectMenu();
});
document.querySelectorAll(".suggestion").forEach((button) => button.addEventListener("click", () => startConversation(button.dataset.prompt)));
$("#memory-toggle").addEventListener("click", () => void openMemory());
$("#memory-close").addEventListener("click", closeMemory);
memoryModal.addEventListener("click", (event) => { if (event.target === memoryModal) closeMemory(); });
memorySave.addEventListener("click", () => void saveMemory());
memorySoulButton.addEventListener("click", () => void generateSoulDraft());
memoryDistillButton.addEventListener("click", () => void distillCurrentConversation());
// Edits stay in the draft until 保存, and switching tabs keeps them.
memoryEditor.addEventListener("input", () => { memoryDraft[memoryTab] = memoryEditor.value; });
document.querySelectorAll(".memory-tab").forEach((tab) => tab.addEventListener("click", () => {
  memoryDraft[memoryTab] = memoryEditor.value;
  memoryTab = tab.dataset.memoryTab;
  renderMemory();
}));
$("#new-agent").addEventListener("click", () => { pageContextHint.hidden = true; rememberedPanel = null; conversation.replaceChildren(); welcome.classList.remove("hidden"); startConversation(); });
pageContextOpen.addEventListener("click", openRememberedPanel);
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
  if (event.key === "Escape") { searchModal.hidden = true; drawer.classList.remove("open"); rail.classList.remove("mobile-open"); closeModelMenu(); closeProjectMenu(); closeMemory(); }
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
  // The rail switches the main area: Agent is the chat, 知识库 is real, and the
  // rest still say plainly that they are not migrated.
  if (panel === "agent") showAgentView({ keepConversation: true });
  else showPanelView(panel, label);
  rememberPageContext(panel, label);
  if (matchMedia("(max-width: 640px)").matches) rail.classList.remove("mobile-open");
}));
document.querySelectorAll(".top-tab").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".top-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  const isOps = button.dataset.mode === "ops";
  document.querySelectorAll(".rail-item").forEach((item) => item.classList.toggle("active", !isOps && item.dataset.panel === "agent"));
  $("#current-section").textContent = isOps ? "经营台" : "Agent";
  if (isOps) showPanelView("ops", "经营台");
  else showAgentView({ keepConversation: true });
  rememberPageContext(isOps ? "ops" : "agent", isOps ? "经营台" : "Agent");
}));

// The project scope has to be known before the rail is read, so bootstrapping
// resolves the project first and then loads the history and model in parallel.
async function bootstrap() {
  await loadProjects();
  await Promise.all([loadHistory(), loadAiSettings()]);
}
void bootstrap();
