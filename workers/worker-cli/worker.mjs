import { readFile, writeFile, mkdir, rename, readdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

const here = dirname(fileURLToPath(import.meta.url))
const config = JSON.parse(await readFile(join(here, 'config.json'), 'utf8'))
const root = resolve(config.workspace)
const vendorRoot = resolve(config.vendorRoot)
const agentId = process.argv[2] ?? config.defaultAgent ?? 'analyst'
const agentDir = join(root, 'agents', agentId)
const now = () => new Date().toISOString()

async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return undefined } }
async function readText(p) { try { return await readFile(p, 'utf8') } catch { return undefined } }

async function writeStatus(patch) {
  const current = (await readJson(join(agentDir, 'status.json'))) ?? { version: 1, agent_id: agentId, tokens: { task: 0, session: 0, day: 0 } }
  const next = { ...current, ...patch, heartbeat_at: now(), pid: process.pid }
  await writeFile(join(agentDir, 'status.json'), JSON.stringify(next, null, 2))
}

async function claimInbox() {
  const inbox = join(agentDir, 'inbox')
  await mkdir(inbox, { recursive: true })
  const entries = (await readdir(inbox)).filter(n => n.endsWith('.json') && !n.endsWith('.claimed'))
  if (entries.length === 0) return undefined
  const name = entries.sort()[0]
  await rename(join(inbox, name), join(inbox, name + '.claimed'))
  return readJson(join(inbox, name + '.claimed'))
}

function formatDialog(events, taskId) {
  const lines = []
  for (const ev of events ?? []) {
    try {
      if (ev.type === 'user/message') {
        const texts = (ev.data?.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text)
        if (texts.length > 0) lines.push('【用户】' + texts.join('\n').slice(0, 1200))
      } else if (ev.type === 'assistant/message') {
        const texts = (ev.data?.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text)
        if (texts.length > 0) lines.push('【助手】' + texts.join('\n'))
      } else if (ev.type === 'tool/call') {
        lines.push('【工具】' + (ev.data?.name ?? ev.data?.id ?? '') + ' ' + JSON.stringify(ev.data?.input ?? {}).slice(0, 300))
      } else if (ev.type === 'tool/result') {
        const content = ev.data?.message?.content ?? []
        const t = content.filter(b => b.type === 'text').map(b => b.text).join('')
        lines.push('【结果】' + t.slice(0, 500) + (ev.data?.error ? ' (error)' : ''))
      } else if (ev.type === 'turn/end') {
        lines.push('【回合结束】' + JSON.stringify(ev.data?.reason ?? {}))
      }
    } catch { /* 跳过无法解析的事件 */ }
  }
  return lines.join('\n')
}

function extractUsage(events, taskId, model) {
  const rows = []
  for (const ev of events ?? []) {
    try {
      if (ev.type === 'assistant/message') {
        const u = ev.data && ev.data.usage
        if (u && typeof u === 'object') {
          const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0
          const output = typeof u.outputTokens === 'number' ? u.outputTokens : 0
          if (input > 0 || output > 0) {
            rows.push({
              ts: new Date().toISOString(),
              task: taskId,
              model: model,
              input_tokens: input,
              output_tokens: output,
              cost: 0,
              note: 'child assistant/message usage',
            })
          }
        }
      }
    } catch { /* 跳过无法解析的事件 */ }
  }
  return rows
}

async function deliver(taskId, finalResponse, events, childSessionRoot) {
  const resultDir = join(root, 'tasks', taskId, 'result')
  await mkdir(resultDir, { recursive: true })
  const resultFile = join(resultDir, `result-${taskId}.md`)
  if (!existsSync(resultFile)) {
    const content = [
      `# 结果：${taskId}`,
      '',
      '## 结论',
      finalResponse || '(空响应)',
      '',
      '## 完成度',
      '100%（keyless 验证轮次：子运行时按 mock 脚本应答，交付物由 worker 包装层落盘）',
      '',
      '## 数据来源 / 依据',
      `- 子运行时会话日志：${childSessionRoot}`,
      '',
      '## 遇到的问题',
      '无',
      '',
      '## 广播建议',
      '（本轮为 M3.5 worker 自动化 keyless 验证）',
      '',
      '## 下一步建议',
      '真实模型轮次待 DEEPSEEK_API_KEY 注入。',
    ].join('\n')
    await writeFile(resultFile, content)
  }
  await appendFile(join(agentDir, 'transcript.md'), `\n## 任务 ${taskId}（child session: ${childSessionRoot}）\n${finalResponse}\n`)
  await appendFile(join(agentDir, 'transcript.md'), `\n## 任务 ${taskId} 对话框\n${formatDialog(events, taskId)}\n`)
  const notesFile = join(agentDir, 'notes.md')
  const notes = (await readText(notesFile)) ?? ''
  if (!notes.includes(taskId)) {
    await appendFile(notesFile, `- ${taskId} 完成（M3.5 keyless 验证轮，mock 应答）\n`)
  }
}

