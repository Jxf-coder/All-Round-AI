// ---------------------------------------------------------------------------
// 开工前问答 (knowledge intake). The reference workbench gates knowledge work
// behind one onboarding form: what is sold, to whom, in which channel, what the
// knowledge base must contain, what must never enter it, and which questions
// customers keep asking. Submitting it writes one record and regenerates four
// standard cards, so later retrieval and content work share the same boundaries
// instead of each prompt inventing its own.
//
// This module is pure: the store decides when to write and how to merge.
// ---------------------------------------------------------------------------

export const INTAKE_CARD_IDS = Object.freeze({
  scope: "kc-intake-scope",
  boundary: "kc-intake-boundary",
  redlines: "kc-intake-redlines",
  standard: "kc-intake-standard",
});

export const DEFAULT_CATEGORIES = Object.freeze([
  "产品与参数",
  "价格交期与服务",
  "资质认证与检测",
  "客户问答",
  "工艺与现场",
  "品牌口径与禁词",
]);

export const DEFAULT_FORBIDDEN = Object.freeze([
  "合同", "工资", "薪资", "薪酬", "社保", "身份证", "银行卡", "银行账户", "密码",
  "成本价", "成本核算", "底价", "内部报价", "客户名单", "客户资料", "通讯录", "报销",
  "发票", "财务报表", "利润表", "员工信息", "员工档案", "简历", "劳动合同", "股权", "配方",
]);

export const MAX_INTAKE_QUESTIONS = 30;

const field = (value, max = 4000) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// Every key is always present so the stored record has one stable shape and the
// form can round-trip without guessing which boxes were left empty.
export function cleanIntake(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    product: field(source.product, 200),
    customer: field(source.customer, 400),
    platform: field(source.platform, 200),
    positioning: field(source.positioning, 400),
    sellingPoints: field(source.sellingPoints, 3000),
    contentThemes: field(source.contentThemes, 2000),
    knowledgeNeeds: field(source.knowledgeNeeds, 3000),
    materialsWhere: field(source.materialsWhere, 1200),
    nas: field(source.nas, 80),
    devOs: field(source.devOs, 80),
    forbidden: field(source.forbidden, 1500),
    externalOk: field(source.externalOk, 1500),
    redLines: field(source.redLines, 2000),
    questions: field(source.questions, 4000),
    versioning: field(source.versioning, 800),
    hours: field(source.hours, 200),
    bossConfirmed: source.bossConfirmed === true,
  };
}

// One question per line, but a pasted paragraph that ends sentences with ？ is
// split too. List prefixes ("1." "1、" "-" "（1）") are stripped so the stored
// question reads the way a customer would ask it.
export function parseQuestions(value) {
  const out = [];
  for (const line of String(value ?? "").split(/\r?\n|(?<=[？?])\s*/u)) {
    const question = line
      .replace(/^\s*(?:\d{1,2}\s*[.、)）．:：]|[-*•·]|[（(]\d{1,2}[)）])\s*/u, "")
      .trim();
    if (question.length < 4 || question.length > 200) continue;
    if (!out.includes(question)) out.push(question);
    if (out.length >= MAX_INTAKE_QUESTIONS) break;
  }
  return out;
}

// Own terms are what the company wrote; the defaults are what almost every
// company means. Both are used by retrieval pre-filters and prompts.
export function forbiddenTerms(fields) {
  const own = String(fields?.forbidden ?? "")
    .split(/[、，,；;\n/|]+/u)
    .map((term) => term
      .replace(/^(?:不能|不要|禁止|禁入|不得)/u, "")
      .replace(/[（(].*?[)）]/gu, "")
      .trim())
    .filter((term) => term.length >= 2 && term.length <= 16);
  return [...new Set([...own, ...DEFAULT_FORBIDDEN])];
}

export function standardCardBody(fields, categories = DEFAULT_CATEGORIES) {
  return [
    `主推产品：${fields.product || "（未填）"}；目标客户：${fields.customer || "（未填）"}；主攻平台：${fields.platform || "（未填）"}。`,
    fields.positioning ? `定位：${fields.positioning}` : "",
    fields.knowledgeNeeds ? `Plan 要求知识库必须有的事实（优先沉淀能支撑这些的资料）：\n${fields.knowledgeNeeds}` : "",
    fields.sellingPoints ? `要证明的卖点（找得到证明材料的优先）：\n${fields.sellingPoints}` : "",
    "",
    "一个文件只有同时满足下面六条才沉淀，有一条不满足就不沉淀，有一条判断不了就交人拍板：",
    `1. 和在推的产品有关（${fields.product || "主推产品"}，或公司通用的资质、服务、品牌口径）。`,
    `2. 属于这几类之一：${categories.join("、")}。`,
    "3. 里面有可以引用的具体事实：型号、参数、数字、流程、话术、认证、交期、售后条款。",
    `4. 不是禁入资料：${forbiddenTerms(fields).slice(0, 18).join("、")}。`,
    "5. 不是旧版本、草稿、作废件、重复件；同一份资料只留最新版。",
    "6. 对回答客户问题或做推广有用。",
    "",
    `可对外 / 可送外部模型：${fields.externalOk || "（未填，默认只内部使用）"}`,
    `版本与有效期习惯：${fields.versioning || "（未填）"}`,
    "",
    "提炼时：只抽原文；每个数字带页码或段落；拿不准写待确认；两份资料说法不同两条都留并标冲突；不写客户名称，不编效果数字和认证结论。",
  ].filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== "")).join("\n");
}

// The four cards always carry the same ids, so resubmitting the form updates
// them instead of piling up near-duplicates. `status` follows the boss flag:
// unconfirmed answers stay pending and do not enter retrieval.
export function buildIntakeCards(fields, { status = "pending" } = {}) {
  if (status !== "pending" && status !== "confirmed") {
    throw new TypeError("开工前问答卡片状态无效");
  }
  const common = { status, source: "开工前问答" };
  return [
    {
      ...common,
      id: INTAKE_CARD_IDS.scope,
      kind: "preference",
      title: `产品范围：${fields.product || "主推产品未填"}`,
      body: [
        `主推产品：${fields.product}`,
        `目标客户：${fields.customer}`,
        `主攻平台：${fields.platform}`,
        fields.positioning ? `一句话定位：${fields.positioning}` : "",
        fields.sellingPoints ? `核心卖点与证明：\n${fields.sellingPoints}` : "",
        fields.contentThemes ? `选题方向：\n${fields.contentThemes}` : "",
        `资料在哪：${fields.materialsWhere}`,
        `NAS：${fields.nas || "—"}；技术负责人电脑：${fields.devOs || "—"}`,
        fields.hours ? `投入时间：${fields.hours}` : "",
      ].filter(Boolean).join("\n"),
    },
    {
      ...common,
      id: INTAKE_CARD_IDS.boundary,
      kind: "preference",
      title: "资料边界：禁入与可对外",
      body: [
        `禁入（不进知识库，也不贴给任何 AI）：${fields.forbidden}`,
        `可对外 / 可送外部模型：${fields.externalOk}`,
      ].join("\n"),
    },
    {
      ...common,
      id: INTAKE_CARD_IDS.redlines,
      kind: "preference",
      title: "行业红线与对外口径",
      body: fields.redLines || "（未填）",
    },
    {
      ...common,
      id: INTAKE_CARD_IDS.standard,
      kind: "method",
      title: "沉淀标准卡：AI 判断哪些资料该沉淀",
      body: standardCardBody(fields),
    },
  ];
}
