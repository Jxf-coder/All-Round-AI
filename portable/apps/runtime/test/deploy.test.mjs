import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  renderEnvFile,
  renderEnvironmentBlock,
  renderNginxConfig,
  renderSystemdUnit,
} from "../src/deploy.mjs";

const run = promisify(execFile);

test("the environment file describes a loopback server behind a TLS proxy", () => {
  const env = renderEnvFile({
    dataDir: "/var/lib/all-round-ai",
    port: 3200,
    allowedOrigins: "https://work.example.com",
    ollamaUrl: "http://127.0.0.1:11434",
  });
  assert.match(env, /ALLROUND_AI_PROFILE=server/u);
  assert.match(env, /ALLROUND_AI_HOST=127\.0\.0\.1/u);
  assert.match(env, /ALLROUND_AI_PORT=3200/u);
  assert.match(env, /ALLROUND_AI_ALLOW_REMOTE=0/u);
  assert.match(env, /ALLROUND_AI_SECURE_COOKIES=1/u);
  assert.match(env, /ALLROUND_AI_DATA_DIR="\/var\/lib\/all-round-ai"/u);
  assert.match(env, /ALLROUND_AI_ALLOWED_ORIGINS="https:\/\/work\.example\.com"/u);
  assert.match(env, /ALLROUND_AI_OLLAMA_URL="http:\/\/127\.0\.0\.1:11434"/u);
  assert.match(renderEnvFile({ dataDir: "/srv/data", secureCookies: false }), /SECURE_COOKIES=0/u);

  assert.throws(() => renderEnvFile({ dataDir: "relative" }), /绝对路径/u);
  assert.throws(() => renderEnvFile({ dataDir: "/srv/data", port: 0 }), /端口/u);
  assert.throws(
    () => renderEnvFile({ dataDir: "/srv/data", allowedOrigins: "https://a\nhttps://b" }),
    /换行/u,
  );
});

test("the systemd unit runs the runtime as a hardened service", () => {
  const unit = renderSystemdUnit({
    workDir: "/opt/all round ai/current",
    dataDir: "/var/lib/all-round-ai",
    user: "allround",
    group: "allround",
  });
  assert.match(unit, /^\[Unit\]/u);
  assert.match(unit, /Description=All Round AI/u);
  assert.match(unit, /User=allround/u);
  assert.match(unit, /WorkingDirectory="\/opt\/all round ai\/current"/u);
  assert.match(unit, /Environment=NODE_ENV=production/u);
  assert.match(unit, /EnvironmentFile=-\/etc\/all-round-ai\/all-round-ai\.env/u);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/all round ai\/current\/portable\/apps\/runtime\/src\/main\.mjs"/u);
  assert.match(unit, /Restart=on-failure/u);
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /ProtectSystem=strict/u);
  assert.match(unit, /ReadWritePaths="\/var\/lib\/all-round-ai"/u);
  assert.match(unit, /WantedBy=multi-user\.target/u);

  assert.throws(() => renderSystemdUnit({ workDir: "relative", dataDir: "/var/lib/a" }), /绝对路径/u);
  assert.throws(() => renderSystemdUnit({ workDir: "/opt/a", dataDir: "relative" }), /绝对路径/u);
  assert.throws(() => renderSystemdUnit({ workDir: "/opt/a", dataDir: "/var/lib/a", user: "bad user" }), /运行用户/u);
  assert.throws(() => renderSystemdUnit({
    workDir: "/opt/a",
    dataDir: "/var/lib/a",
    mainPath: "/etc/passwd",
  }), /相对路径/u);
  assert.throws(() => renderSystemdUnit({
    workDir: "/opt/a",
    dataDir: "/var/lib/a",
    envFile: "/etc/a b/env",
  }), /空白/u);
});

