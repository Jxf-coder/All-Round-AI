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
    appendMessage(message.role === "user" ? "" : "assistant-message", message.content);
  }
  renderReplyActions(document_.messages);
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

function renderMemory() {
  memoryEditor.value = memoryDraft[memoryTab] ?? "";
  memoryEditor.placeholder = MEMORY_PLACEHOLDERS[memoryTab];
  memoryHint.textContent = MEMORY_HINTS[memoryTab];
  for (const tab of document.querySelectorAll(".memory-tab")) {
    const active = tab.dataset.memoryTab === memoryTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
}

async function openMemory() {
  memoryModal.hidden = false;
  memoryTitle.textContent = `人格与记忆 · ${projectNameOf(currentProjectId)}`;
  memoryTab = "soul";
  memoryDraft = { soul: "", memory: "" };
  memoryStatus.textContent = "加载中…";
  renderMemory();
  const response = await apiRequest(`/api/memory?projectId=${encodeURIComponent(currentProjectId ?? "")}`);
  if (!response?.ok) {
    memoryStatus.textContent = "无法读取记忆";
    return;
  }
  const payload = await response.json();
  memoryDraft = { soul: payload.soul ?? "", memory: payload.memory ?? "" };
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
  const response = await apiRequest("/api/memory", {
    method: "POST",
    body: JSON.stringify({ projectId: currentProjectId, soul: memoryDraft.soul, memory: memoryDraft.memory }),
  });
  memorySave.disabled = false;
  memorySave.textContent = "保存";
  const payload = await response?.json().catch(() => ({}));
  if (!response?.ok) {
    memoryStatus.textContent = payload?.error || "保存失败";
    return;
  }
  memoryDraft = { soul: payload.soul ?? "", memory: payload.memory ?? "" };
  memoryStatus.textContent = `已保存 ${new Date(payload.updatedAt).toLocaleString()}`;
  renderMemory();
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

function renderKnowledgeBody() {
  panelBody.replaceChildren();
  if (!knowledgeState) {
    panelBody.append(element("p", "panel-note", "知识库暂时不可用。"));
    return;
  }
  panelBody.append(knowledgeStats(knowledgeState.stats));

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
  panelBody.append(element("p", "panel-note", "当前只有知识卡与缺口清单：来源条目索引、问答来源记录与交接包导出尚未迁移。"));
}

async function refreshKnowledge() {
  let response;
  try {
    response = await apiRequest(`/api/knowledge?projectId=${encodeURIComponent(currentProjectId ?? "")}`);
  } catch {
    response = null;
  }
  knowledgeState = response?.ok ? await response.json() : null;
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

function showAgentView() {
  activePanel = "agent";
  panelView.hidden = true;
  conversation.hidden = false;
  composer.hidden = false;
  welcome.classList.remove("hidden");
  conversation.replaceChildren();
  activeConversationId = null;
}

function showPanelView(panel, label) {
  activePanel = panel;
  panelView.hidden = false;
  conversation.hidden = true;
  composer.hidden = true;
  welcome.classList.add("hidden");
  panelTitle.textContent = label;
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
// Edits stay in the draft until 保存, and switching tabs keeps them.
memoryEditor.addEventListener("input", () => { memoryDraft[memoryTab] = memoryEditor.value; });
document.querySelectorAll(".memory-tab").forEach((tab) => tab.addEventListener("click", () => {
  memoryDraft[memoryTab] = memoryEditor.value;
  memoryTab = tab.dataset.memoryTab;
  renderMemory();
}));
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
  if (panel === "agent") showAgentView();
  else showPanelView(panel, label);
  if (matchMedia("(max-width: 640px)").matches) rail.classList.remove("mobile-open");
}));
document.querySelectorAll(".top-tab").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".top-tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  const isOps = button.dataset.mode === "ops";
  document.querySelectorAll(".rail-item").forEach((item) => item.classList.toggle("active", !isOps && item.dataset.panel === "agent"));
  $("#current-section").textContent = isOps ? "经营台" : "Agent";
  if (isOps) showPanelView("ops", "经营台");
  else showAgentView();
}));

// The project scope has to be known before the rail is read, so bootstrapping
// resolves the project first and then loads the history and model in parallel.
async function bootstrap() {
  await loadProjects();
  await Promise.all([loadHistory(), loadAiSettings()]);
}
void bootstrap();
