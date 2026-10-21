import { randomBytes } from "node:crypto";

import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Automation pipelines.
//
// A pipeline is a frozen list of steps. A run is a persisted snapshot of the
// definition plus per-step state, so a later deployment cannot insert work into
// a run that already started. Two runners exist today:
//   app    -> a registered handler runs in-process and may produce artifacts
//   manual -> the run waits until an operator confirms the step
// Runs are bounded, survive restarts and are advanced one step at a time.
// ---------------------------------------------------------------------------

export const AUTOMATION_MAX_RUNS = 50;
export const AUTOMATION_LIST_LIMIT = 20;
export const DEFAULT_MAX_RUNNING = 2;
export const RUN_STATUSES = Object.freeze(["running", "waiting_manual", "done", "failed", "cancelled"]);
export const STEP_STATUSES = Object.freeze(["pending", "running", "waiting_manual", "done", "failed", "skipped"]);
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const DONE_LIKE = new Set(["done", "skipped"]);
const MAX_STEP_ARTIFACTS = 20;
const MAX_STEP_LOGS = 50;
const MAX_LOG_LENGTH = 500;

export class AutomationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
    this.status = status;
  }
}

export const AUTOMATION_PIPELINES = Object.freeze([
  {
    id: "knowledge-brief",
    name: "知识简报",
    desc: "读取当前项目的知识卡、缺口与回归结果，生成一份 Markdown 简报；人工确认后本次运行结束。",
    steps: [
      {
        id: "snapshot",
        name: "读取知识现状",
        desc: "把知识卡、缺口与统计落成一份快照，后续步骤只读这份快照。",
        runner: "app",
        action: "knowledge.snapshot",
        outputs: [{ slot: "snapshot", label: "知识快照" }],
        params: [
          {
            key: "maxCards",
            label: "最多纳入知识卡",
            type: "number",
            default: 20,
            min: 1,
            max: 100,
            hint: "超出部分仍留在知识库，简报只取最新的这些",
          },
          {
            key: "includeGaps",
            label: "纳入未关闭缺口",
            type: "toggle",
            default: true,
          },
        ],
      },
      {
        id: "brief",
        name: "生成简报",
        desc: "把快照整理成可读的 Markdown，列出确认过的知识、待确认项与未关闭的缺口。",
        runner: "app",
        action: "knowledge.brief",
        after: ["snapshot"],
        outputs: [{ slot: "brief", label: "知识简报" }],
        params: [
          {
            key: "title",
            label: "简报标题",
            type: "text",
            default: "",
            maxLength: 80,
            hint: "留空使用项目 id",
          },
        ],
      },
      {
        id: "review",
        name: "人工确认",
        desc: "打开简报核对内容，确认后结束本次运行。",
        runner: "manual",
        after: ["brief"],
        manualHint: "打开简报核对后点击「我做完了」",
      },
    ],
  },
  {
    id: "script-draft",
    name: "口播脚本草稿",
    desc: "按主题、受众与目标时长起草口播脚本，只引用已确认知识；草稿必须人工确认后才算完成。",
    steps: [
      {
        id: "draft",
        name: "起草脚本",
        runner: "app",
        desc: "把主题、受众、时长与已确认知识交给当前 AI 引擎，产出按镜头分行的草稿。",
        action: "ai.script-draft",
        outputs: [{ slot: "script", label: "脚本草稿" }],
        params: [
          { key: "topic", label: "主题", type: "text", required: true, maxLength: 120 },
          {
            key: "audience",
            label: "受众",
            type: "select",
            default: "boss",
            options: [
              { value: "boss", label: "企业老板" },
              { value: "switcher", label: "转型者" },
              { value: "operator", label: "操盘手" },
            ],
          },
          { key: "durationSec", label: "目标时长（秒）", type: "number", default: 60, min: 15, max: 300 },
          {
            key: "tone",
            label: "语气",
            type: "select",
            default: "sincere",
            options: [
              { value: "sincere", label: "真诚克制" },
              { value: "sharp", label: "直接犀利" },
              { value: "warm", label: "温和陪伴" },
            ],
          },
          { key: "maxCards", label: "最多引用知识卡", type: "number", default: 5, min: 0, max: 20 },
        ],
      },
      {
        id: "review",
        name: "人工确认",
        runner: "manual",
        desc: "读一遍脚本，确认事实与语气后结束本次运行。",
        after: ["draft"],
        manualHint: "读完脚本并核对事实后点击「我做完了」",
      },
    ],
  },
  {
    id: "topic-pack",
    name: "选题提案",
    desc: "按受众与数量从已确认知识里提炼可拍选题，写明角度与依据；没有依据的选题必须标成待补知识。",
    steps: [
      {
        id: "topics",
        name: "提炼选题",
        runner: "app",
        desc: "只读取已确认知识，让当前 AI 引擎产出选题清单，不写脚本正文。",
        action: "ai.topic-pack",
        outputs: [{ slot: "topics", label: "选题清单" }],
        params: [
          { key: "count", label: "选题数量", type: "number", default: 5, min: 1, max: 10 },
          {
            key: "audience",
            label: "受众",
            type: "select",
            default: "boss",
            options: [
              { value: "boss", label: "企业老板" },
              { value: "switcher", label: "转型者" },
              { value: "operator", label: "操盘手" },
            ],
          },
          {
            key: "focus",
            label: "聚焦方向",
            type: "text",
            default: "",
            maxLength: 80,
            hint: "留空表示不限",
          },
          { key: "maxCards", label: "最多引用知识卡", type: "number", default: 10, min: 0, max: 20 },
        ],
      },
      {
        id: "review",
        name: "人工确认",
        runner: "manual",
        desc: "挑出要开拍的选题后结束本次运行。",
        after: ["topics"],
        manualHint: "挑出要开拍的选题后点击「我做完了」",
      },
    ],
  },
  {
    id: "script-rewrite",
    name: "口播改写",
    desc: "把已有草稿改写成可拍口播：保留原稿事实，按目标时长与语气重写，并核对已确认知识。",
    steps: [
      {
        id: "rewrite",
        name: "改写脚本",
        runner: "app",
        desc: "原稿与已确认知识一起交给当前 AI 引擎，产出按镜头分行的改写稿。",
        action: "ai.script-rewrite",
        outputs: [{ slot: "rewrite", label: "改写稿" }],
        params: [
          {
            key: "draft",
            label: "原始草稿",
            type: "text",
            required: true,
            maxLength: 4000,
            multiline: true,
            hint: "粘贴待改写的整段口播稿",
          },
          {
            key: "audience",
            label: "受众",
            type: "select",
            default: "boss",
            options: [
              { value: "boss", label: "企业老板" },
              { value: "switcher", label: "转型者" },
              { value: "operator", label: "操盘手" },
            ],
          },
          { key: "durationSec", label: "目标时长（秒）", type: "number", default: 60, min: 15, max: 300 },
          {
            key: "tone",
            label: "语气",
            type: "select",
            default: "sincere",
            options: [
              { value: "sincere", label: "真诚克制" },
              { value: "sharp", label: "直接犀利" },
              { value: "warm", label: "温和陪伴" },
            ],
          },
          { key: "maxCards", label: "最多引用知识卡", type: "number", default: 5, min: 0, max: 20 },
        ],
      },
      {
        id: "review",
        name: "人工确认",
        runner: "manual",
        desc: "核对事实与数字后结束本次运行。",
        after: ["rewrite"],
        manualHint: "核对事实与数字后点击「我做完了」",
      },
    ],
  },
  {
    id: "media-inventory",
    name: "媒体素材清单",
    desc: "扫描来源白名单里的一个目录，列出视频 / 音频 / 图片与大小，供后续影音产线选材；不调用 FFmpeg。",
    steps: [
      {
        id: "scan",
        name: "扫描素材",
        runner: "app",
        desc: "只读取「来源配置」已允许的目录，按类型收集文件并写成 Markdown 清单。",
        action: "media.inventory",
        outputs: [{ slot: "inventory", label: "素材清单" }],
        params: [
          {
            key: "root",
            label: "素材目录",
            type: "text",
            required: true,
            maxLength: 400,
            hint: "必须是「来源配置」白名单内的绝对路径",
          },
          {
            key: "kinds",
            label: "素材类型",
            type: "select",
            default: "all",
            options: [
              { value: "all", label: "全部媒体" },
              { value: "video", label: "只要视频" },
              { value: "audio", label: "只要音频" },
              { value: "image", label: "只要图片" },
            ],
          },
          {
            key: "maxFiles",
            label: "最多保留",
            type: "number",
            default: 50,
            min: 1,
            max: 200,
            hint: "按目录顺序收集，达到上限后标记截断",
          },
        ],
      },
      {
        id: "review",
        name: "人工确认",
        runner: "manual",
        desc: "挑出要进入制作的文件后结束本次运行。",
        after: ["scan"],
        manualHint: "核对清单后点击「我做完了」",
      },
    ],
  },
  {
    id: "audio-extract",
    name: "音频提取",
    desc: "从来源白名单内的视频或音频文件提取一条音频轨，输出 M4A / MP3 / WAV，供后续播客与成片使用。",
    steps: [
      {
        id: "extract",
        name: "提取音频",
        runner: "app",
        desc: "先用 ffprobe 读取时长与音频参数，再调用 FFmpeg 转码；没有音频轨会直接失败。",
        action: "media.extract-audio",
        outputs: [{ slot: "audio", label: "音频文件" }],
        params: [
          {
            key: "source",
            label: "源文件",
            type: "text",
            required: true,
            maxLength: 400,
            hint: "必须是「来源配置」白名单内的绝对路径",
          },
          {
            key: "format",
            label: "输出格式",
            type: "select",
            default: "m4a",
            options: [
              { value: "m4a", label: "M4A（AAC 192k）" },
              { value: "mp3", label: "MP3（LAME 192k）" },
              { value: "wav", label: "WAV（PCM 16-bit）" },
            ],
          },
        ],
      },
      {
        id: "review",
        name: "人工确认",
        runner: "manual",
        desc: "试听提取结果后结束本次运行。",
        after: ["extract"],
        manualHint: "试听音频后点击「我做完了」",
      },
    ],
  },
  {
    id: "video-normalize",
    name: "视频规格化",
    desc: "把来源白名单内的视频统一成 H.264 / AAC 的 MP4，可选抽一帧作为封面，供分发与成片使用。",
    steps: [
      {
        id: "normalize",
        name: "规格化视频",
        runner: "app",
        desc: "先用 ffprobe 读取分辨率与时长，再按目标高度缩放并转码，不放大原片。",
        action: "media.normalize-video",
        outputs: [
          { slot: "video", label: "规格化视频" },
          { slot: "cover", label: "封面图" },
        ],
        params: [
          {
            key: "source",
            label: "源文件",
            type: "text",
            required: true,
            maxLength: 400,
            hint: "必须是「来源配置」白名单内的绝对路径",
          },
          {
            key: "height",
            label: "目标高度",
            type: "select",
            default: "1080",
            options: [
              { value: "1080", label: "1080p" },
              { value: "720", label: "720p" },
              { value: "540", label: "540p" },
              { value: "360", label: "360p" },
            ],
            hint: "只缩小不放大；宽度按原比例自动取偶数",
          },
          {
            key: "cover",
            label: "抽取封面",
            type: "toggle",
            default: true,
            hint: "取视频约 1 秒处的一帧，输出 JPEG",
          },
        ],
      },
      {
        id: "review",
        name: "人工确认",
        runner: "manual",
        desc: "预览视频与封面后结束本次运行。",
        after: ["normalize"],
        manualHint: "预览画面与封面后点击「我做完了」",
      },
    ],
  },
  {
    id: "video-reframe",
    name: "多规格转码",
    desc: "把来源白名单内的视频转成横屏 16:9、竖屏 9:16、方屏 1:1 三种平台规格，按比例缩放并补边，不裁切画面。",
    steps: [
      {
        id: "reframe",
        name: "转平台规格",
        runner: "app",
        desc: "按所选规格逐个转码；画面等比缩放后居中补黑边，宽高取平台标准尺寸。",
        action: "media.reframe-video",
        outputs: [
          { slot: "landscape", label: "横屏 16:9" },
          { slot: "vertical", label: "竖屏 9:16" },
          { slot: "square", label: "方屏 1:1" },
        ],
        params: [
          {
            key: "source",
            label: "源文件",
            type: "text",
            required: true,
            maxLength: 400,
            hint: "必须是「来源配置」白名单内的绝对路径",
          },
          {
            key: "quality",
            label: "输出规格",
            type: "select",
            default: "720",
            options: [
              { value: "1080", label: "1080 档（1920×1080 / 1080×1920 / 1080×1080）" },
              { value: "720", label: "720 档（1280×720 / 720×1280 / 720×720）" },
              { value: "540", label: "540 档（960×540 / 540×960 / 540×540）" },
            ],
            hint: "平台规格是固定画布，小尺寸源会被放大并补边",
          },
          {
            key: "landscape",
            label: "横屏 16:9",
            type: "toggle",
            default: true,
          },
          {
            key: "vertical",
            label: "竖屏 9:16",
            type: "toggle",
            default: true,
          },
          {
            key: "square",
            label: "方屏 1:1",
            type: "toggle",
            default: false,
          },
        ],
      },
      {
        id: "review",
        name: "人工确认",
        runner: "manual",
        desc: "逐个预览输出规格后结束本次运行。",
        after: ["reframe"],
        manualHint: "确认各规格画面无裁切后点击「我做完了」",
      },
    ],
  },
  {
    id: "video-subtitle",
    name: "字幕封装",
    desc: "把 SRT 字幕压进 MP4 变为可开关的字幕轨，画面与音轨原样保留，同时留下 SRT 文件。",
    steps: [
      {
        id: "mux",
        name: "封装字幕",
        runner: "app",
        desc: "校验 SRT 时间码与顺序，复制原视频与音轨，只把字幕编码成 mov_text。",
        action: "media.mux-subtitles",
        outputs: [
          { slot: "video", label: "字幕视频" },
          { slot: "subtitles", label: "字幕文件" },
        ],
        params: [
          {
            key: "source",
            label: "源文件",
            type: "text",
            required: true,
            maxLength: 400,
            hint: "必须是「来源配置」白名单内的绝对路径",
          },
          {
            key: "subtitles",
            label: "SRT 字幕",
            type: "text",
            multiline: true,
            required: true,
            maxLength: 8000,
            hint: "格式：序号（可省略）／00:00:01,000 --> 00:00:03,000／字幕文字，空行分隔",
          },
        ],
      },
      {
        id: "review",
        name: "人工确认",
        runner: "manual",
        desc: "播放字幕轨并核对时间轴后结束本次运行。",
        after: ["mux"],
        manualHint: "核对字幕时间轴后点击「我做完了」",
      },
    ],
  },
]);

