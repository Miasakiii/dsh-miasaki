// Unit tests for remote path normalization (U2.2, shared by SFTP and the future A1 exec face).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandHomePath, normalizeRemotePath, assertResolvedPath, isPathInside, MAX_PATH_LENGTH } from '../lib/paths.js'

test('normalizeRemotePath: 词法归一 //、.、..', () => {
  assert.deepEqual(normalizeRemotePath('/a//b/./c'), { path: '/a/b/c' })
  assert.deepEqual(normalizeRemotePath('/a/b/../c'), { path: '/a/c' })
  assert.deepEqual(normalizeRemotePath('/'), { path: '/' })
})

test('normalizeRemotePath: 根处的 .. 按 POSIX 语义停在根，绝不弹出根', () => {
  assert.deepEqual(normalizeRemotePath('/..'), { path: '/' })
  assert.deepEqual(normalizeRemotePath('/a/../../b'), { path: '/b' })
  assert.deepEqual(normalizeRemotePath('/../../etc/passwd'), { path: '/etc/passwd' })
})

test('normalizeRemotePath: NUL 与控制字符拒绝（截断/续行逃逸）', () => {
  assert.match(normalizeRemotePath('/a\0b').error, /NUL/)
  assert.match(normalizeRemotePath('/a\nb').error, /控制字符/)
  assert.match(normalizeRemotePath('/a\rb').error, /控制字符/)
})

test('normalizeRemotePath: 超长拒绝，不静默截断', () => {
  const long = `/${'x'.repeat(MAX_PATH_LENGTH + 1)}`
  assert.match(normalizeRemotePath(long).error, /过长/)
})

test('expandHomePath: ~ 与 ~/ 展开，~ 开头但非 ~/ 原样', () => {
  assert.equal(expandHomePath('~', '/home/ops'), '/home/ops')
  assert.equal(expandHomePath('~/logs', '/home/ops'), '/home/ops/logs')
  assert.equal(expandHomePath('~backup/x', '/home/ops'), '~backup/x')
  assert.equal(expandHomePath('~', undefined), '~')
})

test('normalizeRemotePath: ~ 用 homeDir 结算，相对输入用 baseDir 结算', () => {
  assert.deepEqual(normalizeRemotePath('~/a/../b', { homeDir: '/home/ops' }), { path: '/home/ops/b' })
  assert.deepEqual(normalizeRemotePath('a/b', { baseDir: '/srv/app' }), { path: '/srv/app/a/b' })
  assert.match(normalizeRemotePath('a/b').error, /基准目录/)
  assert.match(normalizeRemotePath('', { homeDir: '/h' }).error, /不能为空/)
})

test('isPathInside: 按段比较，防前缀冒充；根恒真', () => {
  assert.equal(isPathInside('/a/b', '/a/b'), true)
  assert.equal(isPathInside('/a/b', '/a/b/c'), true)
  assert.equal(isPathInside('/a/b', '/a/bc'), false, '前缀相同但不是父子')
  assert.equal(isPathInside('/a/b', '/a'), false)
  assert.equal(isPathInside('/', '/anything'), true)
})

test('assertResolvedPath: realpath 之后仍校验绝对性与 NUL', () => {
  assert.deepEqual(assertResolvedPath('/srv/app'), { path: '/srv/app' })
  assert.match(assertResolvedPath('srv/app').error, /非绝对路径/)
  assert.match(assertResolvedPath('/a\0b').error, /NUL/)
})