async function runOne(task) {
  const taskId = task.task_id
  const brief = (await readText(join(root, 'tasks', taskId, 'brief.md'))) ?? ''
  const context = (await readText(join(root, 'tasks', taskId, 'context.md'))) ?? ''
  const childSessionRoot = join(agentDir, 'sessions', taskId)
  await mkdir(childSessionRoot, { recursive: true })
  const prompt = [
    brief,
    context ? `\n## 上下文\n${context}` : '',
    `\n## 交付约定\n任务完成后：1) 将结论写入 ${join(root, 'tasks', taskId, 'result', `result-${taskId}.md`)}（结构：结论/完成度/数据来源/遇到的问题/广播建议/下一步建议）；2) 用不超过 10 行要点更新 ${join(agentDir, 'notes.md')}。`,
  ].join('\n')

  const harness = new DeepSeekHarness({
    launch: {
      command: process.execPath,
      args: ['--import', 'tsx', join(vendorRoot, config.childBin), join(vendorRoot, config.childConfig)],
      cwd: vendorRoot,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: config.mock.apiKey,
        DEEPSEEK_BASE_URL: config.mock.baseUrl,
        DSH_CWD: root,
        DSH_SESSION_ROOT: childSessionRoot,
        DSH_SYSTEM_PROMPT: 'You are a worker agent of a multi-agent CLI orchestration. Deliver results per the task brief.',
      },
      requestTimeoutMs: 120000,
    },
    cwd: root,
    provider: config.provider,
    model: config.model,
  })

  const hb = setInterval(() => { writeStatus({ state: 'running', step: '执行中' }).catch(() => {}) }, 10000)
  try {
    const result = await harness.run(prompt, { sessionId: `task-${taskId}` })
    await deliver(taskId, result.finalResponse, result.events, childSessionRoot)

    // usage 计量（§4.4）：从子运行时 assistant/message 事件的 data.usage 提取
    const usageRows = extractUsage(result.events, taskId, config.model)
    if (usageRows.length > 0) {
      const usageFile = join(agentDir, 'usage.jsonl')
      await appendFile(usageFile, usageRows.map((r) => JSON.stringify(r)).join('\n') + '\n')
      const prev = (await readJson(join(agentDir, 'status.json'))) || {}
      const prevTokens = prev.tokens || { task: 0, session: 0, day: 0 }
      const taskSum = usageRows.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0)
      await writeStatus({
        state: 'idle', current_task: null, progress: 1.0, step: '已完成交付',
        tokens: { task: taskSum, session: prevTokens.session + taskSum, day: prevTokens.day + taskSum },
      })
      console.log(`[worker:${agentId}] usage: ${taskSum} tokens (${usageRows.length} 条记录)`)
    } else {
      await writeStatus({ state: 'idle', current_task: null, progress: 1.0, step: '已完成交付（无 usage 数据）' })
    }
    console.log(`[worker:${agentId}] task ${taskId} done: ${String(result.finalResponse).slice(0, 80)}`)
  } catch (err) {
    await writeStatus({ state: 'error', last_error: String(err), step: '执行失败' })
    console.error(`[worker:${agentId}] task ${taskId} failed:`, err)
  } finally {
    clearInterval(hb)
    try { await harness.close() } catch { /* already closed */ }
  }
}

async function main() {
  await mkdir(agentDir, { recursive: true })
  await mkdir(join(agentDir, 'inbox'), { recursive: true })
  while (true) {
    const control = (await readJson(join(agentDir, 'control.json'))) ?? { enabled: false }
    const task = await claimInbox()
    if (task) {
      await writeStatus({ state: 'running', current_task: task.task_id, progress: 0.05, step: '启动子运行时' })
      await runOne(task)
    } else if (control.enabled !== true) {
      await writeStatus({ state: 'stopped', current_task: null, step: '开关关闭，退出' })
      console.log(`[worker:${agentId}] control disabled, exiting`)
      return
    } else {
      await writeStatus({ state: 'idle', current_task: null, progress: 0, step: '空闲待命' })
      await new Promise(res => setTimeout(res, 2000))
    }
  }
}

main().catch(err => { console.error('[worker] fatal:', err); process.exit(1) })