function fail(message) {
  throw new TypeError(message);
}

const PARAM_TYPES = new Set(["text", "number", "toggle", "select"]);

// Params are declared once in the definition and stored per run, so a later
// change to the definition cannot rewrite what a finished run was asked for.
function coerceParam(definition, value) {
  const label = definition.label || definition.key;
  if (definition.type === "toggle") {
    if (value === undefined || value === null) return definition.default === true;
    if (typeof value !== "boolean") throw new AutomationError("BAD_PARAM", `${label}必须是开关值`);
    return value;
  }
  if (definition.type === "number") {
    if (value === undefined || value === null || value === "") return definition.default;
    const number = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(number)) throw new AutomationError("BAD_PARAM", `${label}必须是数字`);
    if (definition.min !== undefined && number < definition.min) {
      throw new AutomationError("BAD_PARAM", `${label}不能小于 ${definition.min}`);
    }
    if (definition.max !== undefined && number > definition.max) {
      throw new AutomationError("BAD_PARAM", `${label}不能大于 ${definition.max}`);
    }
    return number;
  }
  if (definition.type === "select") {
    const raw = value === undefined || value === null || value === "" ? definition.default : value;
    if (typeof raw !== "string" || !definition.options.some((option) => option.value === raw)) {
      throw new AutomationError("BAD_PARAM", `${label}选项无效`);
    }
    return raw;
  }
  if (value === undefined || value === null) {
    const fallback = definition.default ?? "";
    if (definition.required && String(fallback).trim() === "") {
      throw new AutomationError("BAD_PARAM", `${label}不能为空`);
    }
    return fallback;
  }
  if (typeof value !== "string") throw new AutomationError("BAD_PARAM", `${label}必须是文本`);
  const text = value.trim();
  const maxLength = definition.maxLength ?? 200;
  if (text.length > maxLength) throw new AutomationError("BAD_PARAM", `${label}不能超过 ${maxLength} 个字符`);
  if (definition.required && text === "") throw new AutomationError("BAD_PARAM", `${label}不能为空`);
  return text;
}

