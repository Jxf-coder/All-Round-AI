import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatSrt, mediaKindOf, scanMediaDirectory } from "./automation-media.mjs";
import { probeMediaFile, runMediaTool } from "./media-tools.mjs";
import { resolveAllowedFile, resolveScoutRoot } from "./sources.mjs";

// ---------------------------------------------------------------------------
// Speech to subtitles.
//
// Recognition itself is Python (faster-whisper); the runtime only owns the
// contract: decode to 16 kHz mono WAV with FFmpeg, hand the sidecar one JSON
// request, then turn its segments into SRT cues. Nothing here imports Python
// as an npm dependency, and a missing interpreter fails with an install hint
// instead of breaking startup.
// ---------------------------------------------------------------------------

export const ASR_LANGUAGES = Object.freeze({
  auto: { label: "自动识别", code: null },
  zh: { label: "中文", code: "zh" },
  en: { label: "英文", code: "en" },
  yue: { label: "粤语", code: "yue" },
});

export const ASR_LIMITS = Object.freeze({
  maxChars: 42,
  minGapMs: 120,
  maxSeconds: 3_600,
});

const PUNCTUATION = /[。！？!?；;，,、]/u;
const WORKER_PATH = fileURLToPath(new URL("../sidecar/asr_worker.py", import.meta.url));

function safeRunName(runId) {
  return String(runId).replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80) || "run";
}

function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "未知";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Whisper returns sentence-like segments. Long ones are split at punctuation
// first and only then at the character cap, so a cue never ends mid-phrase.
export function splitCueText(text, maxChars = ASR_LIMITS.maxChars) {
  const chars = Array.from(String(text ?? "").replace(/\s+/gu, " ").trim());
  if (!chars.length) return [];
  if (chars.length <= maxChars) return [chars.join("")];
  const chunks = [];
  let current = [];
  const minBeforePunctuation = Math.min(6, Math.max(2, Math.floor(maxChars / 3)));
  for (const char of chars) {
    current.push(char);
    const atPunctuation = PUNCTUATION.test(char) && current.length >= minBeforePunctuation;
    if (atPunctuation || current.length >= maxChars) {
      const chunk = current.join("").trim();
      if (chunk) chunks.push(chunk);
      current = [];
    }
  }
  const rest = current.join("").trim();
  if (rest) chunks.push(rest);
  return chunks;
}

// Segments become cues with a small guaranteed gap, and a long segment is
// divided in proportion to the characters it produced.
export function buildCues(segments, { maxChars = ASR_LIMITS.maxChars, minGapMs = ASR_LIMITS.minGapMs } = {}) {
  if (!Array.isArray(segments)) throw new Error("识别结果缺少分段");
  const cues = [];
  for (const segment of segments) {
    const start = Math.round(Number(segment?.start) * 1_000);
    const end = Math.round(Number(segment?.end) * 1_000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const chunks = splitCueText(segment.text, maxChars);
    if (!chunks.length) continue;
    const totalChars = chunks.reduce((sum, chunk) => sum + Array.from(chunk).length, 0);
    let cursor = start;
    chunks.forEach((chunk, index) => {
      const share = Array.from(chunk).length / totalChars;
      const span = index === chunks.length - 1
        ? end - cursor
        : Math.max(300, Math.round((end - start) * share));
      const cueEnd = index === chunks.length - 1 ? end : Math.min(end, cursor + span);
      cues.push({ start: cursor, end: cueEnd, text: chunk });
      cursor = cueEnd;
    });
  }

  let previous = null;
  for (const cue of cues) {
    if (previous && cue.start < previous.end + minGapMs) {
      cue.start = previous.end + minGapMs;
      if (cue.end <= cue.start + 200) cue.end = cue.start + 200;
    }
    previous = cue;
  }
  return cues.filter((cue) => cue.end > cue.start);
}

export function parseSidecarOutput(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) throw new Error("语音识别没有返回结果");
  let payload;
  try {
    payload = JSON.parse(last);
  } catch {
    throw new Error("语音识别返回了无法解析的内容");
  }
  if (!payload || typeof payload !== "object") throw new Error("语音识别返回格式无效");
  if (payload.ok !== true) {
    const detail = typeof payload.error === "string" && payload.error ? payload.error : "未知错误";
    throw new Error(`语音识别失败：${detail}`);
  }
  if (!Array.isArray(payload.segments)) throw new Error("语音识别结果缺少分段");
  return payload;
}

