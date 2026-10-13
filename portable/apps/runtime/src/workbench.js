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
  if (initialText) prompt.value = initialText;
  prompt.focus();
  if (matchMedia("(max-width: 640px)").matches) rail.classList.remove("mobile-open");
  drawer.classList.remove("open");
}
function submitMessage(event) {
  event?.preventDefault();
  const text = prompt.value.trim();
  if (!text) return;
  welcome.classList.add("hidden");
  const user = document.createElement("div");
  user.className = "message";
  user.textContent = text;
  conversation.append(user);
  const reply = document.createElement("div");
  reply.className = "message assistant-message";
  reply.textContent = "此界面当前为可交互原型。连接原项目等价的 AI 服务后，才能生成真实回复。";
  conversation.append(reply);
  conversation.scrollTop = conversation.scrollHeight;
  const entry = document.createElement("button");
  entry.className = "history-entry";
  entry.textContent = text;
  entry.title = text;
  entry.addEventListener("click", () => { conversation.replaceChildren(); welcome.classList.remove("hidden"); });
  historyList.prepend(entry);
  prompt.value = "";
  prompt.dispatchEvent(new Event("input"));
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
$("#history-more").addEventListener("click", () => { $(".recent-heading").firstChild.textContent = "最近对话（本机会话）"; });
document.querySelectorAll(".rail-item").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".rail-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  const label = button.querySelector(".rail-label").textContent;
  const panel = button.dataset.panel;
  $("#current-section").textContent = label;
  if (panel === "agent") { welcome.classList.remove("hidden"); conversation.replaceChildren(); }
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
  if (isOps) {
    const notice = document.createElement("div");
    notice.className = "message assistant-message";
    notice.textContent = "经营台界面正在按阶段迁移；当前可核验顶栏模式切换与界面框架。";
    conversation.append(notice);
  }
}));