function validateParam(param, stepId, keys) {
  if (!param || typeof param !== "object") fail(`步骤 ${stepId} 的参数必须是对象`);
  if (typeof param.key !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/u.test(param.key)) {
    fail(`步骤 ${stepId} 的参数 key 无效`);
  }
  if (keys.has(param.key)) fail(`步骤 ${stepId} 的参数 key 重复：${param.key}`);
  keys.add(param.key);
  if (!PARAM_TYPES.has(param.type)) fail(`步骤 ${stepId} 的参数 ${param.key} 类型无效`);
  if (typeof param.label !== "string" || param.label.trim() === "") {
    fail(`步骤 ${stepId} 的参数 ${param.key} 缺少名称`);
  }
  if (param.type === "select") {
    if (!Array.isArray(param.options) || param.options.length === 0
      || param.options.some((option) => typeof option?.value !== "string" || typeof option?.label !== "string")) {
      fail(`步骤 ${stepId} 的参数 ${param.key} 选项无效`);
    }
  }
  if (param.multiline !== undefined
    && (param.type !== "text" || typeof param.multiline !== "boolean")) {
    fail(`步骤 ${stepId} 的参数 ${param.key} 的多行标记无效`);
  }
  if (param.type === "number") {
    for (const bound of ["min", "max"]) {
      if (param[bound] !== undefined && !Number.isFinite(param[bound])) {
        fail(`步骤 ${stepId} 的参数 ${param.key} 的 ${bound} 无效`);
      }
    }
    if (param.min !== undefined && param.max !== undefined && param.min > param.max) {
      fail(`步骤 ${stepId} 的参数 ${param.key} 范围无效`);
    }
  }
  if (param.maxLength !== undefined
    && (!Number.isSafeInteger(param.maxLength) || param.maxLength < 1 || param.maxLength > 8_000)) {
    fail(`步骤 ${stepId} 的参数 ${param.key} 长度上限无效`);
  }
  if (param.default !== undefined) {
    try {
      coerceParam(param, param.default);
    } catch (error) {
      fail(`步骤 ${stepId} 的参数 ${param.key} 默认值无效：${error.message}`);
    }
  }
}

