'use strict'
import BigNumber from 'bignumber.js'
import UpholdSDK from '@uphold/uphold-sdk-javascript'
import anonize from 'node-anonize2-relic'
import crypto from 'crypto'
import request from 'supertest'
import { serial as test } from 'ava'
import tweetnacl from 'tweetnacl'
import { stringify } from 'querystring'
import uuid from 'uuid'
import { sign } from 'http-request-signature'
import _ from 'underscore'
import {
  owner,
  publisher,
  req,
  ok
} from './setup.test'
import dotenv from 'dotenv'
dotenv.config()
const createFormURL = (params) => (pathname, p) => `${pathname}?${stringify(_.extend({}, params, p || {}))}`
const formURL = createFormURL({
  format: 'json',
  summary: true,
  balance: true,
  verified: true,
  amount: 0,
  currency: 'USD'
})

function uint8tohex (arr) {
  var strBuilder = []
  arr.forEach(function (b) { strBuilder.push(('00' + b.toString(16)).substr(-2)) })
  return strBuilder.join('')
}

const timeout = ms => new Promise(resolve => setTimeout(resolve, ms))
const srv = { listener: process.env.BAT_LEDGER_SERVER || 'https://ledger-staging.mercury.basicattentiontoken.org' }

test('check verification status of new publisher', async t => {
  const eyeshade = process.env.BAT_EYESHADE_SERVER
  // /v1/publishers/{publisher}/verify
  const url = `/v1/publishers/${encodeURIComponent(publisher)}/verify`
  const result = await request(eyeshade).get(url)
  const { body } = result
  console.log(body)
})

test('create a promotion', async t => {
  t.plan(0)
  const url = '/v1/grants'
  const data = {'grants': [ 'eyJhbGciOiJFZERTQSIsImtpZCI6IiJ9.eyJhbHRjdXJyZW5jeSI6IkJBVCIsImdyYW50SWQiOiJhNDMyNjg1My04NzVlLTQ3MDgtYjhkNS00M2IwNGMwM2ZmZTgiLCJwcm9iaSI6IjMwMDAwMDAwMDAwMDAwMDAwMDAwIiwicHJvbW90aW9uSWQiOiI5MDJlN2U0ZC1jMmRlLTRkNWQtYWFhMy1lZThmZWU2OWY3ZjMiLCJtYXR1cml0eVRpbWUiOjE1MTUwMjkzNTMsImV4cGlyeVRpbWUiOjE4MzAzODkzNTN9.8M5dpr_rdyCURd7KBc4GYaFDsiDEyutVqG-mj1QRk7BCiihianvhiqYeEnxMf-F4OU0wWyCN5qKDTxeqait_BQ' ], 'promotions': [{'active': true, 'priority': 0, 'promotionId': '902e7e4d-c2de-4d5d-aaa3-ee8fee69f7f3'}]}
  await request(srv.listener).post(url).set('Authorization', 'Bearer foobarfoobar').send(data).expect(ok)
})
// FIXME assert has env vars set and is using uphold
// NOTE this requires a contibution surveyor to have already been created

