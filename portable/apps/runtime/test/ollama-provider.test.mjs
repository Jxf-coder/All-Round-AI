import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createOllamaProvider } from "../src/ai/ollama-provider.mjs";

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

test("the Ollama provider lists, chats and streams over the local API", async () => {
  const requests = [];
  const stub = await startStub(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        models: [
          { name: "llama3.2:latest" },
          { model: "qwen2.5:7b" },
          { name: "llama3.2:latest" },
        ],
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      const body = JSON.parse(await readBody(request));
      requests.push(body);
      if (body.model === "missing") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "model 'missing' not found" }));
        return;
      }
      if (body.stream) {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ message: { content: "折叠" }, done: false })}\n`);
        response.write(`${JSON.stringify({ message: { content: "彩虹琴" }, done: false })}\n`);
        response.end(`${JSON.stringify({ done: true, done_reason: "stop" })}\n`);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: { role: "assistant", content: "你好" }, done: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  try {
    const provider = createOllamaProvider({ baseUrl: stub.url });
    assert.equal(provider.id, "ollama");
    assert.deepEqual(await provider.listModels(), [
      { id: "llama3.2:latest", name: "llama3.2" },
      { id: "qwen2.5:7b", name: "qwen2.5:7b" },
    ]);

    const reply = await provider.chat({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "你好" }],
    });
    assert.equal(reply.content, "你好");
    assert.equal(reply.model, "llama3.2:latest");
    assert.equal(reply.finishReason, "stop");
    assert.equal(requests[0].stream, false);
    assert.deepEqual(requests[0].messages, [{ role: "user", content: "你好" }]);

    const chunks = [];
    let finishReason = null;
    for await (const chunk of provider.streamChat({
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "介绍产品" }],
    })) {
      if (chunk.delta) chunks.push(chunk.delta);
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    assert.equal(chunks.join(""), "折叠彩虹琴");
    assert.equal(finishReason, "stop");
    assert.equal(requests[1].stream, true);

    await assert.rejects(
      provider.chat({ model: "missing", messages: [{ role: "user", content: "hi" }] }),
      /not found/u,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      provider.chat({ model: "llama3.2", messages: [{ role: "user", content: "hi" }], signal: controller.signal }),
      /cancelled/u,
    );
  } finally {
    await stub.close();
  }
});

test("an unreachable Ollama reports no models and a clear chat error", async () => {
  const stub = await startStub((request, response) => {
    response.writeHead(500);
    response.end();
  });
  const url = stub.url;
  await stub.close();
  const provider = createOllamaProvider({ baseUrl: url });
  assert.deepEqual(await provider.listModels(), []);
  await assert.rejects(
    provider.chat({ model: "llama3.2", messages: [{ role: "user", content: "hi" }] }),
    /连不上 Ollama/u,
  );
});

test("the provider normalizes base URLs and rejects non-http schemes", () => {
  assert.doesNotThrow(() => createOllamaProvider({ baseUrl: "127.0.0.1:11434" }));
  assert.doesNotThrow(() => createOllamaProvider({ baseUrl: "http://nas.local:11434/" }));
  assert.throws(() => createOllamaProvider({ baseUrl: "ftp://nas.local" }), /http/u);
  assert.throws(() => createOllamaProvider({ baseUrl: "not a url" }), /Invalid URL/u);
  assert.throws(() => createOllamaProvider({ fetch: "no" }), /fetch/u);
});