function validateStep(step, index, seen) {
  if (!step || typeof step !== "object") fail("步骤必须是对象");
  if (typeof step.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(step.id)) fail("步骤 id 无效");
  if (seen.has(step.id)) fail(`步骤 id 重复：${step.id}`);
  seen.add(step.id);
  if (typeof step.name !== "string" || step.name.trim() === "") fail(`步骤 ${step.id} 缺少名称`);
  if (step.runner !== "app" && step.runner !== "manual") fail(`步骤 ${step.id} 的 runner 无效`);
  if (step.runner === "app" && (typeof step.action !== "string" || step.action.trim() === "")) {
    fail(`步骤 ${step.id} 缺少 action`);
  }
  if (step.after !== undefined) {
    if (!Array.isArray(step.after) || step.after.some((id) => typeof id !== "string")) {
      fail(`步骤 ${step.id} 的 after 必须是字符串数组`);
    }
  }
  if (step.outputs !== undefined && (!Array.isArray(step.outputs)
    || step.outputs.some((output) => typeof output?.slot !== "string" || output.slot === ""))) {
    fail(`步骤 ${step.id} 的 outputs 无效`);
  }
  if (step.params !== undefined) {
    if (!Array.isArray(step.params)) fail(`步骤 ${step.id} 的 params 必须是数组`);
    const keys = new Set();
    for (const param of step.params) validateParam(param, step.id, keys);
  }
  return index;
}

