const form = document.querySelector("#login-form");
const user = document.querySelector("#login-user");
const password = document.querySelector("#login-password");
const error = document.querySelector("#login-error");
const submit = document.querySelector("#login-submit");
const notice = document.querySelector("#auth-notice");

fetch("/api/auth/status", { credentials: "same-origin", cache: "no-store" })
  .then((response) => (response.ok ? response.json() : null))
  .then((status) => {
    if (!notice || !status) return;
    notice.textContent = status.configured
      ? "账号将由已配置的认证服务验证。"
      : "登录服务尚未连接；账号不会转发到外部服务。";
  })
  .catch(() => {
    if (notice) notice.textContent = "暂时无法连接本机登录服务。";
  });

function localPath(value, fallback = "/") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : fallback;
  } catch {
    return fallback;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  error.hidden = true;
  error.textContent = "";
  if (!user.value.trim() || !password.value) {
    error.hidden = false;
    error.textContent = "请输入账号和密码";
    (!user.value.trim() ? user : password).focus();
    return;
  }
  submit.disabled = true;
  submit.textContent = "登录中…";
  void (async () => {
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: user.value.trim(), password: password.value }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        error.hidden = false;
        error.textContent = data.error || "账号或密码错误";
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const rawNext = params.get("next");
      const next = localPath(rawNext || "/");
      const apiLanding = typeof data.landing === "string" ? data.landing : "/";
      const landing = rawNext && next !== "/" && !apiLanding.startsWith("/workbench/coach/")
        ? next
        : localPath(apiLanding, next);
      window.location.assign(landing);
    } catch {
      error.hidden = false;
      error.textContent = "网络错误，请重试";
    } finally {
      submit.disabled = false;
      submit.textContent = "登录";
    }
  })();
});