function pythonEnv(env, modelPath) {
  const result = {
    PATH: env.PATH ?? "",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
  if (process.platform === "win32") result.SystemRoot = env.SystemRoot ?? "C:\\Windows";
  if (modelPath) result.HF_HUB_OFFLINE = "1";
  if (env.HF_ENDPOINT) result.HF_ENDPOINT = env.HF_ENDPOINT;
  if (env.ALLROUND_AI_WHISPER_CACHE) result.ALLROUND_AI_WHISPER_CACHE = env.ALLROUND_AI_WHISPER_CACHE;
  return result;
}

export function createPythonRunner() {
  return function runPython({ command, args, input, timeoutMs = 600_000, cwd, env } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, windowsHide: true, env: env ?? process.env });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("语音识别超时"));
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error(
          error?.code === "ENOENT"
            ? "找不到 Python，请设置 ALLROUND_AI_PYTHON 指向安装 faster-whisper 的解释器"
            : `无法启动 Python：${error.message}`,
        ));
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4_000);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0 && !stdout.trim()) {
          const detail = stderr.split(/\r?\n/u).find((line) => line.trim()) ?? `退出码 ${code}`;
          reject(new Error(`Python 进程异常退出：${detail.slice(0, 300)}`));
          return;
        }
        resolve({ stdout, stderr, code });
      });
      child.stdin.end(input ?? "");
    });
  };
}