export function validatePipelines(pipelines) {
  if (!Array.isArray(pipelines) || pipelines.length === 0) fail("至少需要一条产线");
  const ids = new Set();
  for (const definition of pipelines) {
    if (typeof definition.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,59}$/u.test(definition.id)) {
      fail("产线 id 无效");
    }
    if (ids.has(definition.id)) fail(`产线 id 重复：${definition.id}`);
    ids.add(definition.id);
    if (typeof definition.name !== "string" || definition.name.trim() === "") fail(`产线 ${definition.id} 缺少名称`);
    if (definition.maxRunning !== undefined
      && (!Number.isSafeInteger(definition.maxRunning) || definition.maxRunning < 1 || definition.maxRunning > 10)) {
      fail(`产线 ${definition.id} 的并发上限无效`);
    }
    if (!Array.isArray(definition.steps) || definition.steps.length === 0) fail(`产线 ${definition.id} 没有步骤`);
    const seen = new Set();
    definition.steps.forEach((step, index) => validateStep(step, index, seen));
    const positions = new Map(definition.steps.map((step, index) => [step.id, index]));
    for (const [index, step] of definition.steps.entries()) {
      for (const dependency of step.after ?? (index === 0 ? [] : [definition.steps[index - 1].id])) {
        if (!positions.has(dependency)) fail(`步骤 ${step.id} 依赖了不存在的步骤：${dependency}`);
        if (dependency === step.id) fail(`步骤 ${step.id} 不能依赖自己`);
        if (positions.get(dependency) > index) fail(`步骤 ${step.id} 依赖了排在后面的步骤：${dependency}`);
      }
    }
  }
  return pipelines;
}

validatePipelines(AUTOMATION_PIPELINES);

