import { createJsonFileStore } from "../../../packages/platform/src/storage.mjs";

// ---------------------------------------------------------------------------
// Skill catalog and installation-wide switches.
//
// The reference keeps a long catalog in `lib/skills/registry.ts` plus per-role
// layout in `skill-config.ts`. Here the catalog only lists capabilities this
// runtime can actually execute today; anything from a later phase is flagged
// `comingSoon` and stays visible but not switchable.
//
// A switch is not decoration: chat retrieval, automation pipelines, handover
// export and desk commands all consult it. The stored document keeps the
// disabled ids instead of the enabled ones, so a skill introduced by a later
// version starts enabled without a migration.
// ---------------------------------------------------------------------------

export const SKILL_DOCUMENT_VERSION = 1;
export const MAX_DISABLED_SKILLS = 200;

export const SKILL_CATEGORIES = Object.freeze([
  { id: "all", label: "全部" },
  { id: "knowledge", label: "知识" },
  { id: "creation", label: "创作" },
  { id: "production", label: "制作" },
  { id: "system", label: "本机能力" },
]);

export const SKILLS = Object.freeze([
  {
    id: "knowledge-qa",
    name: "知识问答",
    category: "knowledge",
    icon: "▤",
    runner: "app",
    desc: "每次提问只把与问题相关的已确认知识卡带进上下文，并记录本轮引用来源。",
    hint: "停用后模型只靠对话与人格记忆回答，不再读知识库。",
  },
  {
    id: "knowledge-brief",
    name: "知识简报",
    category: "knowledge",
    icon: "▦",
    runner: "app",
    pipelineId: "knowledge-brief",
    desc: "把知识卡、缺口与回归结果整理成一份 Markdown 简报，人工确认后结束本次运行。",
    hint: "简报只读当前项目的知识库，不调用模型。",
  },
  {
    id: "handover",
    name: "交接包",
    category: "knowledge",
    icon: "⇩",
    runner: "app",
    desc: "把一个项目的知识、缺口、回归题与人格记忆导出成一份本地 JSON，可离线交接。",
    hint: "导出前会扫描形似凭据的内容并拒绝，不会静默删字段。",
  },
  {
    id: "script-draft",
    name: "口播脚本",
    category: "creation",
    icon: "✎",
    runner: "app",
    pipelineId: "script-draft",
    desc: "按主题、受众、时长与语气起草口播脚本，只引用已确认知识。",
    hint: "用的是当前安装的引擎；草稿必须人工确认才算完成。",
  },
  {
    id: "topic-pack",
    name: "选题提案",
    category: "creation",
    icon: "✦",
    runner: "app",
    pipelineId: "topic-pack",
    desc: "按受众与数量从已确认知识里提炼可拍选题，写明角度与依据。",
    hint: "没有依据的选题会标成「待补知识」，不会编造公司事实。",
  },
  {
    id: "script-rewrite",
    name: "口播改写",
    category: "creation",
    icon: "↻",
    runner: "app",
    pipelineId: "script-rewrite",
    desc: "把已有草稿改写成可拍口播，保留原稿事实并核对已确认知识。",
    hint: "适合把长文、旧稿或会议记录改成 60 秒口播。",
  },
  {
    id: "doc-rewrite",
    name: "图文改写",
    category: "creation",
    icon: "✍",
    runner: "app",
    comingSoon: true,
    desc: "把长文改写成图文卡片与朋友圈文案。",
    hint: "随阶段 4C 的文本产线一起开放。",
  },
  {
    id: "media-inventory",
    name: "素材清单",
    category: "production",
    icon: "▤",
    runner: "app",
    pipelineId: "media-inventory",
    desc: "扫描来源白名单里的目录，列出视频、音频、图片与大小，供后续影音产线选材。",
    hint: "不调用 FFmpeg，未安装也能用；只读取「来源配置」允许的目录。",
  },
  {
    id: "audio-extract",
    name: "音频提取",
    category: "production",
    icon: "♪",
    runner: "app",
    pipelineId: "audio-extract",
    requiresMedia: "ffmpeg",
    desc: "从白名单内的视频或音频文件提取一条音频轨，输出 M4A、MP3 或 WAV。",
    hint: "需要 FFmpeg/ffprobe；没有音频轨的文件会直接失败。",
  },
  {
    id: "video-normalize",
    name: "视频规格化",
    category: "production",
    icon: "▣",
    runner: "app",
    pipelineId: "video-normalize",
    requiresMedia: "ffmpeg",
    desc: "把白名单内的视频统一成 H.264 / AAC 的 MP4，按目标高度缩小并抽一帧封面。",
    hint: "需要 FFmpeg/ffprobe；只缩小不放大，竖屏与横屏都保持原比例。",
  },
  {
    id: "video-reframe",
    name: "多规格转码",
    category: "production",
    icon: "⇱",
    runner: "app",
    pipelineId: "video-reframe",
    requiresMedia: "ffmpeg",
    desc: "把白名单内的视频转成横屏 16:9、竖屏 9:16、方屏 1:1 三种平台规格，补边不裁切。",
    hint: "需要 FFmpeg/ffprobe；平台画布固定，小尺寸源会被放大并补边。",
  },
  {
    id: "video-subtitle",
    name: "字幕封装",
    category: "production",
    icon: "⌶",
    runner: "app",
    pipelineId: "video-subtitle",
    requiresMedia: "ffmpeg",
    desc: "把 SRT 字幕封装成 MP4 内可开关的字幕轨，画面与音轨不重编码，并保留 SRT 文件。",
    hint: "需要 FFmpeg/ffprobe；字幕必须是合法 SRT，时间码按先后排列。",
  },
  {
    id: "video-burn",
    name: "字幕烧录",
    category: "production",
    icon: "▣",
    runner: "app",
    pipelineId: "video-burn",
    requiresMedia: "ffmpeg",
    desc: "把 SRT 字幕烧进画面，导出任何平台都能直接播放的硬字幕 MP4，并保留 SRT 文件。",
    hint: "需要 FFmpeg/ffprobe（含 libass）；会重新编码视频，字幕无法再关闭。",
  },
  {
    id: "asr-subtitle",
    name: "语音转字幕",
    category: "production",
    icon: "≣",
    runner: "app",
    pipelineId: "asr-subtitle",
    requiresMedia: "ffmpeg",
    requiresAsr: true,
    desc: "把白名单内的音频或视频转成 SRT 字幕与识别稿，本机 faster-whisper 识别，不上传云端。",
    hint: "需要 FFmpeg/ffprobe 与本机 Python + faster-whisper；设置 ALLROUND_AI_PYTHON 与 ALLROUND_AI_WHISPER_MODEL。",
  },
  {
    id: "asr-batch",
    name: "批量转字幕",
    category: "production",
    icon: "⧉",
    runner: "app",
    pipelineId: "asr-batch",
    requiresMedia: "ffmpeg",
    requiresAsr: true,
    desc: "扫描白名单内的一个目录，把音频与视频逐个转成 SRT，并汇总成功、跳过与失败。",
    hint: "需要 FFmpeg 与本机 Python + faster-whisper；单个文件失败不会中断整批。",
  },
  {
    id: "media-render",
    name: "影音成片",
    category: "production",
    icon: "▶",
    runner: "app",
    pipelineId: "video-render",
    requiresMedia: "ffmpeg",
    desc: "把多个片段按顺序合成一条成片：统一画布、可选淡入淡出转场与背景音乐，并留一份合成报告。",
    hint: "需要 FFmpeg/ffprobe；片段会统一补边到目标画布，缺音轨的片段自动补静音。",
  },
  {
    id: "publish-pack",
    name: "发布包",
    category: "production",
    icon: "⇢",
    runner: "app",
    pipelineId: "publish-pack",
    desc: "把标题、文案与平台检查项整理成发布清单与 JSON，人工发布后回填回执。",
    hint: "不调用平台接口、不保存账号；只生成本地清单，发布动作由人完成。",
  },
  {
    id: "distribute",
    name: "多平台分发",
    category: "production",
    icon: "⇢",
    runner: "app",
    comingSoon: true,
    desc: "把一次成片按平台规格分发，并记录每个平台的发布状态。",
    hint: "随阶段 4E 的分发能力一起开放。",
  },
  {
    id: "midi-breath",
    name: "MIDI 气口",
    category: "production",
    icon: "♬",
    runner: "app",
    pipelineId: "midi-breath",
    desc: "给带词旋律 MIDI 补换气口：拉宽短休止、按句尾与长音切气口、限制乐句长度，并可整体移调。",
    hint: "纯本机处理，不需要 FFmpeg；只读写 .mid/.midi，不生成音频。",
  },
  {
    id: "lyrics-timeline",
    name: "歌词时间轴",
    category: "production",
    icon: "≡",
    runner: "app",
    pipelineId: "lyrics-timeline",
    desc: "把 LRC 歌词规范化为统一时间码，生成同时间轴的 SRT 字幕，可整体前后位移。",
    hint: "纯文本处理，不需要 FFmpeg；无时间码的行会保留在报告里但不会猜时间。",
  },
  {
    id: "midi-musicxml",
    name: "旋律导出",
    category: "production",
    icon: "𝄞",
    runner: "app",
    pipelineId: "midi-musicxml",
    desc: "把带词旋律 MIDI 导出成单声部 MusicXML，保留音高、时值、延音线、休止与歌词。",
    hint: "不需要 FFmpeg；导出的 .musicxml 可直接用 MuseScore 等制谱软件打开。",
  },
  {
    id: "musicxml-midi",
    name: "旋律导入",
    category: "production",
    icon: "↺",
    runner: "app",
    pipelineId: "musicxml-midi",
    desc: "把单声部 MusicXML 转回带词 MIDI，合并延音线并保留歌词，供气口标注或继续编曲。",
    hint: "不需要 FFmpeg；和弦、多声部与装饰音会被明确拒绝。",
  },
  {
    id: "music-batch",
    name: "音乐批量处理",
    category: "production",
    icon: "⋯",
    runner: "app",
    pipelineId: "music-batch",
    desc: "把目录里的 MIDI 或 MusicXML 一次性补齐气口、导出旋律谱或转回 MIDI，并输出逐文件汇总报告。",
    hint: "不需要 FFmpeg；失败文件记入报告但不打断其余文件，只处理目录第一层。",
  },
  {
    id: "music-midi",
    name: "音乐 / MIDI",
    category: "production",
    icon: "♪",
    runner: "app",
    comingSoon: true,
    desc: "生成 MIDI 片段并导出可编辑的乐谱与音频。",
    hint: "随阶段 4F 的后续音乐能力一起开放。",
  },
  {
    id: "local-files",
    name: "本机文件",
    category: "system",
    icon: "▤",
    runner: "desk",
    capabilities: ["files"],
    desc: "在工作台里列出、读取、写入已授权目录内的文本文件。",
    hint: "只访问 desk-cli pair --root 声明的目录，越界与二进制文件会被拒绝。",
  },
  {
    id: "local-process",
    name: "本机命令",
    category: "system",
    icon: "⌘",
    runner: "desk",
    capabilities: ["process"],
    desc: "在已配对的电脑上运行白名单程序，不经 shell、不继承环境变量。",
    hint: "程序由 desk-cli pair --allow 声明，按解析后的真实路径比较。",
  },
  {
    id: "local-screen",
    name: "屏幕截图",
    category: "system",
    icon: "▣",
    runner: "desk",
    capabilities: ["screen"],
    desc: "从已配对的电脑抓一张当前桌面截图，返回工作台内联查看。",
    hint: "Windows 需已登录桌面；macOS 首次会请求「屏幕录制」权限。",
  },
]);

