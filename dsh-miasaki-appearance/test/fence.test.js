import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTrustedHosts, fenceCheck, stripPort } from '../lib/fence.js'

const LOCAL = buildTrustedHosts([])

test('stripPort：去端口并小写', () => {
  assert.equal(stripPort('127.0.0.1:3080'), '127.0.0.1')
  assert.equal(stripPort('LocalHost'), 'localhost')
  assert.equal(stripPort('[::1]:3080'), '[::1]')
  assert.equal(stripPort(''), '')
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