test('create an owner', async t => {
  t.plan(2)
  const domain = process.env.BAT_EYESHADE_SERVER
  const ownerName = 'venture'
  const url = '/v1/owners'
  const name = ownerName
  const email = 'mmclaughlin@brave.com'
  const phone = '+16122458588'
  const ownerEmail = email
  const authorizer = {
    owner,
    ownerEmail,
    ownerName
  }
  const contactInfo = {
    name,
    email,
    phone
  }
  const provider = {
    publisher
  }
  const providers = [provider]
  const data = {
    authorizer,
    contactInfo,
    providers
  }
  const options = {
    url,
    method: 'post',
    domain
  }
  const result = await req(options).send(data)
  const { status, body } = result
  t.true(status === 200)
  t.true(_.isObject(body))
})
test('tie owner to publisher', async t => {
  t.plan(1)
  const domain = process.env.BAT_EYESHADE_SERVER
  const url = `/v1/owners/${encodeURIComponent(owner)}/wallet`
  const method = 'put'
  const options = { url, method, domain }
  const provider = publisher
  const parameters = {}
  const defaultCurrency = 'BAT'
  const data = { provider, parameters, defaultCurrency }
  const result = await req(options).send(data)
  const { status } = result
  t.true(status === 200)
})
test('integration : v2 contribution workflow with uphold BAT wallet', async t => {
  const personaId = uuid.v4().toLowerCase()
  const viewingId = uuid.v4().toLowerCase()

  var response = await request(srv.listener).get('/v2/registrar/persona').expect(ok)
  t.true(response.body.hasOwnProperty('registrarVK'))
  const personaCredential = new anonize.Credential(personaId, response.body.registrarVK)

  const keypair = tweetnacl.sign.keyPair()
  console.log('created new ed25519 keypair')
  console.log(JSON.stringify({
    'publicKey': uint8tohex(keypair.publicKey),
    'secretKey': uint8tohex(keypair.secretKey)
  }))

  const body = {
    label: uuid.v4().toLowerCase(),
    currency: 'BAT',
    publicKey: uint8tohex(keypair.publicKey)
  }
  var octets = JSON.stringify(body)
  var headers = {
    digest: 'SHA-256=' + crypto.createHash('sha256').update(octets).digest('base64')
  }

  headers['signature'] = sign({
    headers: headers,
    keyId: 'primary',
    secretKey: uint8tohex(keypair.secretKey)
  }, { algorithm: 'ed25519' })

  var payload = { requestType: 'httpSignature',
    request: {
      body: body,
      headers: headers,
      octets: octets
    },
    proof: personaCredential.request()
  }
  response = await request(srv.listener).post('/v2/registrar/persona/' + personaCredential.parameters.userId)
    .send(payload).expect(ok)
  t.true(response.body.hasOwnProperty('wallet'))
  const paymentId = response.body.wallet.paymentId
  t.true(response.body.wallet.hasOwnProperty('paymentId'))
  t.true(response.body.wallet.hasOwnProperty('addresses'))
  t.true(response.body.hasOwnProperty('verification'))

  t.true(response.body.wallet.addresses.hasOwnProperty('BAT'))
  t.true(response.body.wallet.addresses.hasOwnProperty('BTC'))
  t.true(response.body.wallet.addresses.hasOwnProperty('CARD_ID'))
  t.true(response.body.wallet.addresses.hasOwnProperty('ETH'))
  t.true(response.body.wallet.addresses.hasOwnProperty('LTC'))
  const userCardId = response.body.wallet.addresses.CARD_ID

  personaCredential.finalize(response.body.verification)

  response = await request(srv.listener).get('/v2/wallet?publicKey=' + uint8tohex(keypair.publicKey))
    .expect(ok)
  t.true(response.body.paymentId === paymentId)

  response = await request(srv.listener)
    .get('/v2/surveyor/contribution/current/' + personaCredential.parameters.userId)
    .expect(ok)

  t.true(response.body.hasOwnProperty('surveyorId'))
  const surveyorId = response.body.surveyorId

  t.true(response.body.hasOwnProperty('payload'))
  t.true(response.body.payload.hasOwnProperty('adFree'))
  t.true(response.body.payload.adFree.hasOwnProperty('probi'))
  const donateAmt = new BigNumber(response.body.payload.adFree.probi).dividedBy('1e18').toNumber()

  do { // This depends on currency conversion rates being available, retry until then are available
    response = await request(srv.listener)
      .get('/v2/wallet/' + paymentId + '?refresh=true&amount=1&currency=USD')
    if (response.status === 503) await timeout(response.headers['retry-after'] * 1000)
  } while (response.status === 503)
  var err = ok(response)
  if (err) throw err

  t.true(response.body.hasOwnProperty('balance'))
  t.is(response.body.balance, '0.0000')

  const desired = donateAmt.toFixed(4).toString()

  const upholdBaseUrls = {
    'prod': 'https://api.uphold.com',
    'sandbox': 'https://api-sandbox.uphold.com'
  }
  const environment = process.env.UPHOLD_ENVIRONMENT || 'sandbox'

  const uphold = new UpholdSDK({ // eslint-disable-line new-cap
    baseUrl: upholdBaseUrls[environment],
    clientId: 'none',
    clientSecret: 'none'
  })
  // have to do some hacky shit to use a personal access token
  uphold.storage.setItem('uphold.access_token', process.env.UPHOLD_ACCESS_TOKEN)
  const donorCardId = process.env.UPHOLD_DONOR_CARD_ID

  await uphold.createCardTransaction(donorCardId,
    {'amount': desired, 'currency': 'BAT', 'destination': userCardId},
    true // commit tx in one swoop
  )

  do {
    response = await request(srv.listener)
      .get(`/v2/wallet/${paymentId}?refresh=true&amount=${desired}&altcurrency=BAT`)
    if (response.status === 503) await timeout(response.headers['retry-after'] * 1000)
    else if (response.body.balance === '0.0000') await timeout(500)
  } while (response.status === 503 || response.body.balance === '0.0000')
  err = ok(response)
  if (err) throw err

  t.is(Number(response.body.unsignedTx.denomination.amount), Number(desired))

  // ensure that transactions out of the restricted user card require a signature
  // by trying to send back to the donor card
  await t.throws(uphold.createCardTransaction(userCardId,
    {'amount': desired, 'currency': 'BAT', 'destination': donorCardId},
    true // commit tx in one swoop
  ))

  octets = JSON.stringify(response.body.unsignedTx)
  headers = {
    digest: 'SHA-256=' + crypto.createHash('sha256').update(octets).digest('base64')
  }

  headers['signature'] = sign({
    headers: headers,
    keyId: 'primary',
    secretKey: uint8tohex(keypair.secretKey)
  }, { algorithm: 'ed25519' })

  payload = { requestType: 'httpSignature',
    signedTx: {
      body: body,
      headers: headers,
      octets: octets
    },
    surveyorId: surveyorId,
    viewingId: viewingId
  }

  do { // Contribution surveyor creation is handled asynchonously, this API will return 503 until ready
    if (response.status === 503) {
      await timeout(response.headers['retry-after'] * 1000)
    }
    response = await request(srv.listener)
      .put('/v2/wallet/' + paymentId)
      .send(payload)
  } while (response.status === 503)
  err = ok(response)
  if (err) throw err

  t.false(response.body.hasOwnProperty('satoshis'))
  t.true(response.body.hasOwnProperty('altcurrency'))
  t.true(response.body.hasOwnProperty('probi'))

  response = await request(srv.listener)
    .get('/v2/registrar/viewing')
    .expect(ok)

  t.true(response.body.hasOwnProperty('registrarVK'))
  const viewingCredential = new anonize.Credential(viewingId, response.body.registrarVK)

  do { // Contribution surveyor creation is handled asynchonously, this API will return 503 until ready
    if (response.status === 503) {
      await timeout(response.headers['retry-after'] * 1000)
    }
    response = await request(srv.listener)
      .post('/v2/registrar/viewing/' + viewingCredential.parameters.userId)
      .send({ proof: viewingCredential.request() })
  } while (response.status === 503)
  err = ok(response)
  if (err) throw err

  t.true(response.body.hasOwnProperty('surveyorIds'))
  const surveyorIds = response.body.surveyorIds
  t.true(surveyorIds.length >= 5)

  viewingCredential.finalize(response.body.verification)

  const votes = ['wikipedia.org', 'reddit.com', 'youtube.com', 'ycombinator.com', 'google.com', publisher]
  for (var i = 0; i < surveyorIds.length; i++) {
    const id = surveyorIds[i]
    response = await request(srv.listener)
      .get('/v2/surveyor/voting/' + encodeURIComponent(id) + '/' + viewingCredential.parameters.userId)
      .expect(ok)

    const surveyor = new anonize.Surveyor(response.body)
    response = await request(srv.listener)
      .put('/v2/surveyor/voting/' + encodeURIComponent(id))
      .send({'proof': viewingCredential.submit(surveyor, { publisher: votes[i % votes.length] })})
      .expect(ok)
  }
})

