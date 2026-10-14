const form = document.querySelector("#login-form");
const user = document.querySelector("#login-user");
const password = document.querySelector("#login-password");
const error = document.querySelector("#login-error");
form.addEventListener("submit", (event) => {
  event.preventDefault();
  error.hidden = false;
  if (!user.value.trim() || !password.value) {
    error.textContent = "请输入账号和密码";
    (!user.value.trim() ? user : password).focus();
    return;
  }
  error.textContent = "登录服务尚未配置。账号和密码没有发送，请稍后再试。";
});
