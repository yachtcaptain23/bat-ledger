
'use strict'
import BigNumber from 'bignumber.js'
import UpholdSDK from '@uphold/uphold-sdk-javascript'
import anonize from 'node-anonize2-relic'
import crypto from 'crypto'
import request from 'supertest'
import test from 'ava'
import tweetnacl from 'tweetnacl'
import { stringify } from 'querystring'
import uuid from 'uuid'
import { sign } from 'http-request-signature'
import _ from 'underscore'
import {
  ledgerAgent,
  ok
} from '../setup.test'
import dotenv from 'dotenv'
dotenv.config()

test('test should redirect to publishers', async t => {
  const domain = process.env.BAT_LEDGER_SERVER
  t.plan(0)
  const publisher = 'espn.com'
  const query = {
    publisher
  }
  const qs = stringify(query)
  const url = `/v3/publisher/identity?${qs}`
  await ledgerAgent.get(url).expect(ok)
})

test('test should redirect to publishers', async t => {
  const domain = process.env.BAT_LEDGER_SERVER
  t.plan(0)
  const publisher = 'espn.com'
  const query = {
    publisher
  }
  const qs = stringify(query)
  const url = `/v3/publisher/identity?${qs}`
  await ledgerAgent.get(url).expect(ok)
})