const SKILL_MAP = new Map(SKILLS.map((skill) => [skill.id, skill]));

// Which switch guards which entry point. Keeping the mapping here means the
// server never has to guess an id from a route name.
export const COMMAND_SKILLS = Object.freeze({
  "files.list": "local-files",
  "files.read": "local-files",
  "files.write": "local-files",
  "process.run": "local-process",
  "screen.capture": "local-screen",
});

export function skillById(id) {
  return SKILL_MAP.get(id) ?? null;
}

export function skillForCommand(type) {
  return COMMAND_SKILLS[type] ?? null;
}

export function skillForPipeline(pipelineId) {
  const skill = SKILLS.find((entry) => entry.pipelineId === pipelineId);
  return skill?.id ?? null;
}

function assertDocument(value) {
  if (!value || value.version !== SKILL_DOCUMENT_VERSION || !Array.isArray(value.disabled)) {
    throw new Error("All Round AI skill store format is unsupported or damaged");
  }
  if (value.disabled.some((id) => typeof id !== "string" || !id)) {
    throw new Error("All Round AI skill store contains an invalid switch");
  }
  return value;
}

function describeAvailability(skill, devices, media, asr) {
  if (skill.comingSoon) {
    return {
      available: false,
      reason: "这项能力还在迁移中，当前版本不能启用。",
      howTo: "阶段 4 的后续批次会随产线一起开放。",
      devices: 0,
      online: 0,
    };
  }
  if (skill.requiresMedia === "ffmpeg" && !media?.ffmpeg?.available) {
    return {
      available: false,
      reason: `未检测到 FFmpeg（${media?.ffmpeg?.reason || "未安装，或不在 PATH 里"}）。`,
      howTo: "安装 FFmpeg 并加入 PATH，或设置 FFMPEG_PATH / FFPROBE_PATH。",
      devices: 0,
      online: 0,
    };
  }
  if (skill.requiresAsr && !asr?.available) {
    return {
      available: false,
      reason: `未检测到可用的 faster-whisper（${asr?.reason || "Python 或模型不可用"}）。`,
      howTo: "安装 Python 与 faster-whisper，并设置 ALLROUND_AI_PYTHON / ALLROUND_AI_WHISPER_MODEL。",
      devices: 0,
      online: 0,
    };
  }
  if (skill.requiresMedia === "ffmpeg" || skill.requiresAsr) {
    return { available: true, reason: "", howTo: "", devices: 0, online: 0 };
  }
  if (!skill.capabilities?.length) {
    return { available: true, reason: "", howTo: "", devices: 0, online: 0 };
  }
  // A desk skill needs a paired agent that advertised every capability it
  // requires. Being offline does not make the switch unusable, so the online
  // count is reported separately.
  const matches = devices.filter((device) => skill.capabilities.every(
    (capability) => Array.isArray(device.capabilities) && device.capabilities.includes(capability),
  ));
  if (!matches.length) {
    return {
      available: false,
      reason: `还没有配对该能力的本机设备（需要 ${skill.capabilities.join(" / ")}）。`,
      howTo: "在「设备」面板签发配对票据，再用 desk-cli pair --root / --allow / --screen 声明能力。",
      devices: 0,
      online: 0,
    };
  }
  return {
    available: true,
    reason: "",
    howTo: "",
    devices: matches.length,
    online: matches.filter((device) => device.online === true).length,
  };
}

