import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contentHasImage, messagesHaveImage, deriveAgentMessages } from '../lib/content.js'

const image = { type: 'image', attachment: { attachmentId: 'sha256:x' } }
const text = { type: 'text', text: 'hello' }

test('contentHasImage：直接命中', () => {
  assert.equal(contentHasImage([text, image]), true)
  assert.equal(contentHasImage([text]), false)
  assert.equal(contentHasImage([]), false)
})

test('contentHasImage：下钻 tool-result 的嵌套内容（与官方同语义）', () => {
  assert.equal(contentHasImage([{ type: 'tool-result', toolCallId: 't1', content: [image] }]), true)
  assert.equal(contentHasImage([{ type: 'tool-result', toolCallId: 't1', content: [text] }]), false)
})

test('contentHasImage：多层嵌套同样命中', () => {
  const nested = [{
    type: 'tool-result',
    toolCallId: 't1',
    content: [{ type: 'tool-result', toolCallId: 't2', content: [text, image] }],
  }]
  assert.equal(contentHasImage(nested), true)
})

test('contentHasImage：对非数组与脏输入安全', () => {
  assert.equal(contentHasImage(undefined), false)
  assert.equal(contentHasImage(null), false)
  assert.equal(contentHasImage('nope'), false)
  assert.equal(contentHasImage([null, 42, 'x']), false)
})

test('messagesHaveImage：任一消息含图即为真', () => {
  assert.equal(messagesHaveImage([{ content: [text] }, { content: [image] }]), true)
  assert.equal(messagesHaveImage([{ content: [text] }]), false)
  assert.equal(messagesHaveImage([]), false)
  assert.equal(messagesHaveImage(undefined), false)
})

test('deriveAgentMessages：正常读取 session.deriveMessages()', () => {
  const agent = { session: { deriveMessages: () => [{ content: [image] }] } }
  assert.equal(deriveAgentMessages(agent).length, 1)
})

test('deriveAgentMessages：缺 session / 缺方法 / 抛错 一律回退空数组（保守不路由）', () => {
  assert.deepEqual(deriveAgentMessages({}), [])
  assert.deepEqual(deriveAgentMessages({ session: {} }), [])
  assert.deepEqual(deriveAgentMessages({ session: { deriveMessages: () => 'not-an-array' } }), [])
  assert.deepEqual(deriveAgentMessages({ session: { deriveMessages: () => { throw new Error('boom') } } }), [])
  assert.deepEqual(deriveAgentMessages(null), [])
})