test("nginx proxies SSE without buffering and can terminate TLS", () => {
  const plain = renderNginxConfig({ serverName: "work.example.com" });
  assert.match(plain, /listen 80;/u);
  assert.match(plain, /server_name work\.example\.com;/u);
  assert.match(plain, /proxy_pass http:\/\/127\.0\.0\.1:3141;/u);
  assert.match(plain, /proxy_buffering off;/u);
  assert.match(plain, /proxy_cache off;/u);
  assert.match(plain, /proxy_read_timeout 3600s;/u);
  assert.match(plain, /client_max_body_size 50m;/u);
  assert.doesNotMatch(plain, /listen 443/u);

  const tls = renderNginxConfig({
    serverName: "work.example.com",
    tlsCert: "/etc/letsencrypt/live/work.example.com/fullchain.pem",
    tlsKey: "/etc/letsencrypt/live/work.example.com/privkey.pem",
  });
  assert.match(tls, /return 301 https:\/\/\$host\$request_uri;/u);
  assert.match(tls, /listen 443 ssl http2;/u);
  assert.match(tls, /ssl_certificate \/etc\/letsencrypt/u);
  assert.match(tls, /ssl_certificate_key \/etc\/letsencrypt/u);

  assert.throws(() => renderNginxConfig({ serverName: "bad name" }), /server_name/u);
  assert.throws(() => renderNginxConfig({ upstream: "ftp://x" }), /upstream/u);
  assert.throws(() => renderNginxConfig({ tlsCert: "/a" }), /同时提供/u);
  assert.throws(() => renderNginxConfig({ clientMaxBodySize: "huge" }), /client_max_body_size/u);
});

test("environment overrides are validated", () => {
  assert.equal(
    renderEnvironmentBlock({ ALLROUND_AI_ENGINE: "ollama" }),
    "Environment=ALLROUND_AI_ENGINE=\"ollama\"",
  );
  assert.throws(() => renderEnvironmentBlock({ "bad key": "x" }), /环境变量名/u);
  assert.throws(() => renderEnvironmentBlock({ OK: "a\nb" }), /换行/u);
});

test("the CLI writes all three deployment files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allround-deploy-"));
  try {
    const cli = fileURLToPath(new URL("../src/deploy-cli.mjs", import.meta.url));
    const out = path.join(root, "deploy");
    const created = await run(process.execPath, [
      cli, "systemd",
      "--out", out,
      "--workdir", "/opt/all-round-ai/current",
      "--data-dir", "/var/lib/all-round-ai",
      "--port", "3200",
      "--server-name", "work.example.com",
    ]);
    const result = JSON.parse(created.stdout);
    assert.equal(result.ok, true);
    assert.deepEqual(result.files.sort(), [
      "all-round-ai.env",
      "all-round-ai.nginx.conf",
      "all-round-ai.service",
    ]);
    const unit = await readFile(path.join(out, "all-round-ai.service"), "utf8");
    assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/all-round-ai\/current/u);
    const env = await readFile(path.join(out, "all-round-ai.env"), "utf8");
    assert.match(env, /ALLROUND_AI_PORT=3200/u);
    assert.match(env, /ALLROUND_AI_SECURE_COOKIES=0/u);
    const nginx = await readFile(path.join(out, "all-round-ai.nginx.conf"), "utf8");
    assert.match(nginx, /server_name work\.example\.com;/u);
    assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3200;/u);

    const tlsOut = path.join(root, "deploy-tls");
    await run(process.execPath, [
      cli, "systemd",
      "--out", tlsOut,
      "--workdir", "/opt/all-round-ai/current",
      "--data-dir", "/var/lib/all-round-ai",
      "--server-name", "work.example.com",
      "--tls-cert", "/etc/ssl/fullchain.pem",
      "--tls-key", "/etc/ssl/privkey.pem",
    ]);
    const tlsEnv = await readFile(path.join(tlsOut, "all-round-ai.env"), "utf8");
    assert.match(tlsEnv, /ALLROUND_AI_SECURE_COOKIES=1/u);
    assert.match(tlsEnv, /ALLROUND_AI_ALLOWED_ORIGINS="https:\/\/work\.example\.com"/u);
    const tlsNginx = await readFile(path.join(tlsOut, "all-round-ai.nginx.conf"), "utf8");
    assert.match(tlsNginx, /listen 443 ssl http2;/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
