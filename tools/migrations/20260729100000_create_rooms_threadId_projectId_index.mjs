/* eslint-disable no-unused-vars */

import Helpers from './lib/helpers.mjs'

const tags = ['server-ce', 'server-pro', 'saas']

const indexes = [
  {
    key: {
      thread_id: 1,
      project_id: 1,
    },
    name: 'thread_id_1_project_id_1',
  },
]

const migrate = async client => {
  const { db } = client
  await Helpers.addIndexesToCollection(db.rooms, indexes)
}

const rollback = async client => {
  const { db } = client
  await Helpers.dropIndexesFromCollection(db.rooms, indexes)
}

export default {
  tags,
  migrate,
  rollback,
}
