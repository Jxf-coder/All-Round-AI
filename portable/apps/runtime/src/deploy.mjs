import path from "node:path";

// ---------------------------------------------------------------------------
// Server deployment artifacts.
//
// Nothing here installs anything: it renders the three files an operator copies
// to a Ubuntu host (systemd unit, environment file, nginx reverse proxy). The
// runtime keeps listening on loopback and the proxy terminates TLS, which is the
// only configuration where secure cookies and a public origin are both honest.
// ---------------------------------------------------------------------------

const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9._*-]+$/u;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !path.posix.isAbsolute(value)) {
    throw new TypeError(`${label}必须是绝对路径`);
  }
  return path.posix.normalize(value);
}

function requirePort(value, fallback = 3141) {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("端口必须是 1–65535 的整数");
  }
  return port;
}

function requireUser(value, label, fallback) {
  const user = value === undefined ? fallback : String(value);
  if (!USER_PATTERN.test(user)) {
    throw new TypeError(`${label}只能包含字母、数字、下划线和短横线`);
  }
  return user;
}

function quote(value) {
  return `"${String(value).replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")}"`;
}

function envValue(value) {
  const text = String(value);
  if (/[\r\n]/u.test(text)) throw new TypeError("环境变量值不能包含换行");
  return quote(text);
}

export function renderEnvFile({
  dataDir,
  port = 3141,
  allowedOrigins = "",
  ollamaUrl = "",
  secureCookies = true,
}) {
  const data = requireAbsolute(dataDir, "数据目录");
  const listenPort = requirePort(port);
  const lines = [
    "# All Round AI 环境变量（0600）。由 deploy-cli 生成，按实际部署修改。",
    "ALLROUND_AI_PROFILE=server",
    "ALLROUND_AI_HOST=127.0.0.1",
    `ALLROUND_AI_PORT=${listenPort}`,
    "ALLROUND_AI_ALLOW_REMOTE=0",
    `ALLROUND_AI_SECURE_COOKIES=${secureCookies ? "1" : "0"}`,
    `ALLROUND_AI_DATA_DIR=${envValue(data)}`,
  ];
  if (allowedOrigins) {
    lines.push(`ALLROUND_AI_ALLOWED_ORIGINS=${envValue(allowedOrigins)}`);
  }
  if (ollamaUrl) {
    lines.push(`ALLROUND_AI_OLLAMA_URL=${envValue(ollamaUrl)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderSystemdUnit({
  description = "All Round AI",
  workDir,
  dataDir,
  user = "allround",
  group = user,
  nodePath = "/usr/bin/node",
  mainPath = "portable/apps/runtime/src/main.mjs",
  envFile = "/etc/all-round-ai/all-round-ai.env",
}) {
  const work = requireAbsolute(workDir, "代码目录");
  const data = requireAbsolute(dataDir, "数据目录");
  const serviceUser = requireUser(user, "运行用户", "allround");
  const serviceGroup = requireUser(group, "运行组", serviceUser);
  if (typeof nodePath !== "string" || !nodePath.startsWith("/")) {
    throw new TypeError("Node 路径必须是绝对路径");
  }
  if (typeof mainPath !== "string" || !mainPath.trim() || path.posix.isAbsolute(mainPath)) {
    throw new TypeError("入口脚本必须是代码目录内的相对路径");
  }
  if (typeof envFile !== "string" || !envFile.startsWith("/") || /\s/u.test(envFile)) {
    throw new TypeError("环境文件路径必须是绝对路径且不能包含空白");
  }
  const execStart = [
    quote(nodePath),
    quote(path.posix.join(work, mainPath)),
  ].join(" ");
  return `[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
User=${serviceUser}
Group=${serviceGroup}
WorkingDirectory=${quote(work)}
Environment=NODE_ENV=production
EnvironmentFile=-${envFile}
ExecStart=${execStart}
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${quote(data)}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
`;
}

export function renderNginxConfig({
  serverName = "_",
  upstream = "http://127.0.0.1:3141",
  tlsCert = "",
  tlsKey = "",
  clientMaxBodySize = "50m",
}) {
  const name = String(serverName).trim() || "_";
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new TypeError("server_name 只能包含域名、点、星号与短横线");
  }
  if (typeof upstream !== "string" || !/^https?:\/\/[^\s/]+(?::\d+)?$/u.test(upstream)) {
    throw new TypeError("upstream 必须是 http(s) 地址");
  }
  if (typeof clientMaxBodySize !== "string" || !/^\d+[kKmMgG]?$/u.test(clientMaxBodySize)) {
    throw new TypeError("client_max_body_size 格式无效");
  }
  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    throw new TypeError("TLS 证书与私钥必须同时提供");
  }
  const proxy = `    location / {
        proxy_pass ${upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }`;
  if (!tlsCert) {
    return `# TLS 由 certbot 或上层代理终止后，将监听改为 443 并补 ssl_certificate。
server {
    listen 80;
    server_name ${name};
    client_max_body_size ${clientMaxBodySize};

${proxy}
}
`;
  }
  return `server {
    listen 80;
    server_name ${name};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${name};
    ssl_certificate ${tlsCert};
    ssl_certificate_key ${tlsKey};
    client_max_body_size ${clientMaxBodySize};

${proxy}
}
`;
}

// Validates an explicit environment override map before it is written into a
// unit. Values cannot contain newlines, which keeps a generated file from
// acquiring a second directive.
export function renderEnvironmentBlock(environment = {}) {
  const lines = [];
  for (const [key, value] of Object.entries(environment)) {
    if (!ENV_NAME_PATTERN.test(key)) throw new TypeError(`环境变量名无效：${key}`);
    lines.push(`Environment=${key}=${envValue(value)}`);
  }
  return lines.join("\n");
}