test('integration : v2 grant contribution workflow with uphold BAT wallet', async t => {
  const personaId = uuid.v4().toLowerCase()
  const viewingId = uuid.v4().toLowerCase()

  var response = await request(srv.listener).get('/v2/registrar/persona').expect(ok)
  t.true(response.body.hasOwnProperty('registrarVK'))
  const personaCredential = new anonize.Credential(personaId, response.body.registrarVK)

  const keypair = tweetnacl.sign.keyPair()
  console.log('created new ed25519 keypair')
  console.log(JSON.stringify({
    'publicKey': uint8tohex(keypair.publicKey),
    'secretKey': uint8tohex(keypair.secretKey)
  }))

  const body = {
    label: uuid.v4().toLowerCase(),
    currency: 'BAT',
    publicKey: uint8tohex(keypair.publicKey)
  }
  var octets = JSON.stringify(body)
  var headers = {
    digest: 'SHA-256=' + crypto.createHash('sha256').update(octets).digest('base64')
  }

  headers['signature'] = sign({
    headers: headers,
    keyId: 'primary',
    secretKey: uint8tohex(keypair.secretKey)
  }, { algorithm: 'ed25519' })

  var payload = { requestType: 'httpSignature',
    request: {
      body: body,
      headers: headers,
      octets: octets
    },
    proof: personaCredential.request()
  }
  response = await request(srv.listener).post('/v2/registrar/persona/' + personaCredential.parameters.userId)
    .send(payload).expect(ok)
  t.true(response.body.hasOwnProperty('wallet'))
  const paymentId = response.body.wallet.paymentId
  t.true(response.body.wallet.hasOwnProperty('paymentId'))
  t.true(response.body.wallet.hasOwnProperty('addresses'))
  t.true(response.body.hasOwnProperty('verification'))

  t.true(response.body.wallet.addresses.hasOwnProperty('BAT'))
  t.true(response.body.wallet.addresses.hasOwnProperty('BTC'))
  t.true(response.body.wallet.addresses.hasOwnProperty('CARD_ID'))
  t.true(response.body.wallet.addresses.hasOwnProperty('ETH'))
  t.true(response.body.wallet.addresses.hasOwnProperty('LTC'))

  personaCredential.finalize(response.body.verification)

  response = await request(srv.listener)
    .get('/v2/surveyor/contribution/current/' + personaCredential.parameters.userId)
    .expect(ok)

  t.true(response.body.hasOwnProperty('surveyorId'))
  const surveyorId = response.body.surveyorId

  t.true(response.body.hasOwnProperty('payload'))
  t.true(response.body.payload.hasOwnProperty('adFree'))
  t.true(response.body.payload.adFree.hasOwnProperty('probi'))
  // const donateAmt = new BigNumber(response.body.payload.adFree.probi).dividedBy('1e18').toNumber()

  // get available grant
  response = await request(srv.listener)
    .get('/v1/grants')
    .expect(ok)

  t.true(response.body.hasOwnProperty('promotionId'))

  const promotionId = response.body.promotionId

  // request grant
  response = await request(srv.listener)
      .put(`/v1/grants/${paymentId}`)
      .send({'promotionId': promotionId})
      .expect(ok)
  console.log(response.body)
  t.true(response.body.hasOwnProperty('probi'))

  const donateAmt = new BigNumber(response.body.probi).dividedBy('1e18').toNumber()
  const desired = donateAmt.toString()

  // try re-claiming grant, should return ok
  response = await request(srv.listener)
      .put(`/v1/grants/${paymentId}`)
      .send({'promotionId': promotionId})
      .expect(ok)

  do {
    response = await request(srv.listener)
      .get(`/v2/wallet/${paymentId}?refresh=true&amount=${desired}&altcurrency=BAT`)
    if (response.status === 503) await timeout(response.headers['retry-after'] * 1000)
    else if (response.body.balance === '0.0000') await timeout(500)
  } while (response.status === 503 || response.body.balance === '0.0000')
  var err = ok(response)
  if (err) throw err

  t.is(Number(response.body.unsignedTx.denomination.amount), Number(desired))

  octets = JSON.stringify(response.body.unsignedTx)
  headers = {
    digest: 'SHA-256=' + crypto.createHash('sha256').update(octets).digest('base64')
  }

  headers['signature'] = sign({
    headers: headers,
    keyId: 'primary',
    secretKey: uint8tohex(keypair.secretKey)
  }, { algorithm: 'ed25519' })

  payload = { requestType: 'httpSignature',
    signedTx: {
      body: body,
      headers: headers,
      octets: octets
    },
    surveyorId: surveyorId,
    viewingId: viewingId
  }

  do { // Contribution surveyor creation is handled asynchonously, this API will return 503 until ready
    if (response.status === 503) {
      await timeout(response.headers['retry-after'] * 1000)
    }
    response = await request(srv.listener)
      .put('/v2/wallet/' + paymentId)
      .send(payload)
  } while (response.status === 503)
  err = ok(response)
  if (err) throw err

  t.false(response.body.hasOwnProperty('satoshis'))
  t.true(response.body.hasOwnProperty('altcurrency'))
  t.true(response.body.hasOwnProperty('probi'))

  response = await request(srv.listener)
    .get('/v2/registrar/viewing')
    .expect(ok)

  t.true(response.body.hasOwnProperty('registrarVK'))
  const viewingCredential = new anonize.Credential(viewingId, response.body.registrarVK)

  do { // Contribution surveyor creation is handled asynchonously, this API will return 503 until ready
    if (response.status === 503) {
      await timeout(response.headers['retry-after'] * 1000)
    }
    response = await request(srv.listener)
      .post('/v2/registrar/viewing/' + viewingCredential.parameters.userId)
      .send({ proof: viewingCredential.request() })
  } while (response.status === 503)
  err = ok(response)
  if (err) throw err

  t.true(response.body.hasOwnProperty('surveyorIds'))
  const surveyorIds = response.body.surveyorIds
  t.true(surveyorIds.length >= 5)

  viewingCredential.finalize(response.body.verification)

  const votes = ['wikipedia.org', 'reddit.com', 'youtube.com', 'ycombinator.com', 'google.com', publisher]
  // const votes = ['basicattentiontoken.org']
  for (var i = 0; i < surveyorIds.length; i++) {
    let id = surveyorIds[i]
    let publisher = votes[i % votes.length]
    response = await request(srv.listener)
      .get('/v2/surveyor/voting/' + encodeURIComponent(id) + '/' + viewingCredential.parameters.userId)
      .expect(ok)

    const surveyor = new anonize.Surveyor(response.body)
    response = await request(srv.listener)
      .put('/v2/surveyor/voting/' + encodeURIComponent(id))
      .send({'proof': viewingCredential.submit(surveyor, { publisher })})
      .expect(ok)
  }
})
test('ensure GET /v1/owners/{owner}/wallet computes correctly', async t => {
  t.plan(4)
  const domain = process.env.BAT_EYESHADE_SERVER
  const wallet = `/v1/owners/${encodeURIComponent(owner)}/wallet`
  const ownerOptions = {
    url: wallet,
    domain,
    expect: true
  }
  const initWalletResults = await req(ownerOptions)
  const initWalletBody = initWalletResults.body
  const initContributions = initWalletBody.contributions
  const initRates = initWalletBody.rates
  const {
    USD
  } = initRates
  const initWalletProbi = initContributions.probi
  // settle half of the bat
  const settlementURL = `/v2/publishers/settlement`
  const method = 'post'
  const altcurrency = 'BAT'
  const probi = new BigNumber(initWalletProbi)
  const bigUSD = new BigNumber(String(USD))
  const halfUSD = probi.dividedBy(1e18).times(bigUSD)
  const probiString = probi.toString()
  const halfUSDString = halfUSD.toString()
  const type = 'contribution'
  const settlementOptions = {
    url: settlementURL,
    method,
    domain,
    expect: true
  }
  const datum = {
    owner,
    publisher,
    altcurrency,
    probi: probiString,
    amount: halfUSDString,
    type
  }
  const settlementDatum = contribution(datum)
  const settlementData = [settlementDatum]
  await req(settlementOptions).send(settlementData)
  const referralTransactionID = uuid.v4()
  const referralURL = `/v1/referrals/${referralTransactionID}`
  const referralOptions = {
    method: 'put',
    url: referralURL,
    domain
  }
  const referralDatum = {
    channelId: publisher,
    downloadId: uuid.v4(),
    platform: '1234',
    finalized: (new Date()).toISOString()
  }
  const referralData = [referralDatum]
  await req(referralOptions).send(referralData)
  const refPubPathname = '/v1/reports/publishers/referrals'
  const includeUnpayable = true
  const urlQuery = {
    includeUnpayable
  }
  const refPubURL = formURL(refPubPathname, urlQuery)
  const refPubOptions = {
    url: refPubURL,
    domain
  }
  const refPubResult = await req(refPubOptions)
  const refPubBody = refPubResult.body
  const refPubReportId = refPubBody.reportId
  const refPubReportResult = await fetchReport({
    reportId: refPubReportId,
    domain
  })
  const refPubReportBody = refPubReportResult.body
  t.true(refPubReportBody.length > 0)
  const singleEntry = _.findWhere(refPubReportBody, {
    publisher,
    owner
  })
  const refProbi = singleEntry.probi
  const refFees = singleEntry.fees
  t.is(refFees, '0')
  const finalWalletResults = await req(ownerOptions)
  const finalWalletBody = finalWalletResults.body
  const finalWalletContribs = finalWalletBody.contributions
  const finalWalletProbi = finalWalletContribs.probi
  const usdAmount = finalWalletContribs.amount
  t.is(finalWalletProbi, refProbi)
  t.is(usdAmount, '5.00')

  function contribution (base) {
    return _.extend({
      address: uuid.v4(),
      transactionId: uuid.v4(),
      hash: uuid.v4()
    }, base)
  }
})
test('remove newly created owner', async t => {
  t.plan(1)
  const domain = process.env.BAT_EYESHADE_SERVER
  const encodedOwner = encodeURIComponent(owner)
  const encodedPublisher = encodeURIComponent(publisher)
  const url = `/v1/owners/${encodedOwner}/${encodedPublisher}`
  const method = 'delete'
  const options = { method, url, domain }
  const result = await req(options)
  const {
    status
  } = result
  t.true(status === 200)
})

// write an abstraction for the do while loops
async function tryAfterMany (ms, theDoBlock, theCatchBlock) {
  let tryagain = null
  let result = null
  do {
    tryagain = false
    try {
      result = await theDoBlock()
      tryagain = theCatchBlock(null, result)
    } catch (e) {
      tryagain = theCatchBlock(e, result)
    }
    if (tryagain) {
      await timeout(ms)
    }
  } while (tryagain)
  return result
}

async function fetchReport ({
  domain,
  reportId,
  isCSV
}) {
  let url = `/v1/reports/file/${reportId}`
  return tryAfterMany(5000,
    () => req({ url, domain }),
    (e, result) => {
      if (e) {
        throw e
      }
      const { statusCode, headers } = result
      if (isCSV) {
        return headers['content-type'].indexOf('text/csv') === -1
      }
      if (statusCode < 400) {
        return false
      }
      const tryagain = statusCode === 404
      if (!tryagain) {
        throw result
      }
      return tryagain
    })
}
