const form = document.querySelector("#change-password-form");
const currentPassword = document.querySelector("#current-password");
const newPassword = document.querySelector("#new-password");
const confirmPassword = document.querySelector("#confirm-password");
const error = document.querySelector("#change-password-error");
const submit = document.querySelector("#change-password-submit");

function localPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && url.pathname !== "/change-password"
      ? url.pathname + url.search + url.hash : "/";
  } catch { return "/"; }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  error.hidden = true;
  error.textContent = "";
  if (!currentPassword.value || !newPassword.value || !confirmPassword.value) {
    error.textContent = "请填写所有密码字段";
    error.hidden = false;
    return;
  }
  if ([...newPassword.value].length < 12) {
    error.textContent = "新密码至少需要 12 个字符";
    error.hidden = false;
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.textContent = "两次输入的新密码不一致";
    error.hidden = false;
    confirmPassword.focus();
    return;
  }
  submit.disabled = true;
  submit.textContent = "保存中…";
  void (async () => {
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value }),
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        error.textContent = data.error || "密码更新失败，请重试";
        error.hidden = false;
        return;
      }
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(localPath(next));
    } catch {
      error.textContent = "网络错误，请重试";
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "保存新密码";
    }
  })();
});
