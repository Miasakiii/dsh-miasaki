// verify-presets.cjs — 校验 apply-presets.ps1 生成的 agent preset。
//
// 用法：node verify-presets.cjs <agent.cordis.yml 路径>
// 典型：先干跑再校验 ——
//   $env:USERPROFILE = '<临时目录>'; & .\apply-presets.ps1
//   node verify-presets.cjs <临时目录>\.dsh\.agent-presets\whale\agent.cordis.yml
//
// 为什么要自带 schema：preset 里有 DSH 的 `!!js` 自定义标签
//（如 `disabled: !!js process.platform === 'win32'`），标准 js-yaml 会以
// unknown tag 报错。这里注册一个 passthrough 类型把它当字符串读入。
const fs = require('fs')
const path = require('path')

function loadYaml() {
  const candidates = [
    process.env.DSH_JS_YAML,
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/js-yaml'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm/node_modules/js-yaml'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try { return require(candidate) } catch { /* try next */ }
  }
  console.error('找不到 js-yaml；用 DSH_JS_YAML 环境变量指定其路径')
  process.exit(2)
}

const yaml = loadYaml()
const JsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: data => data,
})
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JsType])

const file = process.argv[2]
if (!file) {
  console.error('用法: node verify-presets.cjs <agent.cordis.yml>')
  process.exit(2)
}

const rows = yaml.load(fs.readFileSync(file, 'utf8'), { schema: SCHEMA })
const problems = []

const check = (ok, label) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label)
  if (!ok) problems.push(label)
}

console.log(`文件: ${path.basename(path.dirname(file))}/${path.basename(file)}`)
console.log(`顶层 row: ${rows.length} 个 — ${rows.map(r => r.id).join(',')}`)

const persona = rows.find(r => r.id === 'persona')
const keys = persona ? Object.keys(persona.config) : []
console.log('persona.config:', keys.join(',') || '(缺失)')
check(!!persona, 'persona 行存在')
check(keys.includes('prefix'), 'prefix 存在（0.1.5 必填）')
check(!keys.includes('text'), 'text 已移除（0.1.5 不再支持）')
check(!keys.includes('suffix'), 'suffix 未设（缺省即遮蔽全局后缀）')
if (persona && persona.config.prefix) {
  const p = persona.config.prefix
  check(p.includes('{{model}}'), 'prefix 含 {{model}}')
  check(p.includes('{{cwd}}'), 'prefix 含 {{cwd}}')
  check(p.split('\n').length >= 3, `prefix 是多行块（${p.split('\n').length} 行）`)
}

const byId = id => rows.find(r => r.id === id)
const delegation = byId('delegation')
const sub = delegation && delegation.config.find(r => r.id === 'tool-subagent')
const fork = delegation && delegation.config.find(r => r.id === 'tool-subagent-fork')
check(!!(sub && sub.config.agentOptions), 'tool-subagent 保留 agentOptions（本仓库自定义）')
check(!!(fork && fork.config.agentOptions), 'tool-subagent-fork 保留 agentOptions（本仓库自定义）')
const web = byId('tool-web')
check(!!web && web.config.fetch === false, 'tool-web.fetch 保持 false（本仓库自定义）')

// 0.1.5 底座新增项
check(!!byId('command-goal'), 'command-goal 行存在（0.1.5 新增）')
check(!!byId('present'), 'present 行存在（0.1.5 新增）')

console.log(problems.length === 0 ? '\n全部通过' : `\n${problems.length} 项未通过`)
process.exit(problems.length === 0 ? 0 : 1)