function describeSkill(skill, disabled, devices, media, asr) {
  const availability = describeAvailability(skill, devices, media, asr);
  return {
    id: skill.id,
    name: skill.name,
    category: skill.category,
    icon: skill.icon,
    runner: skill.runner,
    desc: skill.desc,
    hint: skill.hint,
    ...(skill.comingSoon ? { comingSoon: true } : {}),
    ...(skill.capabilities ? { capabilities: [...skill.capabilities] } : {}),
    // A coming-soon entry is always off and cannot be turned on yet.
    enabled: !skill.comingSoon && !disabled.has(skill.id),
    ...availability,
  };
}

export async function createSkillStore(filePath) {
  if (typeof filePath !== "string") throw new TypeError("A skill store path is required");
  const store = createJsonFileStore(filePath, {
    initial: () => ({ version: SKILL_DOCUMENT_VERSION, disabled: [] }),
    validate: assertDocument,
  });

  async function disabledSet() {
    const document = await store.read();
    return new Set(document.disabled);
  }

  return Object.freeze({
    path: store.path,
    async list(devices = [], options = {}) {
      if (!Array.isArray(devices)) throw new TypeError("devices must be an array");
      const media = options.media ?? null;
      const asr = options.asr ?? null;
      const disabled = await disabledSet();
      const skills = SKILLS.map((skill) => describeSkill(skill, disabled, devices, media, asr));
      return {
        categories: SKILL_CATEGORIES.map((category) => ({ ...category })),
        skills,
        stats: {
          total: skills.length,
          enabled: skills.filter((skill) => skill.enabled).length,
          available: skills.filter((skill) => skill.available && !skill.comingSoon).length,
          comingSoon: skills.filter((skill) => skill.comingSoon).length,
        },
      };
    },
    async isEnabled(id) {
      const skill = skillById(id);
      if (!skill) throw new TypeError("技能不存在");
      if (skill.comingSoon) return false;
      const disabled = await disabledSet();
      return !disabled.has(id);
    },
    async setEnabled(id, enabled) {
      const skill = skillById(id);
      if (!skill) {
        const error = new TypeError("技能不存在");
        error.status = 404;
        throw error;
      }
      if (skill.comingSoon) {
        const error = new TypeError("这项能力还没有上线，暂时不能启用");
        error.status = 400;
        throw error;
      }
      if (typeof enabled !== "boolean") throw new TypeError("启用状态必须是布尔值");
      await store.update((document) => {
        const disabled = new Set(document.disabled);
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        if (disabled.size > MAX_DISABLED_SKILLS) {
          throw new Error("停用的技能数量已达上限");
        }
        document.disabled = [...disabled];
      });
    },
  });
}