export function describePipeline(definition) {
  return {
    id: definition.id,
    name: definition.name,
    desc: definition.desc,
    maxRunning: definition.maxRunning ?? DEFAULT_MAX_RUNNING,
    steps: definition.steps.map((step) => ({
      id: step.id,
      name: step.name,
      desc: step.desc,
      runner: step.runner,
      ...(step.after ? { after: [...step.after] } : {}),
      ...(step.outputs ? { outputs: step.outputs.map((output) => ({ ...output })) } : {}),
      ...(step.params ? {
        params: step.params.map((param) => ({
          key: param.key,
          label: param.label,
          type: param.type,
          ...(param.default !== undefined ? { default: param.default } : {}),
          ...(param.required ? { required: true } : {}),
          ...(param.min !== undefined ? { min: param.min } : {}),
          ...(param.max !== undefined ? { max: param.max } : {}),
          ...(param.maxLength !== undefined ? { maxLength: param.maxLength } : {}),
          ...(param.multiline ? { multiline: true } : {}),
          ...(param.options ? { options: param.options.map((option) => ({ ...option })) } : {}),
          ...(param.hint ? { hint: param.hint } : {}),
        })),
      } : {}),
      ...(step.manualHint ? { manualHint: step.manualHint } : {}),
    })),
  };
}

export function pipelineById(id, pipelines = AUTOMATION_PIPELINES) {
  return pipelines.find((definition) => definition.id === id) ?? null;
}

// Validates the operator's input against the declared params, fills defaults
// and returns one plain object per step. Unknown steps or keys are refused
// instead of being silently dropped.
export function resolveRunParams(definition, input = {}) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new AutomationError("BAD_PARAM", "参数格式无效");
  }
  const result = {};
  for (const step of definition.steps) {
    if (!step.params?.length) continue;
    const supplied = input[step.id] ?? {};
    if (typeof supplied !== "object" || Array.isArray(supplied)) {
      throw new AutomationError("BAD_PARAM", `步骤「${step.name}」的参数格式无效`);
    }
    for (const key of Object.keys(supplied)) {
      if (!step.params.some((param) => param.key === key)) {
        throw new AutomationError("BAD_PARAM", `步骤「${step.name}」没有参数 ${key}`);
      }
    }
    const values = {};
    for (const param of step.params) values[param.key] = coerceParam(param, supplied[param.key]);
    result[step.id] = values;
  }
  for (const stepId of Object.keys(input)) {
    const step = definition.steps.find((entry) => entry.id === stepId);
    if (!step || !step.params?.length) {
      throw new AutomationError("BAD_PARAM", `产线没有可配置步骤 ${stepId}`);
    }
  }
  return result;
}

function isRunLike(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.id === "string"
    && typeof value.pipelineId === "string"
    && typeof value.projectId === "string"
    && RUN_STATUSES.includes(value.status)
    && typeof value.steps === "object"
    && value.steps !== null
    && (value.params === undefined
      || (typeof value.params === "object" && value.params !== null && !Array.isArray(value.params)))
    && Object.values(value.steps).every((step) => Boolean(step)
      && typeof step === "object"
      && STEP_STATUSES.includes(step.status)
      && Array.isArray(step.artifacts)
      && Array.isArray(step.logs));
}

function emptyState() {
  return {
    status: "pending",
    startedAt: null,
    finishedAt: null,
    artifacts: [],
    logs: [],
    error: null,
    completedBy: null,
    skipReason: null,
  };
}

export function createAutomationStore({ filePath, maxRuns = AUTOMATION_MAX_RUNS } = {}) {
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) throw new TypeError("运行记录上限必须是正整数");
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: 1, runs: [] }),
    validate: (document) => {
      if (!document || typeof document !== "object" || document.version !== 1 || !Array.isArray(document.runs)) {
        throw new TypeError("自动化运行记录不可读或已损坏");
      }
      if (!document.runs.every(isRunLike)) throw new TypeError("自动化运行记录不可读或已损坏");
      return document;
    },
  });

  return Object.freeze({
    path: filePath,
    async list(limit = AUTOMATION_LIST_LIMIT) {
      const { runs } = await store.read();
      return runs.slice(-Math.max(1, limit)).reverse();
    },
    async read(id) {
      const { runs } = await store.read();
      return runs.find((run) => run.id === id) ?? null;
    },
    async save(run) {
      if (!isRunLike(run)) throw new TypeError("运行记录格式无效");
      return store.update((document) => {
        const index = document.runs.findIndex((entry) => entry.id === run.id);
        if (index >= 0) document.runs[index] = run;
        else document.runs.push(run);
        // Finished runs fall off first; an active run is never evicted unless
        // the cap itself is smaller than the number of active runs.
        while (document.runs.length > maxRuns) {
          const removable = document.runs.findIndex((entry) => TERMINAL.has(entry.status));
          document.runs.splice(removable >= 0 ? removable : 0, 1);
        }
        return run;
      });
    },
  });
}

function cleanArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts
    .filter((artifact) => artifact && typeof artifact === "object")
    .slice(0, MAX_STEP_ARTIFACTS)
    .map((artifact) => ({
      slot: String(artifact.slot ?? "").slice(0, 60),
      label: String(artifact.label ?? artifact.slot ?? "").slice(0, 120),
      path: String(artifact.path ?? "").slice(0, 4096),
      ...(Number.isSafeInteger(artifact.bytes) ? { bytes: artifact.bytes } : {}),
    }))
    .filter((artifact) => artifact.slot !== "" && artifact.path !== "");
}

function cleanLogs(logs) {
  if (!Array.isArray(logs)) return [];
  return logs
    .filter((line) => typeof line === "string")
    .slice(0, MAX_STEP_LOGS)
    .map((line) => line.slice(0, MAX_LOG_LENGTH));
}

function dependenciesOf(definition, step, index) {
  return step.after ?? (index === 0 ? [] : [definition.steps[index - 1].id]);
}

function pickReady(run, definition) {
  for (const [index, step] of definition.steps.entries()) {
    const state = run.steps[step.id];
    if (!state || state.status !== "pending") continue;
    const ready = dependenciesOf(definition, step, index).every((id) => DONE_LIKE.has(run.steps[id]?.status));
    if (ready) return step;
  }
  return null;
}

function settle(run, definition) {
  const statuses = definition.steps.map((step) => run.steps[step.id]?.status);
  if (statuses.every((status) => DONE_LIKE.has(status))) {
    run.status = "done";
    run.currentStep = null;
    run.finishedAt = run.updatedAt;
  }
}

