import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { DEEPSEEK_MODELS, createDeepseekProvider } from "../src/ai/deepseek-provider.mjs";

async function startStub(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

test("the DeepSeek provider sends the key, chats and streams over the OpenAI API", async () => {
  const calls = [];
  const stub = await startStub(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/chat/completions");
    const body = JSON.parse(await readBody(request));
    calls.push({ body, auth: request.headers.authorization });
    if (body.model === "missing") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Model Not Exist" } }));
      return;
    }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "折叠" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "彩虹琴" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "云端回复" }, finish_reason: "stop" }],
    }));
  });
  try {
    const provider = createDeepseekProvider({ baseUrl: stub.url, apiKey: "sk-test" });
    assert.equal(provider.id, "deepseek");
    assert.deepEqual(await provider.listModels(), DEEPSEEK_MODELS.map((model) => ({ ...model })));

    const reply = await provider.chat({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "你好" }],
    });
    assert.equal(reply.content, "云端回复");
    assert.equal(reply.model, "deepseek-chat");
    assert.equal(reply.finishReason, "stop");
    assert.equal(calls[0].auth, "Bearer sk-test");
    assert.deepEqual(calls[0].body.messages, [{ role: "user", content: "你好" }]);
    assert.equal(calls[0].body.stream, false);

    const chunks = [];
    let finishReason = null;
    for await (const chunk of provider.streamChat({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "介绍产品" }],
    })) {
      if (chunk.delta) chunks.push(chunk.delta);
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    assert.equal(chunks.join(""), "折叠彩虹琴");
    assert.equal(finishReason, "stop");
    assert.equal(calls[1].body.stream, true);

    await assert.rejects(
      provider.chat({ model: "missing", messages: [{ role: "user", content: "hi" }] }),
      /Model Not Exist/u,
    );
  } finally {
    await stub.close();
  }
});

test("the DeepSeek provider reads the key lazily and explains missing or rejected keys", async () => {
  let key = "";
  const stub = await startStub((request, response) => {
    const auth = request.headers.authorization;
    if (auth !== "Bearer rotated") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Authentication Fails" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  try {
    const provider = createDeepseekProvider({ baseUrl: stub.url, apiKey: () => key });
    await assert.rejects(
      provider.chat({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }),
      /没有配置 DeepSeek API Key/u,
    );
    key = "wrong";
    await assert.rejects(
      provider.chat({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }),
      /DeepSeek 密钥无效或未授权/u,
    );
    key = "rotated";
    assert.equal(
      (await provider.chat({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] })).content,
      "ok",
    );
  } finally {
    await stub.close();
  }
});

test("the DeepSeek provider normalises base URLs and surfaces aborts", async () => {
  assert.doesNotThrow(() => createDeepseekProvider({ baseUrl: "api.deepseek.com", apiKey: "k" }));
  assert.doesNotThrow(() => createDeepseekProvider({ baseUrl: "https://api.deepseek.com/", apiKey: "k" }));
  assert.throws(() => createDeepseekProvider({ baseUrl: "ftp://api.deepseek.com" }), /http/u);
  assert.throws(() => createDeepseekProvider({ baseUrl: "not a url" }), /Invalid URL/u);
  assert.throws(() => createDeepseekProvider({ fetch: "no" }), /fetch/u);

  const stub = await startStub((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
  });
  try {
    const provider = createDeepseekProvider({ baseUrl: stub.url, apiKey: "k" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      provider.chat({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], signal: controller.signal }),
      (error) => error.name === "AbortError",
    );
  } finally {
    await stub.close();
  }
});
