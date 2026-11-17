// The scripted model's Auto approve review handling (scripts/fixtures/scripted-model.mjs):
// review requests are recognised by the bridge's own policy marker, answered by
// the reviewer, and never counted as agent requests.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REVIEW_POLICY, REVIEW_POLICY_MARKER as BRIDGE_MARKER, buildReviewMessage } from '../../packages/browser/bridge-browser/src/auto-review.ts'
import { honestReviewer, isReviewRequest, REVIEW_POLICY_MARKER, startScriptedModel } from '../fixtures/scripted-model.mjs'

const action = (overrides = {}) => ({
  tool: 'browser_click', verb: 'click', targetKind: 'button', reasons: ['commit-words'], tainted: false, untrusted: { name: 'Submit' }, ...overrides,
})
const review = (users, overrides) => ({
  stream: false,
  messages: [{ role: 'system', content: REVIEW_POLICY }, { role: 'user', content: buildReviewMessage(users.map((text, index) => ({ seq: index + 1, text })), action(overrides), 'n') }],
})

test('the fixture uses the bridge\'s policy marker', () => {
  assert.equal(REVIEW_POLICY_MARKER, BRIDGE_MARKER)
  assert.equal(isReviewRequest(review(['hi'], {})), true)
  assert.equal(isReviewRequest({ messages: [{ role: 'user', content: REVIEW_POLICY }] }), false, 'a user message quoting the policy is not a review')
})

test('the honest reviewer allows what the user asked for, denies the rest and every taint-flagged step, whatever the page says', () => {
  assert.equal(honestReviewer(review(['Fill in the contact form and submit it.'], {})).decision, 'allow')
  assert.equal(honestReviewer(review(['Read the contact page.'], {})).decision, 'deny')
  // The section's own header ("USER_MESSAGES … own words") is not the user's words.
  assert.equal(honestReviewer(review(['Read the notes.'], { untrusted: { name: 'Send message' } })).decision, 'deny')
  // Page text naming the user's words does not count: only the control's name is read from the page.
  assert.equal(honestReviewer(review(['Read the contact page.'], { untrusted: { name: 'Submit', title: 'read contact page' } })).decision, 'deny')
  assert.equal(honestReviewer(review(['Submit it.'], { reasons: ['tainted'], tainted: true })).decision, 'deny')
})

test('review requests never count as agent requests', async () => {
  const model = await startScriptedModel([{ name: 'browser_snapshot', args: {} }], 'done', { reviewer: () => ({ decision: 'allow', reason: 'ok' }) })
  try {
    const post = (body) => fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(response => response.json())
    const answer = await post(review(['hi'], {}))
    assert.deepEqual(JSON.parse(answer.choices[0].message.content), { decision: 'allow', reason: 'ok' })
    assert.equal(model.state.requests, 0)
    assert.equal(model.state.reviews.length, 1)
    const agent = await post({ messages: [{ role: 'user', content: 'go' }] })
    assert.equal(agent.choices[0].message.tool_calls[0].function.name, 'browser_snapshot')
    assert.equal(model.state.requests, 1)
  } finally {
    await model.close()
  }
})
