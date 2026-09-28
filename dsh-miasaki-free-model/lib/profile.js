/**
 * @miasaki/dsh-free-model — 能力画像的唯一实现。
 *
 * 两个来源共用这一份判定：① 端点自述（`GET {baseURL}/models` 的
 * `supported_parameters` / `architecture` / `reasoning` / 上下文 / 输出上限）；
 * ② 适配器自述（官方 `llm.resolveModelInfo` 的 `inputModalities` / `reasoning` /
 * `context` / `defaultMaxTokens`）。
 *
 * 为什么必须共用：M1 之前画像只服务于端点来源，M1 起免 Key 车道（适配器来源）
 * 也要出同一张模型卡 —— 两份 verdict 逻辑必然漂移，用户会在两个来源上看到
 * 互相矛盾的结论。
 *
 * **能力只到能被证明的程度**：两个来源都拿不到"是否支持工具调用"时
 * （适配器自述不提供 `supported_parameters`），本模块**不假设**它能做子代理 ——
 * 而是用 `toolsUnknown` 把它标成"未声明"，verdict 明说需实测。这一条与
 * `dsh-our-free-model` 的公开立场一致（"公开清单和实测都拿不到证据的，就不标注"）。
 */

/**
 * 构建一份能力画像与适用性判定。
 *
 * @param {object} input
 * @param {string} input.modality - 模态描述（如 `text+image->text`）。
 * @param {boolean} input.hasTools - 已声明支持工具调用。
 * @param {boolean} input.hasToolChoice - 已声明支持 `tool_choice`。
 * @param {boolean} input.hasReasoning - 可调思考强度。
 * @param {boolean} input.hasStructured - 支持结构化输出。
 * @param {boolean} input.hasVision - 可读图。
 * @param {boolean} input.hasAudio - 可读音频。
 * @param {boolean} input.isCodeModel - 编码类模型（id/name 特征）。
 * @param {number} input.contextWindow - 上下文窗口（0 = 未知）。
 * @param {number} input.maxOutput - 最长输出（0 = 未知）。
 * @param {boolean} input.isPreview - 预览/测试模型。
 * @param {'endpoint'|'adapter'} input.source - 画像依据的来源。
 * @param {boolean} [input.toolsUnknown] - 来源未声明任何工具参数（适配器来源为真）。
 * @returns {object} 稳定形状的 profile（键集与 v0.3 的 `analyzeModel` 一致，另加 `source` / `toolsUnknown`）。
 */
export function buildProfile(input) {
  const {
    modality = 'text->text',
    hasTools = false,
    hasToolChoice = false,
    hasReasoning = false,
    hasStructured = false,
    hasVision = false,
    hasAudio = false,
    isCodeModel = false,
    contextWindow: ctx = 0,
    maxOutput: maxOut = 0,
    isPreview = false,
    source = 'endpoint',
    toolsUnknown = false,
  } = input ?? {};

  const isLongContext = ctx >= 512000;

  // 子代理门槛：必须支持 tools + tool_choice（DSH agent loop 依赖工具循环）。
  // toolsUnknown 时门槛不成立 —— 未声明不等于支持，也不等于不支持。
  const canAgent = hasTools && hasToolChoice;

  let role = '通用';
  const strengths = [];
  if (canAgent) {
    let flavor = '子代理';
    if (hasReasoning) flavor = '推理型子代理';
    else if (isCodeModel) flavor = '编码子代理';
    else if (hasVision) flavor = '多模态子代理';
    role = `${flavor}可用`;
  } else if (toolsUnknown) {
    role = '工具能力未声明';
  } else if (!hasTools) {
    role = '仅纯文本问答';
  }
  if (hasReasoning) strengths.push('推理');
  if (isCodeModel) strengths.push('编码');
  if (hasStructured) strengths.push('结构化输出');
  if (hasVision) strengths.push('视觉');
  if (hasAudio) strengths.push('音频');
  if (isLongContext) strengths.push('超长上下文');
  if (!hasTools && !hasReasoning && !hasStructured && strengths.length === 0) strengths.push('轻量');

  let verdict;
  if (canAgent && hasReasoning && isLongContext) verdict = '首选：复杂任务子代理（推理+超长上下文）';
  else if (canAgent && isCodeModel) verdict = '首选：编码类子代理';
  else if (canAgent && hasVision) verdict = '首选：多模态子代理';
  else if (canAgent) verdict = '可用：通用子代理（工具调用完整）';
  else if (toolsUnknown) verdict = '需实测验证：该来源不声明工具参数，能否做子代理未知';
  else if (!hasTools && hasVision) verdict = '仅视觉问答：不可当子代理（无工具调用）';
  else if (!hasTools) verdict = '仅问答/批处理：不可当子代理（无工具调用）';
  else verdict = '需实测验证：申明支持工具但无 tool_choice，子代理可能失败';

  const warnings = [];
  if (!canAgent) {
    if (toolsUnknown) warnings.push('工具参数未声明：子代理可用性需实测');
    else if (!hasTools) warnings.push('无工具调用：不能做子代理');
    else warnings.push('缺 tool_choice：工具调用可能失败，需实测');
  }
  if (isPreview) warnings.push('预览模型：可能临时免费或随时下线');
  if (maxOut > 0 && maxOut < 8192) warnings.push(`输出上限低（${maxOut}）`);
  if (ctx > 0 && ctx < 64000) warnings.push('上下文较小');
  if (maxOut === 0 && ctx === 0) warnings.push('元数据缺失：能力未验证');

  return {
    modality,
    reasoning: hasReasoning,
    tools: hasTools,
    toolChoice: hasToolChoice,
    structuredOutput: hasStructured,
    vision: hasVision,
    code: isCodeModel,
    longContext: isLongContext,
    canAgent,
    role,
    strengths,
    warnings,
    verdict,
    source,
    toolsUnknown,
  };
}