export function createAutomationEngine({
  store,
  handlers = {},
  pipelines = AUTOMATION_PIPELINES,
  now = () => new Date(),
  generateId = () => `run_${randomBytes(8).toString("hex")}`,
} = {}) {
  if (!store || typeof store.save !== "function" || typeof store.read !== "function") {
    throw new TypeError("自动化引擎需要运行记录存储");
  }
  validatePipelines(pipelines);
  const definitions = new Map(pipelines.map((definition) => [definition.id, definition]));
  const locks = new Map();
  const iso = () => now().toISOString();

  // One advance at a time per run: a double click or a boot resume must not
  // execute the same step twice.
  function withLock(id, task) {
    const previous = locks.get(id) ?? Promise.resolve();
    const running = previous.catch(() => {}).then(task);
    locks.set(id, running);
    return running.finally(() => {
      if (locks.get(id) === running) locks.delete(id);
    });
  }

  async function advance(run, definition) {
    while (!TERMINAL.has(run.status)) {
      const step = pickReady(run, definition);
      if (!step) break;
      const state = run.steps[step.id];
      if (step.runner === "manual") {
        state.status = "waiting_manual";
        state.startedAt ??= iso();
        run.status = "waiting_manual";
        run.currentStep = step.id;
        run.updatedAt = iso();
        await store.save(run);
        return run;
      }
      state.status = "running";
      state.startedAt = iso();
      state.error = null;
      run.currentStep = step.id;
      run.updatedAt = iso();
      await store.save(run);
      try {
        const handler = handlers[step.action];
        if (typeof handler !== "function") throw new Error(`没有注册的步骤处理器：${step.action}`);
        const outcome = await handler({ run, step, definition, params: run.params?.[step.id] ?? {} }) ?? {};
        state.status = "done";
        state.finishedAt = iso();
        state.artifacts = cleanArtifacts(outcome.artifacts);
        state.logs = cleanLogs(outcome.logs);
      } catch (error) {
        state.status = "failed";
        state.finishedAt = iso();
        state.error = error.message || "步骤执行失败";
        run.status = "failed";
        run.error = `${step.name}：${state.error}`;
        run.finishedAt = state.finishedAt;
        run.currentStep = null;
        run.updatedAt = state.finishedAt;
        await store.save(run);
        return run;
      }
      run.updatedAt = iso();
      await store.save(run);
    }
    settle(run, definition);
    if (run.status === "running") {
      // Nothing is runnable and the run is not complete; failing loudly beats
      // leaving a run that would never move again.
      run.status = "failed";
      run.error = "步骤依赖无法满足";
      run.currentStep = null;
      run.finishedAt = iso();
      run.updatedAt = run.finishedAt;
    }
    await store.save(run);
    return run;
  }

  async function requireRun(id) {
    const run = await store.read(id);
    if (!run) throw new AutomationError("NOT_FOUND", "运行不存在", 404);
    const definition = definitions.get(run.pipelineId);
    if (!definition) throw new AutomationError("UNKNOWN_PIPELINE", "这条产线的定义已不存在", 409);
    return { run, definition };
  }

  return Object.freeze({
    async start({ pipelineId, projectId, actor = null, params = {} } = {}) {
      const definition = definitions.get(pipelineId);
      if (!definition) throw new AutomationError("UNKNOWN_PIPELINE", "没有这条产线");
      if (typeof projectId !== "string" || projectId.trim() === "") {
        throw new AutomationError("BAD_PROJECT", "请先选择项目");
      }
      const resolvedParams = resolveRunParams(definition, params);
      const limit = definition.maxRunning ?? DEFAULT_MAX_RUNNING;
      const project = projectId.trim();
      // Two operators clicking at once must not both slip past the limit, so the
      // count and the insert share one lock per pipeline and project.
      return withLock(`start:${pipelineId}:${project}`, async () => {
        const active = (await store.list(AUTOMATION_MAX_RUNS)).filter((entry) => (
          entry.pipelineId === pipelineId
          && entry.projectId === project
          && !TERMINAL.has(entry.status)
        ));
        if (active.length >= limit) {
          throw new AutomationError(
            "RUNNING_LIMIT",
            `这条产线已有 ${active.length} 个未结束的运行，最多同时 ${limit} 个`,
            409,
          );
        }
        const at = iso();
        const run = {
          id: generateId(),
          pipelineId,
          projectId: project,
          status: "running",
          createdAt: at,
          updatedAt: at,
          finishedAt: null,
          currentStep: null,
          startedBy: typeof actor === "string" ? actor.slice(0, 200) : null,
          params: resolvedParams,
          definition: describePipeline(definition),
          steps: Object.fromEntries(definition.steps.map((step) => [step.id, emptyState()])),
          error: null,
        };
        await store.save(run);
        return withLock(run.id, () => advance(run, definition));
      });
    },

    async completeManual({ runId, stepId, actor = null } = {}) {
      return withLock(runId, async () => {
        const { run, definition } = await requireRun(runId);
        if (run.status !== "waiting_manual") {
          throw new AutomationError("NOT_WAITING", "这次运行当前不在等待人工确认", 409);
        }
        const state = run.steps[stepId];
        if (!state || state.status !== "waiting_manual") {
          throw new AutomationError("BAD_STEP", "这个步骤不在等待人工确认", 409);
        }
        state.status = "done";
        state.finishedAt = iso();
        state.completedBy = typeof actor === "string" ? actor.slice(0, 200) : null;
        run.status = "running";
        run.currentStep = null;
        run.updatedAt = iso();
        await store.save(run);
        return advance(run, definition);
      });
    },

    async cancel({ runId } = {}) {
      return withLock(runId, async () => {
        const { run } = await requireRun(runId);
        if (TERMINAL.has(run.status)) {
          throw new AutomationError("FINISHED", "这次运行已经结束，不能取消", 409);
        }
        const at = iso();
        for (const state of Object.values(run.steps)) {
          if (["pending", "running", "waiting_manual"].includes(state.status)) {
            state.status = "skipped";
            state.finishedAt = at;
            state.skipReason = "运行已取消";
          }
        }
        run.status = "cancelled";
        run.currentStep = null;
        run.finishedAt = at;
        run.updatedAt = at;
        await store.save(run);
        return run;
      });
    },

    // Runs interrupted mid-step are re-driven after boot. Manual waits are
    // durable and stay exactly as they were.
    async resumeInterrupted() {
      const runs = await store.list(AUTOMATION_MAX_RUNS);
      let resumed = 0;
      let failed = 0;
      for (const run of runs) {
        if (run.status !== "running") continue;
        const definition = definitions.get(run.pipelineId);
        if (!definition) {
          run.status = "failed";
          run.error = "这条产线的定义已不存在";
          run.updatedAt = iso();
          run.finishedAt = run.updatedAt;
          await store.save(run);
          failed += 1;
          continue;
        }
        for (const state of Object.values(run.steps)) {
          if (state.status === "running") {
            state.status = "pending";
            state.startedAt = null;
            state.error = null;
          }
        }
        try {
          await withLock(run.id, () => advance(run, definition));
          resumed += 1;
        } catch {
          failed += 1;
        }
      }
      return { resumed, failed };
    },

    async read(runId) {
      return store.read(runId);
    },

    async list(limit = AUTOMATION_LIST_LIMIT) {
      return store.list(limit);
    },
  });
}
