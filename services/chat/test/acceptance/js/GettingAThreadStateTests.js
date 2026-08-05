import { ObjectId } from '../../../app/js/mongodb.js'
import { expect } from 'chai'

import * as ChatClient from './helpers/ChatClient.js'
import * as ChatApp from './helpers/ChatApp.js'

describe('Getting a thread state', function () {
  before(async function () {
    await ChatApp.ensureRunning()
  })

  it('returns absent without exposing any other fields', async function () {
    const projectId = new ObjectId().toString()
    const threadId = new ObjectId().toString()

    const { response, body } = await ChatClient.getThreadState(
      projectId,
      threadId
    )

    expect(response.statusCode).to.equal(200)
    expect(body).to.deep.equal({ state: 'absent' })
  })

  it('returns current for an empty thread room', async function () {
    const projectId = new ObjectId()
    const threadId = new ObjectId()
    await ChatApp.db.rooms.insertOne({
      project_id: projectId,
      thread_id: threadId,
    })

    const { response, body } = await ChatClient.getThreadState(
      projectId.toString(),
      threadId.toString()
    )

    expect(response.statusCode).to.equal(200)
    expect(body).to.deep.equal({ state: 'current' })
  })

  it('returns current without exposing message content', async function () {
    const projectId = new ObjectId().toString()
    const threadId = new ObjectId().toString()
    const userId = new ObjectId().toString()
    const content = 'content that must not cross the state boundary'
    const { response: createResponse } = await ChatClient.sendMessage(
      projectId,
      threadId,
      userId,
      content
    )
    expect(createResponse.statusCode).to.equal(201)

    const { response, body } = await ChatClient.getThreadState(
      projectId,
      threadId
    )

    expect(response.statusCode).to.equal(200)
    expect(body).to.deep.equal({ state: 'current' })
  })

  it('returns resolved without exposing resolver metadata', async function () {
    const projectId = new ObjectId().toString()
    const threadId = new ObjectId().toString()
    const userId = new ObjectId().toString()
    const { response: createResponse } = await ChatClient.sendMessage(
      projectId,
      threadId,
      userId,
      'resolved thread content'
    )
    expect(createResponse.statusCode).to.equal(201)
    const { response: resolveResponse } = await ChatClient.resolveThread(
      projectId,
      threadId,
      userId
    )
    expect(resolveResponse.statusCode).to.equal(204)

    const { response, body } = await ChatClient.getThreadState(
      projectId,
      threadId
    )

    expect(response.statusCode).to.equal(200)
    expect(body).to.deep.equal({ state: 'resolved' })
  })

  it('returns ambiguous when the unique thread belongs to another project', async function () {
    const expectedProjectId = new ObjectId().toString()
    const actualProjectId = new ObjectId().toString()
    const threadId = new ObjectId().toString()
    const userId = new ObjectId().toString()
    const { response: createResponse } = await ChatClient.sendMessage(
      actualProjectId,
      threadId,
      userId,
      'foreign project content'
    )
    expect(createResponse.statusCode).to.equal(201)

    const { response, body } = await ChatClient.getThreadState(
      expectedProjectId,
      threadId
    )

    expect(response.statusCode).to.equal(200)
    expect(body).to.deep.equal({ state: 'ambiguous' })
  })

  it('returns ambiguous when the thread ID belongs to multiple projects', async function () {
    const projectId = new ObjectId().toString()
    const otherProjectId = new ObjectId().toString()
    const threadId = new ObjectId().toString()
    const userId = new ObjectId().toString()
    for (const ownerProjectId of [projectId, otherProjectId]) {
      const { response } = await ChatClient.sendMessage(
        ownerProjectId,
        threadId,
        userId,
        'ambiguous thread content'
      )
      expect(response.statusCode).to.equal(201)
    }

    const { response, body } = await ChatClient.getThreadState(
      projectId,
      threadId
    )

    expect(response.statusCode).to.equal(200)
    expect(body).to.deep.equal({ state: 'ambiguous' })
  })

  it('returns ambiguous for duplicate rooms in the same project', async function () {
    const projectId = new ObjectId()
    const threadId = new ObjectId()
    await ChatApp.db.rooms.insertMany([
      {
        project_id: projectId,
        thread_id: threadId,
      },
      {
        project_id: projectId,
        thread_id: threadId,
      }
    ])

    const { response, body } = await ChatClient.getThreadState(
      projectId.toString(),
      threadId.toString()
    )

    expect(response.statusCode).to.equal(200)
    expect(body).to.deep.equal({ state: 'ambiguous' })
  })

  it('returns a fixed 400 response for an invalid thread ID', async function () {
    const projectId = new ObjectId().toString()

    const { response, body } = await ChatClient.getThreadState(
      projectId,
      'invalid-thread-id'
    )

    expect(response.statusCode).to.equal(400)
    expect(body).to.equal('Invalid threadId')
  })

  it('returns a fixed 500 response without exposing storage errors', async function () {
    const projectId = new ObjectId()
    const threadId = new ObjectId()
    await ChatApp.db.rooms.insertOne({
      project_id: 'invalid-project-id',
      thread_id: threadId,
    })

    const { response, body } = await ChatClient.getThreadState(
      projectId.toString(),
      threadId.toString()
    )

    expect(response.statusCode).to.equal(500)
    expect(body).to.deep.equal({ error: 'thread_state_unavailable' })
  })
})