// Availability probe: import faster-whisper once to prove the interpreter can
// actually run the sidecar, and require an explicit model directory when one is
// configured. Cached briefly so the skills panel does not spawn Python on every
// refresh.
export function createAsrProbe({
  runner,
  env = process.env,
  pythonPath,
  modelPath,
  ttlMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const python = pythonPath ?? (env.ALLROUND_AI_PYTHON?.trim() || "python");
  const model = modelPath ?? (env.ALLROUND_AI_WHISPER_MODEL?.trim() || "");
  const exec = runner ?? createPythonRunner();
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  return async function probe({ refresh = false } = {}) {
    if (!refresh && cached && now() - cachedAt < ttlMs) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      let base;
      try {
        await exec({
          command: python,
          args: ["-c", "import faster_whisper"],
          timeoutMs: 15_000,
          env: pythonEnv(env, model),
        });
        base = { available: true, reason: "", python, model };
      } catch (error) {
        base = {
          available: false,
          reason: String(error?.message ?? "无法启动 Python").slice(0, 200),
          python,
          model,
        };
      }
      if (base.available && model) {
        try {
          const info = await stat(model);
          if (!info.isDirectory()) throw new Error("不是目录");
        } catch {
          base = { ...base, available: false, reason: `模型目录不可用：${model}` };
        }
      }
      cached = { ...base, checkedAt: new Date().toISOString() };
      cachedAt = now();
      return cached;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

async function extractWav({ tools, source, wavFile, runner }) {
  try {
    await runMediaTool({
      command: tools.ffmpeg.path,
      args: [
        "-hide_banner", "-nostdin", "-y",
        "-i", source,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        wavFile,
      ],
      timeoutMs: 180_000,
      runner,
    });
  } catch (error) {
    const detail = String(error?.message ?? "未知错误").split(/\r?\n/u)[0].slice(0, 300);
    throw new Error(`提取音频失败：${detail}`);
  }
}

async function recognize({
  wavFile,
  duration,
  language,
  useVad,
  runPython,
  python,
  model,
  workerPath,
  env,
  directory,
}) {
  const timeoutMs = duration
    ? Math.min(Math.max(Math.ceil(duration * 1_500), 120_000), 2_700_000)
    : 600_000;
  const output = await runPython({
    command: python,
    args: [workerPath],
    input: JSON.stringify({
      audio: wavFile,
      model,
      language: language.code ?? "auto",
      // The reference disables VAD on short clips because it can swallow the
      // only speech; keep that guard here.
      vad: useVad,
      words: true,
    }),
    timeoutMs,
    cwd: directory,
    env: pythonEnv(env, model),
  });
  const result = parseSidecarOutput(output.stdout);
  return { result, cues: buildCues(result.segments) };
}

function countWords(segments) {
  return segments.reduce(
    (sum, segment) => sum + (Array.isArray(segment.words) ? segment.words.length : 0),
    0,
  );
}

export function createAsrHandler({
  sourceStore,
  artifactsDir,
  mediaProbe,
  runner,
  pythonRunner,
  pythonPath,
  modelPath,
  workerPath = WORKER_PATH,
  env = process.env,
} = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("语音转字幕需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }
  if (typeof mediaProbe !== "function") throw new TypeError("语音转字幕需要媒体工具探测");
  const python = pythonPath ?? (env.ALLROUND_AI_PYTHON?.trim() || "python");
  const model = modelPath ?? (env.ALLROUND_AI_WHISPER_MODEL?.trim() || "");
  const runPython = pythonRunner ?? createPythonRunner();

  return Object.freeze({
    "media.transcribe": async ({ run, params }) => {
      const tools = await mediaProbe();
      if (!tools?.ffmpeg?.available || !tools?.ffprobe?.available) {
        throw new Error("未检测到 FFmpeg/ffprobe，请安装后重试（或设置 FFMPEG_PATH/FFPROBE_PATH）");
      }
      const language = ASR_LANGUAGES[params.language ?? "auto"];
      if (!language) throw new Error("识别语言无效");
      const roots = (await sourceStore.list()).roots;
      const source = await resolveAllowedFile(params.source, roots);

      let media;
      try {
        media = await probeMediaFile({ ffprobePath: tools.ffprobe.path, filePath: source, runner });
      } catch (error) {
        throw new Error(`无法读取媒体信息：${error.message}`);
      }
      if (!media.audio) throw new Error("源文件没有音频轨");
      if (media.duration && media.duration > ASR_LIMITS.maxSeconds) {
        throw new Error(`音频超过 ${ASR_LIMITS.maxSeconds / 60} 分钟，请先切分`);
      }

      const directory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(directory, { recursive: true });
      const wavFile = path.join(directory, "audio.wav");
      const srtFile = path.join(directory, "captions.srt");
      const transcriptFile = path.join(directory, "transcript.json");
      await Promise.all([srtFile, transcriptFile, wavFile].map((file) => rm(file, { force: true }).catch(() => {})));

      let result;
      let cues;
      try {
        await extractWav({ tools, source, wavFile, runner });
        ({ result, cues } = await recognize({
          wavFile,
          duration: media.duration,
          language,
          useVad: params.vad !== false && (!media.duration || media.duration >= 15),
          runPython,
          python,
          model,
          workerPath,
          env,
          directory,
        }));
      } catch (error) {
        await Promise.all([wavFile, srtFile, transcriptFile].map((file) => rm(file, { force: true }).catch(() => {})));
        throw error;
      }

      if (!cues.length) {
        await rm(wavFile, { force: true }).catch(() => {});
        throw new Error("没有识别出可用的字幕（音频可能是静音）");
      }
      const srt = formatSrt(cues);
      const wordCount = countWords(result.segments);
      const transcript = {
        engine: result.engine ?? null,
        language: result.language ?? language.code ?? "auto",
        language_probability: result.language_probability ?? null,
        duration: result.duration ?? media.duration ?? null,
        elapsed: result.elapsed ?? null,
        words: wordCount,
        cues,
        segments: result.segments,
        source,
      };
      const transcriptText = `${JSON.stringify(transcript, null, 2)}\n`;
      try {
        await writeFile(srtFile, srt, { encoding: "utf8", mode: 0o600 });
        await writeFile(transcriptFile, transcriptText, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        await Promise.all([wavFile, srtFile, transcriptFile].map((file) => rm(file, { force: true }).catch(() => {})));
        throw new Error(`写入字幕产物失败：${error.message}`);
      }
      // The WAV is only an input for the sidecar; keep the artifact folder to
      // the two products an operator actually needs.
      await rm(wavFile, { force: true }).catch(() => {});

      return {
        artifacts: [
          { slot: "subtitles", label: "字幕（SRT）", path: srtFile, bytes: Buffer.byteLength(srt, "utf8") },
          {
            slot: "transcript",
            label: "识别稿（JSON）",
            path: transcriptFile,
            bytes: Buffer.byteLength(transcriptText, "utf8"),
          },
        ],
        logs: [
          `源文件：${path.basename(source)}，时长 ${durationText(media.duration ?? result.duration)}`,
          `识别：${result.engine ?? "faster-whisper"}，语言 ${transcript.language}，${cues.length} 条字幕`,
          `用时 ${result.elapsed ?? "?"} 秒；SRT ${Buffer.byteLength(srt, "utf8")} B`,
        ],
      };
    },
  });
}

export const ASR_BATCH_LIMITS = Object.freeze({ files: 12 });

// Batch mode: scan one allowed directory, transcribe what actually has an audio
// track and keep going when a single file fails. One broken file must not throw
// away the subtitles already produced for the others; the run only fails when
// nothing succeeded.
export function createAsrBatchHandler({
  sourceStore,
  artifactsDir,
  mediaProbe,
  runner,
  pythonRunner,
  pythonPath,
  modelPath,
  workerPath = WORKER_PATH,
  env = process.env,
} = {}) {
  if (!sourceStore || typeof sourceStore.list !== "function") {
    throw new TypeError("批量转字幕需要来源配置");
  }
  if (typeof artifactsDir !== "string" || !path.isAbsolute(artifactsDir)) {
    throw new TypeError("产物目录必须是绝对路径");
  }
  if (typeof mediaProbe !== "function") throw new TypeError("批量转字幕需要媒体工具探测");
  const python = pythonPath ?? (env.ALLROUND_AI_PYTHON?.trim() || "python");
  const model = modelPath ?? (env.ALLROUND_AI_WHISPER_MODEL?.trim() || "");
  const runPython = pythonRunner ?? createPythonRunner();

  return Object.freeze({
    "media.transcribe-batch": async ({ run, params }) => {
      const tools = await mediaProbe();
      if (!tools?.ffmpeg?.available || !tools?.ffprobe?.available) {
        throw new Error("未检测到 FFmpeg/ffprobe，请安装后重试（或设置 FFMPEG_PATH/FFPROBE_PATH）");
      }
      const language = ASR_LANGUAGES[params.language ?? "auto"];
      if (!language) throw new Error("识别语言无效");
      const requested = Number(params.maxFiles ?? 5);
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > ASR_BATCH_LIMITS.files) {
        throw new Error(`文件数必须是 1 到 ${ASR_BATCH_LIMITS.files} 之间的整数`);
      }

      const roots = (await sourceStore.list()).roots;
      const root = await resolveScoutRoot(params.root, roots);
      const [videos, audios] = await Promise.all([
        scanMediaDirectory({ root, kinds: "video", maxFiles: requested }),
        scanMediaDirectory({ root, kinds: "audio", maxFiles: requested }),
      ]);
      const candidates = [...videos.files, ...audios.files]
        .filter((entry) => ["audio", "video"].includes(entry.kind ?? mediaKindOf(entry.path)))
        .sort((left, right) => left.path.localeCompare(right.path))
        .slice(0, requested);
      if (!candidates.length) throw new Error("目录里没有音频或视频文件");

      const baseDirectory = path.join(artifactsDir, safeRunName(run.id));
      await mkdir(baseDirectory, { recursive: true });
      const startedAt = Date.now();
      const results = [];
      const artifacts = [];

      for (const [index, entry] of candidates.entries()) {
        const label = path.basename(entry.path);
        const source = await resolveAllowedFile(path.join(root, ...entry.path.split("/")), roots);
        let media;
        try {
          media = await probeMediaFile({ ffprobePath: tools.ffprobe.path, filePath: source, runner });
        } catch (error) {
          results.push({ name: label, path: entry.path, status: "failed", error: `无法读取媒体信息：${error.message}` });
          continue;
        }
        if (!media.audio) {
          results.push({ name: label, path: entry.path, status: "skipped", error: "没有音频轨" });
          continue;
        }

        const stem = path.basename(entry.path, path.extname(entry.path))
          .replace(/[^\p{L}\p{N}_-]+/gu, "_")
          .slice(0, 40) || "clip";
        const directory = path.join(baseDirectory, `${String(index + 1).padStart(2, "0")}-${stem}`);
        const wavFile = path.join(directory, "audio.wav");
        const srtFile = path.join(directory, "captions.srt");
        await mkdir(directory, { recursive: true });
        await Promise.all([wavFile, srtFile].map((file) => rm(file, { force: true }).catch(() => {})));

        try {
          await extractWav({ tools, source, wavFile, runner });
          const { result, cues } = await recognize({
            wavFile,
            duration: media.duration,
            language,
            useVad: params.vad !== false && (!media.duration || media.duration >= 15),
            runPython,
            python,
            model,
            workerPath,
            env,
            directory,
          });
          if (!cues.length) throw new Error("没有识别出可用的字幕（音频可能是静音）");
          const srt = formatSrt(cues);
          await writeFile(srtFile, srt, { encoding: "utf8", mode: 0o600 });
          await rm(wavFile, { force: true }).catch(() => {});
          artifacts.push({
            slot: `subtitles-${index + 1}`,
            label: `字幕：${label}`,
            path: srtFile,
            bytes: Buffer.byteLength(srt, "utf8"),
          });
          results.push({
            name: label,
            path: entry.path,
            status: "ok",
            seconds: Number((media.duration ?? result.duration ?? 0).toFixed(2)),
            cues: cues.length,
            language: result.language ?? null,
            engine: result.engine ?? null,
            words: countWords(result.segments),
            segments: result.segments,
          });
        } catch (error) {
          await Promise.all([wavFile, srtFile].map((file) => rm(file, { force: true }).catch(() => {})));
          results.push({
            name: label,
            path: entry.path,
            status: "failed",
            error: String(error?.message ?? "未知错误").slice(0, 300),
          });
        }
      }

      const ok = results.filter((entry) => entry.status === "ok");
      if (!ok.length) {
        const detail = results.map((entry) => `${entry.name}：${entry.error}`).join("；").slice(0, 300);
        throw new Error(`没有任何文件识别成功（${detail}）`);
      }

      const summary = {
        root,
        language: params.language ?? "auto",
        files: results,
        counts: {
          ok: ok.length,
          skipped: results.filter((entry) => entry.status === "skipped").length,
          failed: results.filter((entry) => entry.status === "failed").length,
        },
        totalCues: ok.reduce((sum, entry) => sum + entry.cues, 0),
        elapsed: Number(((Date.now() - startedAt) / 1_000).toFixed(1)),
      };
      const reportJson = path.join(baseDirectory, "batch-report.json");
      const reportMarkdown = path.join(baseDirectory, "batch-report.md");
      const jsonText = `${JSON.stringify(summary, null, 2)}\n`;
      const lines = [
        "# 批量转字幕报告",
        "",
        `- 目录：${root}`,
        `- 结果：成功 ${summary.counts.ok}、跳过 ${summary.counts.skipped}、失败 ${summary.counts.failed}`,
        `- 合计字幕：${summary.totalCues} 条；用时 ${summary.elapsed} 秒`,
        "",
        "| 文件 | 状态 | 时长 | 字幕 | 说明 |",
        "| --- | --- | --- | --- | --- |",
        ...results.map((entry) => `| ${entry.path} | ${entry.status} | `
          + `${entry.seconds === undefined ? "-" : `${entry.seconds} 秒`} | `
          + `${entry.cues ?? "-"} | ${entry.error ?? ""} |`),
        "",
      ];
      const markdownText = lines.join("\n");
      try {
        await writeFile(reportJson, jsonText, { encoding: "utf8", mode: 0o600 });
        await writeFile(reportMarkdown, markdownText, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        throw new Error(`写入批量报告失败：${error.message}`);
      }
      artifacts.push(
        {
          slot: "report-json",
          label: "批量报告（JSON）",
          path: reportJson,
          bytes: Buffer.byteLength(jsonText, "utf8"),
        },
        {
          slot: "report-markdown",
          label: "批量报告（Markdown）",
          path: reportMarkdown,
          bytes: Buffer.byteLength(markdownText, "utf8"),
        },
      );

      return {
        artifacts,
        logs: [
          `目录：${root}，处理 ${results.length} 个文件`,
          `成功 ${summary.counts.ok}、跳过 ${summary.counts.skipped}、失败 ${summary.counts.failed}；合计 ${summary.totalCues} 条字幕`,
          `用时 ${summary.elapsed} 秒`,
        ],
      };
    },
  });
}

