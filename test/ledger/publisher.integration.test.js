
'use strict'
import test from 'ava'
import { stringify } from 'querystring'
import {
  ledgerAgent,
  ok
} from '../utils'
import {
  isNumber,
  toNumber
} from 'underscore'
import dotenv from 'dotenv'
dotenv.config()

test('test should redirect to publishers', async t => {
  t.plan(0)
  const publisher = 'espn.com'
  const query = {
    publisher
  }
  const qs = stringify(query)
  const url = `/v3/publisher/identity?${qs}`
  await ledgerAgent.get(url).expect(ok)
})

test('timestamp should redirect to publishers', async t => {
  t.plan(1)
  const url = `/v3/publisher/timestamp`
  const response = await ledgerAgent.get(url).expect(ok)
  const {
    body
  } = response
  const {
    timestamp
  } = body
  t.true(isNumber(+timestamp), 'Response was not a number')
})
