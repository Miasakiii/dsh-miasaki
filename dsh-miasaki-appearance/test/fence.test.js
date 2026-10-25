import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrustedHosts, fenceCheck, isTrustedHost, splitHostPort, stripPort } from '../lib/fence.js'

const LOCAL = buildTrustedHosts([])

test('stripPort：去端口并小写', () => {
  assert.equal(stripPort('127.0.0.1:3080'), '127.0.0.1')
  assert.equal(stripPort('LocalHost'), 'localhost')
  assert.equal(stripPort('[::1]:3080'), '[::1]')
  assert.equal(stripPort(''), '')
})

test('splitHostPort：hostname / 端口拆分（IPv6 保留方括号）', () => {
  assert.deepEqual(splitHostPort('127.0.0.1:3080'), { hostname: '127.0.0.1', port: '3080' })
  assert.deepEqual(splitHostPort('LocalHost'), { hostname: 'localhost', port: null })
  assert.deepEqual(splitHostPort('[::1]:3080'), { hostname: '[::1]', port: '3080' })
  assert.deepEqual(splitHostPort('[::1]'), { hostname: '[::1]', port: null })
  assert.deepEqual(splitHostPort('127.0.0.1:not-a-port'), { hostname: '127.0.0.1', port: null })
  assert.deepEqual(splitHostPort(undefined), { hostname: '', port: null })
})

test('isTrustedHost：只查 Host（文件路由用；不要求 Origin）', () => {
  assert.equal(isTrustedHost('127.0.0.1:3080', LOCAL), true)
  assert.equal(isTrustedHost('localhost:3080', LOCAL), true)
  assert.equal(isTrustedHost('evil.example:3080', LOCAL), false)
  assert.equal(isTrustedHost('', LOCAL), false)
  assert.equal(isTrustedHost(undefined, LOCAL), false)
  assert.equal(isTrustedHost('dev.box:3080', buildTrustedHosts(['dev.box'])), true)
})

test('fenceCheck：放行环回来源', () => {
  assert.equal(fenceCheck({ host: '127.0.0.1:3080' }, LOCAL).ok, true)
  assert.equal(fenceCheck({ host: 'localhost:3080' }, LOCAL).ok, true)
  assert.equal(fenceCheck({ host: 'localhost:3080', origin: 'http://localhost:3080' }, LOCAL).ok, true)
  assert.equal(fenceCheck({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, LOCAL).ok, true)
})

test('fenceCheck：拒绝非环回 Host', () => {
  const verdict = fenceCheck({ host: '192.168.1.9:3080' }, LOCAL)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'untrusted-host')
})

test('fenceCheck：trustedHosts 可显式放行', () => {
  const trusted = buildTrustedHosts([' Dev.Box ', ''])
  assert.equal(fenceCheck({ host: 'dev.box:3080' }, trusted).ok, true)
  assert.equal(fenceCheck({ host: 'other.box:3080' }, trusted).ok, false)
})

test('fenceCheck：拒绝跨站与不匹配 Origin', () => {
  assert.equal(fenceCheck({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, LOCAL).reason, 'cross-site')
  assert.equal(fenceCheck({ host: '127.0.0.1:3080', origin: 'http://evil.example.com' }, LOCAL).reason, 'untrusted-origin')
  assert.equal(fenceCheck({ host: '127.0.0.1:3080', origin: '不是 URL' }, LOCAL).reason, 'bad-origin')
})

test('fenceCheck：缺头或空头时不抛异常', () => {
  assert.equal(fenceCheck(undefined, LOCAL).ok, false)
  assert.equal(fenceCheck({}, LOCAL).ok, false)
})

// ---------------------------------------------------------------------------
// 2026-10-19 安全加固（扫描报告 04af2）：同站跨端口页面（same-site + 无预检的
// text/plain POST）此前能改外观配置。修复按 FIX-SPEC §2：端口判据 + 删除回环豁免。
test('fenceCheck：拒绝同站跨端口 Origin（04af2）', () => {
  const verdict = fenceCheck({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:5173' }, LOCAL)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'cross-port-origin')
  assert.equal(
    fenceCheck({ host: 'localhost:3080', origin: 'http://localhost:5173' }, LOCAL).reason,
    'cross-port-origin',
  )
  // trustedHosts 放行的主机同样按端口判
  const trusted = buildTrustedHosts(['dev.box'])
  assert.equal(
    fenceCheck({ host: 'dev.box:3080', origin: 'http://dev.box:5173' }, trusted).reason,
    'cross-port-origin',
  )
  assert.equal(fenceCheck({ host: 'dev.box:3080', origin: 'http://dev.box:3080' }, trusted).ok, true)
})

test('fenceCheck：删除回环豁免 —— Origin hostname 必须等于 Host hostname（04af2）', () => {
  assert.equal(
    fenceCheck({ host: '127.0.0.1:3080', origin: 'http://localhost:3080' }, LOCAL).reason,
    'untrusted-origin',
  )
  assert.equal(
    fenceCheck({ host: 'localhost:3080', origin: 'http://127.0.0.1:3080' }, LOCAL).reason,
    'untrusted-origin',
  )
  // 同主机同端口仍然放行
  assert.equal(fenceCheck({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, LOCAL).ok, true)
  assert.equal(fenceCheck({ host: 'localhost:3080', origin: 'http://localhost:3080' }, LOCAL).ok, true)
})

test('fenceCheck：Origin 无端口（Chromium 端口剥离）按 hostname 判定放行（04af2 兼容）', () => {
  assert.equal(fenceCheck({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1' }, LOCAL).ok, true)
  assert.equal(fenceCheck({ host: 'localhost:3080', origin: 'http://localhost' }, LOCAL).ok, true)
  // 同源无端口（80）也放行
  assert.equal(fenceCheck({ host: '127.0.0.1:80', origin: 'http://127.0.0.1' }, LOCAL).ok, true)
  // Host 未带端口时按 Origin 协议默认端口比：http 默认 80，https 显式 443 亦放行
  assert.equal(fenceCheck({ host: '127.0.0.1', origin: 'http://127.0.0.1:80' }, LOCAL).ok, true)
  assert.equal(fenceCheck({ host: '127.0.0.1', origin: 'https://127.0.0.1:443' }, LOCAL).ok, true)
  // Host 未带端口但 Origin 显式非默认端口 ⇒ 拒
  assert.equal(fenceCheck({ host: '127.0.0.1', origin: 'http://127.0.0.1:3080' }, LOCAL).reason, 'cross-port-origin')
})
