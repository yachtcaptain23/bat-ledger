const BigNumber = require('bignumber.js')
const bson = require('bson')
const dateformat = require('dateformat')
const json2csv = require('json2csv')
const moment = require('moment')
const underscore = require('underscore')
const uuid = require('uuid')

const braveExtras = require('bat-utils').extras
const braveHapi = braveExtras.hapi
const getPublisherProps = require('bat-publisher').getPublisherProps
const utf8ify = braveExtras.utils.utf8ify

BigNumber.config({ EXPONENTIAL_AT: 1e+9 })

let altcurrency

const datefmt = 'yyyymmdd-HHMMss'
const datefmt2 = 'yyyymmdd-HHMMss-l'
const feePercent = 0.05

const create = async (runtime, prefix, params) => {
  let extension, filename, options

  if (params.format === 'json') {
    options = { content_type: 'application/json' }
    extension = '.json'
  } else {
    options = { content_type: 'text/csv' }
    extension = '.csv'
  }
  filename = prefix + dateformat(underscore.now(), datefmt2) + extension
  options.metadata = { 'content-disposition': 'attachment; filename="' + filename + '"' }
  return runtime.database.file(params.reportId, 'w', options)
}

const publish = async (debug, runtime, method, owner, publisher, endpoint, payload) => {
  let path, result

  if (!runtime.config.publishers) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('no configuration for publishers server')
    }
    return {}
  }

  path = '/api'
  if (owner) path += '/owners/' + encodeURIComponent(owner)
  if ((owner) || (publisher)) path += '/channel'
  if (owner) path += 's'
  if (publisher) path += '/' + encodeURIComponent(publisher)
  result = await braveHapi.wreck[method](runtime.config.publishers.url + path + (endpoint || ''), {
    headers: {
      authorization: 'Bearer ' + runtime.config.publishers.access_token,
      'content-type': 'application/json'
    },
    payload: JSON.stringify(payload),
    useProxyP: true
  })
  if (Buffer.isBuffer(result)) result = JSON.parse(result)

  return result
}

const notification = async (debug, runtime, owner, publisher, payload) => {
  try {
    let message = await publish(debug, runtime, 'post', owner, publisher, '/notifications', payload)

    if (!message) return

    message = underscore.extend({ owner: owner, publisher: publisher }, payload)
    debug('notify', message)
    runtime.notify(debug, { channel: '#publishers-bot', text: 'publishers notified: ' + JSON.stringify(message) })
  } catch (ex) {
    runtime.captureException(ex)
    debug('notify-failed', { reason: ex.toString(), stack: ex.stack })
  }
}

const daily = async (debug, runtime) => {
  const publishers = runtime.database.get('publishers', debug)
  let entries, midnight, now, tomorrow

  debug('daily', 'running')

  now = underscore.now()
  midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  midnight = Math.floor(midnight.getTime() / 1000)

  try {
    await runtime.database.purgeSince(debug, runtime, midnight * 1000)

    entries = await publishers.find({})
    for (let entry of entries) {
      if ((!entry.owner) || (!entry.publisher)) continue

      await runtime.queue.send(debug, 'publisher-report',
                               underscore.pick(entry, [ 'owner', 'publisher', 'verified', 'visible' ]))
    }
  } catch (ex) {
    runtime.captureException(ex)
    debug('daily', { reason: ex.toString(), stack: ex.stack })
  }

  tomorrow = new Date(now)
  tomorrow.setHours(24, 0, 0, 0)
  setTimeout(() => { daily(debug, runtime) }, tomorrow - now)
  debug('daily', 'running again ' + moment(tomorrow).fromNow())
}

const hourly = async (debug, runtime) => {
  let next, now

  debug('hourly', 'running')

  try {
    await mixer(debug, runtime, undefined, undefined)
  } catch (ex) {
    runtime.captureException(ex)
    debug('hourly', { reason: ex.toString(), stack: ex.stack })
  }

  now = underscore.now()
  next = now + 60 * 60 * 1000
  setTimeout(() => { hourly(debug, runtime) }, next - now)
  debug('hourly', 'running again ' + moment(next).fromNow())
}

const sanity = async (debug, runtime) => {
  const owners = runtime.database.get('owners', debug)
  const publishers = runtime.database.get('publishers', debug)
  const scratchpad = runtime.database.get('scratchpad', debug)
  const tokens = runtime.database.get('tokens', debug)
  let collections, entries, info, next, now, page, results

  debug('sanity', 'running')

  try {
    if (!runtime.config.publishers) throw new Error('no configuration for publishers server')

    await scratchpad.remove({}, { justOne: false })

    page = 0
    while (true) {
      entries = await publish(debug, runtime, 'get', null, null, '/owners/?page=' + page + '&per_page=1024')
      page++
      if (entries.length === 0) break

      for (let entry of entries) {
        const ownerId = entry.owner_identifier
        let owner, params, props, state

        props = getPublisherProps(ownerId)
        if (!props) {
          debug('sanity', { message: 'invalid owner', owner: ownerId })
          continue
        }

        await scratchpad.update({ owner: ownerId }, { $set: { seen: true } }, { upsert: true })

        state = {
          $currentDate: { timestamp: { $type: 'timestamp' } },
          $set: {}
        }

        owner = await owners.findOne({ owner: ownerId })
        if (!owner) {
          owner = {}

          underscore.extend(state.$set, {
            visible: entry.show_verification_status || false,
            altcurrency: altcurrency
          }, underscore.pick(props, [ 'providerName', 'providerSuffix', 'providerValue' ]))
        }
        params = underscore.pick(owner, [ 'info', 'visible', 'provider' ])

        info = underscore.pick(entry, [ 'name', 'email' ])
        if (entry.phone_normalized) info.phone = entry.phone_normalized
        underscore.extend(state.$set, { info: info, visible: entry.show_verification_status || false })
        if (entry.uphold_verified) {
          state.$set.provider = 'uphold'
        } else {
          state.$unset = { provider: '' }
        }
        if (!underscore.isEqual(params, state.$set)) {
          debug('sanity', { message: 'update', owner: ownerId })
          params = state.$set
          await owners.update({ owner: ownerId }, state, { upsert: true })
        }

        if (!entry.channel_identifiers) entry.channel_identifiers = []
        results = await publishers.find({ owner: ownerId })
        for (let result of results) {
          if (entry.channel_identifiers.indexOf(result.publisher) !== -1) continue

          debug('sanity', { message: 'unlink', owner: ownerId, publisher: result.publisher })
          state = {
            $currentDate: { timestamp: { $type: 'timestamp' } },
            $set: { verified: false, visible: false },
            $unset: { authority: '', owner: '' }
          }
          await publishers.update({ publisher: result.publisher }, state, { upsert: true })
        }

        for (let channelId of entry.channel_identifiers) {
          let publisher

          props = getPublisherProps(channelId)
          if (!props) {
            debug('sanity', { message: 'invalid publisher', owner: ownerId, publisher: channelId })
            continue
          }

          await scratchpad.update({ publisher: channelId }, { $set: { seen: true } }, { upsert: true })

          publisher = await publishers.findOne({ publisher: channelId })
          if ((publisher) && (publisher.owner !== ownerId)) {
            debug('sanity', { message: 'reassign', previous: publisher.owner || 'none', owner: ownerId, publisher: channelId })

            state = {
              $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { authority: ownerId, verified: true, owner: ownerId }
            }
          } else if (publisher) {
            if ((publisher.authority === ownerId) && (publisher.verified === true)) continue

            debug('sanity', { message: 'update', publisher: channelId })
            state = {
              $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { authority: ownerId, verified: true }
            }
          } else {
            debug('sanity', { message: 'create', publisher: channelId })
            state = {
              $currentDate: { timestamp: { $type: 'timestamp' } },
              $set: { authority: ownerId, verified: true, visible: params.visible, owner: ownerId, altcurrency: altcurrency }
            }
            underscore.extend(state.$set, underscore.pick(props, [ 'providerName', 'providerSuffix', 'providerValue' ]))
          }
          if (info.name) state.$set.authorizerName = info.name
          if (info.email) state.$set.authorizerEmail = info.email
          if (info.email) state.$set.authorizerPhone = info.phone

          await publishers.update({ publisher: channelId }, state, { upsert: true })
        }
      }
    }

    entries = await tokens.find({})
    for (let entry of entries) {
      const id = underscore.pick(entry, [ 'verificationId', 'publisher' ])
      let owner, publisher

      if (!entry.token) {
        debug('sanity', { message: 'remove', token: id })
        await tokens.remove(id)
        continue
      }

      owner = entry.owner && await owners.findOne({ owner: entry.owner })
      if (!owner) {
        debug('sanity', { message: 'remove', token: id, owner: entry.owner })
        await tokens.remove(id)
        continue
      }

      if (!entry.publisher) {
        debug('sanity', { message: 'remove', token: id, publisher: entry.publisher })
        await tokens.remove(id)
        continue
      }

      publisher = await publishers.findOne({ publisher: entry.publisher })
      if (!publisher) {
        if (!entry.verified) continue

        debug('sanity', { message: 'remove', token: id, publisher: entry.publisher })
        await tokens.remove(id)
        continue
      }

      if (publisher.verified === entry.verified) continue

      if (entry.verified) {
        debug('sanity', { message: 'update', token: id, verified: publisher.verified })
        await tokens.update(id, { $set: { verified: false } })
      }

      debug('sanity', { message: 'remove', token: id, verified: publisher.verified })
      await tokens.remove(id)
    }

    entries = await publishers.find({ verified: true })
    for (let entry of entries) {
      let foundP, records, state

      records = await tokens.find({ publisher: entry.publisher })
      for (let record of records) {
        const id = underscore.pick(entry, [ 'verificationId', 'publisher' ])

        if ((record.owner !== entry.owner) || (!record.verified) || (foundP)) {
          debug('sanity', {
            message: 'remove',
            token: id,
            owner: entry.owner,
            publisher: entry.publisher,
            verified: record.verified,
            foundP: foundP
          })
          await tokens.remove(id)
          continue
        }

        foundP = true
      }
      if (foundP) continue

      state = {
        $currentDate: { timestamp: { $type: 'timestamp' } },
        $set: {
          token: uuid.v4().toLowerCase(),
          verified: true,
          authority: entry.owner,
          owner: entry.owner,
          visible: entry.visible,
          info: entry.info,
          method: 'sanity'
        }
      }
      await tokens.update({ publisher: entry.publisher, verificationId: state.$set.token }, state, { upsert: true })
    }

    collections = [ 'owners', 'publishers', 'tokens' ]
    for (let collection of collections) {
      let empties = []
      let misses = []

      entries = await runtime.database.get(collection, debug).find()
      for (let entry of entries) {
        let match

        if (!entry.owner) {
          empties.push(collection === 'owners' ? entry._id
                       : collection === 'publisher' ? entry.publisher
                       : underscore.pick(entry, [ 'verificationId', 'publisher' ]))
          continue
        }

        match = await scratchpad.findOne({ owner: entry.owner })
        if (!match) misses.push(entry.owner)
      }
      empties = underscore.uniq(empties)
      misses = underscore.uniq(misses)
      if ((empties.length) || (misses.length)) {
        debug('sanity',
              { message: 'collection issues', collection: collection, empties: empties.length, misses: misses.length })
      }
    }
  } catch (ex) {
    runtime.captureException(ex)
    debug('sanity', { reason: ex.toString(), stack: ex.stack })
  }

  try {
    await scratchpad.remove({}, { justOne: false })
  } catch (ex) {
    runtime.captureException(ex)
    debug('sanity', { reason: ex.toString(), stack: ex.stack })
  }

  now = underscore.now()
  next = now + 6 * 60 * 60 * 1000
  setTimeout(() => { sanity(debug, runtime) }, next - now)
  debug('sanity', 'running again ' + moment(next).fromNow())
}

const quanta = async (debug, runtime, qid) => {
  const contributions = runtime.database.get('contributions', debug)
  const voting = runtime.database.get('voting', debug)
  let query, results, votes

  const dicer = async (quantum, counts) => {
    const surveyors = runtime.database.get('surveyors', debug)
    let params, state, updateP, vote
    let surveyor = await surveyors.findOne({ surveyorId: quantum._id })

    if (!surveyor) return debug('missing surveyor.surveyorId', { surveyorId: quantum._id })

    quantum.created = new Date(parseInt(surveyor._id.toHexString().substring(0, 8), 16) * 1000).getTime()
    quantum.modified = (surveyor.timestamp.high_ * 1000) + (surveyor.timestamp.low_ / bson.Timestamp.TWO_PWR_32_DBL_)

    vote = underscore.find(votes, (entry) => { return (quantum._id === entry._id) })
    underscore.extend(quantum, { counts: vote ? vote.counts : 0 })

    params = underscore.pick(quantum, [ 'counts', 'inputs', 'fee', 'quantum' ])
    updateP = false
    underscore.keys(params).forEach((key) => {
      if (typeof surveyor[key] === 'undefined') {
        if ((key !== 'quantum') && (key !== 'inputs') && (key !== 'fee')) {
          runtime.captureException(new Error('missing key'), { extra: { surveyorId: surveyor.surveyorId, key: key } })
        }
        updateP = true
        return
      }

      if (!(params[key] instanceof bson.Decimal128)
          ? (params[key] !== surveyor[key])
          : !(new BigNumber(params[key].toString()).truncated().equals(new BigNumber(surveyor[key].toString()).truncated()))) {
        updateP = true
      }
    })
    if (!updateP) return

    params.inputs = bson.Decimal128.fromString(params.inputs.toString())
    params.fee = bson.Decimal128.fromString(params.fee.toString())
    state = { $currentDate: { timestamp: { $type: 'timestamp' } }, $set: params }
    await surveyors.update({ surveyorId: quantum._id }, state, { upsert: true })

    surveyor = await surveyors.findOne({ surveyorId: quantum._id })
    if (surveyor) {
      quantum.modified = (surveyor.timestamp.high_ * 1000) + (surveyor.timestamp.low_ / bson.Timestamp.TWO_PWR_32_DBL_)
    }
  }

  query = {
    probi: { $gt: 0 },
    votes: { $gt: 0 },
    altcurrency: { $eq: altcurrency }
  }
  if (qid) query._id = qid
  results = await contributions.aggregate([
    {
      $match: query
    },
    {
      $group: {
        _id: '$surveyorId',
        probi: { $sum: '$probi' },
        fee: { $sum: '$fee' },
        inputs: { $sum: { $subtract: [ '$probi', '$fee' ] } },
        votes: { $sum: '$votes' }
      }
    },
    {
      $project: {
        _id: 1,
        probi: 1,
        fee: 1,
        inputs: 1,
        votes: 1,
        quantum: { $divide: [ '$inputs', '$votes' ] }
      }
    }
  ])

  query = {
    counts: { $gt: 0 },
    exclude: false
  }
  if (qid) query._id = qid
  votes = await voting.aggregate([
    {
      $match: query
    },
    {
      $group: {
        _id: '$surveyorId',
        counts: { $sum: '$counts' }
      }
    },
    {
      $project: {
        _id: 1,
        counts: 1
      }
    }
  ])

  for (let result of results) await dicer(result)

  return (underscore.map(results, (result) => {
    return underscore.extend({ surveyorId: result._id }, underscore.omit(result, [ '_id' ]))
  }))
}

const mixer = async (debug, runtime, filter, qid) => {
  const publishers = {}
  let results

  const slicer = async (quantum) => {
    const voting = runtime.database.get('voting', debug)
    let fees, probi, query, slices, state

    // current is always defined
    const equals = (previous, current) => {
      return previous && previous.dividedBy(1e11).round().equals(current.dividedBy(1e11).round())
    }

    query = { surveyorId: quantum.surveyorId, exclude: false }
    if (qid) query._id = qid
    slices = await voting.find(query)
    for (let slice of slices) {
      fees = new BigNumber(quantum.quantum.toString()).times(slice.counts).times(feePercent)
      probi = new BigNumber(quantum.quantum.toString()).times(slice.counts).minus(fees)
      if ((filter) && (filter.indexOf(slice.publisher) === -1)) continue

      if (!publishers[slice.publisher]) {
        publishers[slice.publisher] = {
          altcurrency: altcurrency,
          probi: new BigNumber(0),
          fees: new BigNumber(0),
          votes: []
        }
      }
      publishers[slice.publisher].probi = publishers[slice.publisher].probi.plus(probi)
      publishers[slice.publisher].fees = publishers[slice.publisher].fees.plus(fees)
      publishers[slice.publisher].votes.push({
        surveyorId: quantum.surveyorId,
        timestamp: (slice.timestamp.high_ * 1000) + (slice.timestamp.low_ / bson.Timestamp.TWO_PWR_32_DBL_),
        counts: slice.counts,
        altcurrency: altcurrency,
        probi: probi,
        fees: fees,
        cohort: slice.cohort || 'control'
      })
      if (equals(slice.probi && new BigNumber(slice.probi.toString()), probi)) continue

      state = {
        $set: {
          altcurrency: altcurrency,
          probi: bson.Decimal128.fromString(probi.toString()),
          fees: bson.Decimal128.fromString(fees.toString())
        }
      }
      await voting.update({ surveyorId: quantum.surveyorId, publisher: slice.publisher, cohort: slice.cohort || 'control' }, state, { upsert: true })
    }
  }

  results = await quanta(debug, runtime, qid)
  for (let result of results) await slicer(result)
  return publishers
}

const publisherCompare = (a, b) => {
  const aProps = getPublisherProps(a.publisher)
  const bProps = getPublisherProps(b.publisher)

// cf., https://en.wikipedia.org/wiki/Robustness_principle
  if (!aProps) { return (bProps ? (-1) : 0) } else if (!bProps) { return 1 }

  if (aProps.publisherType) {
    return ((!bProps.publisherType) ? 1
            : (aProps.providerName !== b.providerName) ? (aProps.providerName - b.providerName)
            : (aProps.providerSuffix !== b.providerSuffix) ? (aProps.providerSuffix - b.providerSuffix)
            : (aProps.providerValue - bProps.providerValue))
  }

  if (bProps.publisherType) return (-1)

  return braveHapi.domainCompare(a.publisher, b.publisher)
}

const labelize = async (debug, runtime, data) => {
  const labels = {}
  const owners = runtime.database.get('owners', debug)
  const publishersC = runtime.database.get('publishers', debug)

  for (let datum of data) {
    const publisher = datum.publisher
    let entry, owner, props

    if (!publisher) continue

    if (labels[publisher]) {
      datum.publisher = labels[publisher]
      continue
    }

    props = getPublisherProps(publisher)
    labels[publisher] = publisher

    if (props && props.publisherType) entry = await publishersC.findOne({ publisher: publisher })
    if (entry) {
      labels[publisher] = props.URL
      if ((!entry.info) && (entry.owner)) {
        owner = await owners.findOne({ owner: entry.owner })
        if (owner) entry = owner
      }

      if (entry.info && entry.info.name) labels[publisher] = entry.info.name + ' <' + labels[publisher] + '>'
    }
    datum.publisher = labels[publisher]
  }

  return data
}

const publisherContributions = (runtime, publishers, authority, authorized, verified, format, reportId, summaryP, threshold,
                              usd) => {
  const scale = new BigNumber(runtime.currency.alt2scale(altcurrency) || 1)
  let data, fees, results, probi

  results = []
  underscore.keys(publishers).forEach((publisher) => {
    if ((threshold) && (publishers[publisher].probi.lessThanOrEqualTo(threshold))) return

    if ((typeof verified === 'boolean') && (publishers[publisher].verified !== verified)) return

    if ((typeof authorized === 'boolean') && (publishers[publisher].authorized !== authorized)) return

    publishers[publisher].votes = underscore.sortBy(publishers[publisher].votes, 'surveyorId')
    results.push(underscore.extend({ publisher: publisher }, publishers[publisher]))
  })

  results = results.sort(publisherCompare)
  results.forEach((result) => {
    result.probi = result.probi.truncated().toString()
    result.fees = result.fees.truncated().toString()

    result.votes.forEach((vote) => {
      vote['publisher USD'] = usd && new BigNumber(vote.probi).times(usd).dividedBy(scale).toFixed(2)
      vote['processor USD'] = usd && new BigNumber(vote.fees).times(usd).dividedBy(scale).toFixed(2)
      vote.probi = new BigNumber(vote.probi).truncated().toString()
      vote.fees = new BigNumber(vote.fees).truncated().toString()
    })
  })

  if (format === 'json') {
    if (summaryP) {
      publishers = []
      results.forEach((entry) => {
        let result

        if (!entry.authorized) return

        result = underscore.pick(entry, [ 'publisher', 'altcurrency', 'probi', 'fees' ])
        result.authority = authority
        result.transactionId = reportId
        result.currency = 'USD'
        result.amount = usd && new BigNumber(entry.probi).times(usd).dividedBy(scale).toFixed(2)
        result.fee = usd && new BigNumber(entry.fees).times(usd).dividedBy(scale).toFixed(2)
        publishers.push(result)
      })

      results = publishers
    }

    return { data: results }
  }

  probi = new BigNumber(0)
  fees = new BigNumber(0)

  data = []
  results.forEach((result) => {
    let datum, lastxn

    probi = probi.plus(result.probi)
    fees = fees.plus(result.fees)
    if (summaryP) lastxn = underscore.last(result.votes)
    datum = {
      publisher: result.publisher,
      altcurrency: result.altcurrency,
      probi: result.probi,
      fees: result.fees,
      'publisher USD': usd && new BigNumber(result.probi).times(usd).dividedBy(scale).toFixed(2),
      'processor USD': usd && new BigNumber(result.fees).times(usd).dividedBy(scale).toFixed(2),
      timestamp: lastxn && lastxn.timestamp && dateformat(lastxn.timestamp, datefmt)
    }
    if (authority) {
      underscore.extend(datum, { verified: result.verified, authorized: result.authorized })
    }
    data.push(datum)
    if (!summaryP) {
      underscore.sortBy(result.votes, 'timestamp').forEach((vote) => {
        data.push(underscore.extend({ publisher: result.publisher },
                                    underscore.omit(vote, [ 'surveyorId', 'updated', 'cohort' ]),
                                    { transactionId: vote.surveyorId, timestamp: dateformat(vote.timestamp, datefmt) }))
      })
    }
  })

  return { data: data, altcurrency: altcurrency, probi: probi, fees: fees }
}

const publisherSettlements = (runtime, entries, format, summaryP, spacingP) => {
  const publishers = {}
  let amount, commission, currency, data, fees, lastxn, results, probi

  entries.forEach((entry) => {
    if (entry.publisher === '') return

    if (!publishers[entry.publisher]) {
      publishers[entry.publisher] = {
        altcurrency: altcurrency,
        probi: new BigNumber(0),
        amount: new BigNumber(0),
        fees: new BigNumber(0),
        commission: new BigNumber(0)
      }
      publishers[entry.publisher].txns = []
    }

    underscore.extend(entry, {
      probi: entry.probi.toString(),
      amount: entry.amount.toString(),
      fees: entry.fees.toString(),
      commission: entry.commission.toString()
    })

    publishers[entry.publisher].probi = publishers[entry.publisher].probi.plus(new BigNumber(entry.probi))
    publishers[entry.publisher].amount = publishers[entry.publisher].amount.plus(new BigNumber(entry.amount))
    if (!entry.fees) entry.fees = 0
    publishers[entry.publisher].fees = publishers[entry.publisher].fees.plus(new BigNumber(entry.fees))
    if (!entry.commission) entry.commission = 0
    publishers[entry.publisher].commission = publishers[entry.publisher].commission.plus(new BigNumber(entry.commission))
    if (typeof publishers[entry.publisher].currency === 'undefined') publishers[entry.publisher].currency = entry.currency
    else if (publishers[entry.publisher].currency !== entry.currency) publishers[entry.publisher].currency = ''
    entry.created = new Date(parseInt(entry._id.toHexString().substring(0, 8), 16) * 1000).getTime()
    entry.modified = (entry.timestamp.high_ * 1000) + (entry.timestamp.low_ / bson.Timestamp.TWO_PWR_32_DBL_)
    publishers[entry.publisher].txns.push(underscore.pick(entry, [
      'altcurrency', 'probi', 'currency', 'amount', 'fees', 'commission', 'settlementId', 'address', 'hash', 'created',
      'modified', 'type'
    ]))
  })

  results = []
  underscore.keys(publishers).forEach((publisher) => {
    const entry = publishers[publisher]
    const txns = {}
    let amountP = true

    entry.txns = underscore.sortBy(entry.txns, 'created')
    if (summaryP) {
      entry.txns.forEach((txn) => {
        const row = txns[txn.currency]

        if (!row) {
          txns[txn.currency] = txn
          return
        }

        row.probi = new BigNumber(row.probi).plus(new BigNumber(txn.probi))
        row.amount = new BigNumber(row.amount).plus(new BigNumber(txn.amount))
        row.fees = new BigNumber(row.fees).plus(new BigNumber(txn.fees))
        row.commission = new BigNumber(row.commission).plus(new BigNumber(txn.commission))

        delete row.settlementId
        if (row.address !== txn.address) delete row.address
        delete row.hash
        row.created = txn.created
        row.modified = txn.modified
      })

      if (underscore.size(txns) > 1) entry.txns = underscore.values(txns)
      else {
        lastxn = underscore.last(entry.txns)
        entry.txns = []
      }
    } else {
      currency = ''
      for (let txn of entry.txns) {
        if (typeof currency === 'undefined') currency = txn.currency
        else if (currency !== txn.currency) currency = ''
      }
      if (currency === '') amountP = false
      currency = undefined
    }

    results.push(underscore.extend({ publisher: publisher }, entry, {
      probi: entry.probi.toString(),
      amount: amountP ? entry.amount.toString() : '',
      fees: entry.fees.toString(),
      commission: entry.commission.toString()
    }))
  })
  results = results.sort(publisherCompare)

  if (format === 'json') return { data: results }

  probi = new BigNumber(0)
  amount = new BigNumber(0)
  fees = new BigNumber(0)
  commission = new BigNumber(0)

  data = []
  results.forEach((result) => {
    let total

    probi = probi.plus(result.probi)
    amount = amount.plus(result.amount || 0)
    fees = fees.plus(result.fees)
    commission = commission.plus(result.commission)
    if (typeof currency === 'undefined') currency = result.currency
    else if (currency !== result.currency) currency = ''
    total = {
      publisher: result.publisher,
      altcurrency: result.altcurrency,
      probi: result.probi.toString(),
      currency: result.currency,
      amount: result.amount || 0,
      fees: result.fees.toString(),
      commission: result.commission.toString(),
      timestamp: lastxn && lastxn.created && dateformat(lastxn.created, datefmt)
    }
    data.push(total)
    result.txns.forEach((txn) => {
      data.push(underscore.extend({ publisher: result.publisher },
                                  underscore.omit(txn, [ 'hash', 'settlementId', 'created', 'modified' ]),
                                  { transactionId: txn.hash, timestamp: txn.created && dateformat(txn.created, datefmt) }))
      if (total.currency === txn.currency) total.amount = new BigNumber(total.amount).plus(txn.amount || 0).toString()
    })
    total.amount = total.amount.toString()
    if (total.amount === '0') total.amount = ''
    if (spacingP) data.push([])
  })

  return {
    data: data,
    altcurrency: altcurrency,
    probi: probi.toString(),
    amount: currency ? amount.toString() : '',
    currency: currency,
    fees: fees.toString(),
    commission: commission.toString()
  }
}

const date2objectId = (iso8601, ceilP) => {
  let x

  if (ceilP) {
    iso8601 = iso8601.toString()
    x = iso8601.indexOf('T00:00:00.000')
    if (x !== -1) iso8601 = iso8601.slice(0, x) + 'T23:55:59' + iso8601.slice(x + 13)
  }

  return bson.ObjectId(Math[ceilP ? 'ceil' : 'floor'](new Date(iso8601).getTime() / 1000.0).toString(16) +
                       (ceilP ? 'ffffffffffffffff' : '0000000000000000'))
}

/**
 * A referral statement consists of entries describing earnings from referrals,
 * past successful settlements (payouts), and a balance entry showing a publishers current
 * settlement balance from referrals.
 **/
const referralStatement = async (debug, runtime, owner, summaryP) => {
  const referrals = runtime.database.get('referrals', debug)
  const settlements = runtime.database.get('settlements', debug)

  if (!summaryP) {
    throw new Error('non summary not currently supported')
  }

  const statements = []
  const statementTemplate = {
    referrals: { summary: {}, entries: {} },
    settlements: { summaries: [], entries: {} },
    balance: {}
  }

  const referralFilter = { probi: { $gt: 0 }, altcurrency: { $eq: altcurrency }, exclude: false }
  const settlementFilter = { probi: { $gt: 0 }, altcurrency: { $eq: altcurrency }, type: { $eq: 'referral' } }
  if (owner) {
    referralFilter.owner = { $eq: owner }
    settlementFilter.owner = { $eq: owner }
  }

  const referralTotals = await referrals.aggregate([
    { $match: referralFilter },
    {
      $group: {
        _id: '$publisher',
        count: { $sum: 1 },
        probi: { $sum: '$probi' }
      }
    }
  ])
  referralTotals.forEach((total) => {
    total.publisher = total._id
    total.probi = new BigNumber(total.probi.toString())

    if (!statements[total.publisher]) statements[total.publisher] = JSON.parse(JSON.stringify(statementTemplate))
    statements[total.publisher].referrals.summary = total
  })

  const referralSettlementSummaries = await settlements.aggregate([
    { $match: settlementFilter },
    {
      $group: {
        // FIXME handle domain transfer case, multiple entries with different owner for same publisher
        _id: { publisher: '$publisher', currency: '$currency' },
        amount: { $sum: '$amount' },
        probi: { $sum: '$probi' },
        fees: { $sum: '$fees' },
        commission: { $sum: '$commission' }
      }
    }
  ])
  referralSettlementSummaries.forEach((summary) => {
    summary.publisher = summary._id.publisher
    summary.currency = summary._id.currency
    summary.probi = new BigNumber(summary.probi.toString())

    if (!statements[summary.publisher]) statements[summary.publisher] = JSON.parse(JSON.stringify(statementTemplate))
    statements[summary.publisher].settlements.summaries.push(summary)
  })

  underscore.keys(statements).forEach((publisher) => {
    let balance = new BigNumber(0)
    if (statements[publisher].referrals.summary.probi) {
      balance = balance.plus(statements[publisher].referrals.summary.probi)
    }
    statements[publisher].settlements.summaries.forEach((summary) => {
      balance = balance.minus(summary.probi)
    })
    if (balance.lessThan(0)) {
      throw new Error(`Publisher ${publisher} has been overpaid`)
    }
    statements[publisher].balance = {
      publisher: publisher,
      altcurrency: altcurrency,
      probi: balance
    }
  })

  return statements
}

const findEligPublishers = async (debug, runtime, publishers) => {
  const publishersC = runtime.database.get('publishers', debug)

  const query = { verified: true }

  if (Array.isArray(publishers)) {
    if (publishers.length === 0) {
      return []
    }
    query.$or = publishers.map((pub) => { return { publisher: pub } })
  } else if (typeof publishers !== 'undefined') {
    throw new Error('Only an array of publisher names or undefined are allowed for argument publishers')
  }

  return publishersC.aggregate([
    { $match: query },
    {
      $lookup:
      {
        from: 'owners',
        localField: 'owner',
        foreignField: 'owner',
        as: 'ownerdata'
      }
    },
    { $match: { 'ownerdata.authorized': true } }
  ])
}

/**
 * Prepare a json datastructure consisting of transactions to pay out the
 * current balance owed to eligible publisher from referrals in the format expected
 * by our payment tooling
 **/
const prepareReferralPayout = async (debug, runtime, authority, reportId, thresholdProbi, includeUnpayable) => {
  const statements = await referralStatement(debug, runtime, undefined, true)
  const threshPubs = underscore.filter(underscore.keys(statements), (publisher) => {
    return statements[publisher].balance.probi.greaterThan(thresholdProbi)
  })
  const eligPublishers = await findEligPublishers(debug, runtime, threshPubs)

  const payments = []
  for (let i = 0; i < eligPublishers.length; i++) {
    const publisher = eligPublishers[i].publisher
    const payment = statements[publisher].balance
    payment.type = 'referral'
    payment.fees = new BigNumber(0)
    payment.authority = authority
    payment.transactionId = reportId

    payment.owner = eligPublishers[i].owner

    const entries = eligPublishers[i].ownerdata
    if (entries.length > 1) {
      throw new Error(`Too many owners: ${entries.length} for a single channel: ${publisher}`)
    }
    const entry = entries[0]
    let wallet = null
    if ((!entry) || (!entry.provider) || (!entry.parameters)) {
      await notification(debug, runtime, payment.owner, payment.publisher, { type: 'verified_no_wallet' })
    } else {
      try {
        wallet = await runtime.wallet.status(entry)
        if (validateWallet(wallet)) {
          payment.address = wallet.address
          payment.currency = wallet.defaultCurrency
        } else {
          await notification(debug, runtime, payment.owner, payment.publisher, { type: 'verified_no_wallet' })
        }
      } catch (ex) {
        debug('wallet not available', {
          message: ex.message,
          stack: ex.stack
        })
        await notification(debug, runtime, payment.owner, payment.publisher, { type: 'verified_invalid_wallet' })
      }
    }
    if (includeUnpayable || validateWallet(wallet)) {
      payments.push(payment)
    }
  }

  return payments
}

function validateWallet (wallet) {
  return wallet && wallet.address && wallet.defaultCurrency
}

var exports = {}

exports.initialize = async (debug, runtime) => {
  altcurrency = runtime.config.altcurrency || 'BAT'

  runtime.database.checkIndices(debug, [
    {
      category: runtime.database.get('scratchpad', debug),
      name: 'scratchpad',
      property: 'owner',
      empty: {
        owner: ''
      },
      others: [ { owner: 1 } ]
    }
  ])

  if ((typeof process.env.DYNO === 'undefined') || (process.env.DYNO === 'worker.1')) {
    setTimeout(() => { daily(debug, runtime) }, 5 * 1000)
    setTimeout(() => { hourly(debug, runtime) }, 30 * 1000)
    setTimeout(() => { sanity(debug, runtime) }, 5 * 60 * 1000)
  }
}

exports.create = create
exports.publish = publish

exports.workers = {
/* sent by GET /v1/reports/publisher/{publisher}/referrals
           GET /v1/reports/publishers/referrals

    { queue            : 'report-publishers-referrals'
    , message          :
      { reportId       : '...'
      , reportURL      : '...'
      , authority      : '...:...'
      , format         : 'json' | 'csv'
      , balance        :  true  | false
      , summary        :  true  | false
      , threshold      : probi
      }
    }
 */
  'report-publishers-referrals':
    async (debug, runtime, payload) => {
      const authority = payload.authority
      const authorized = payload.authorized
      const balance = payload.balance
      const format = payload.format
      const reportId = payload.reportId
      const summary = payload.summary
      const thresholdProbi = payload.threshold || 0
      const verified = payload.verified
      const includeUnpayable = !!payload.includeUnpayable

      if ((!balance) || (!summary) || (!authorized) || (!verified)) {
        throw new Error('only summary && balance && authorized && verified is supported')
      }

      if (format !== 'json') {
        throw new Error('formats other than json are not supported')
      }

      const payments = await prepareReferralPayout(debug, runtime, authority, reportId, thresholdProbi, includeUnpayable)
      debug('payload', payload)
      const file = await create(runtime, 'publishers-', payload)

      await file.write(utf8ify(payments), true)

      return runtime.notify(debug, {
        channel: '#publishers-bot',
        text: authority + ' report-publishers-referrals completed'
      })
    },

/* sent by GET /v1/reports/publisher/{publisher}/contributions
           GET /v1/reports/publishers/contributions

    { queue             : 'report-publishers-contributions'
    , message           :
      { reportId        : '...'
      , reportURL       : '...'
      , authorized      :  true  | false | undefined
      , authority       : '...:...'
      , format          : 'json' | 'csv'
      , publisher       : '...'
      , balance         :  true  | false
      , summary         :  true  | false
      , threshold       : probi
      , verified        :  true  | false | undefined
      , amount          : '...'    // ignored (converted to threshold probi)
      , currency        : '...'    //   ..
      , includeNegative :  true  | false
      , includeUnpayable:  true  | false
      }
    }
 */
  'report-publishers-contributions':
    async (debug, runtime, payload) => {
      const authority = payload.authority
      const authorized = payload.authorized
      const format = payload.format || 'csv'
      const balanceP = payload.balance
      const publisher = payload.publisher
      const reportId = payload.reportId
      const summaryP = payload.summary
      const threshold = payload.threshold || 0
      const verified = payload.verified
      const includeUnpayable = !!payload.includeUnpayable
      const includeNegative = payload.includeNegative
      const owners = runtime.database.get('owners', debug)
      const publishersC = runtime.database.get('publishers', debug)
      const settlements = runtime.database.get('settlements', debug)
      const scale = new BigNumber(runtime.currency.alt2scale(altcurrency) || 1)
      let data, entries, file, info, previous, publishers, usd

      publishers = await mixer(debug, runtime, publisher && [ publisher ], undefined)

      underscore.keys(publishers).forEach((publisher) => {
        publishers[publisher].authorized = false
        publishers[publisher].verified = false
      })

      entries = await findEligPublishers(debug, runtime, undefined)
      entries.forEach((entry) => {
        if (typeof publishers[entry.publisher] === 'undefined') return
        publishers[entry.publisher].authorized = true
        publishers[entry.publisher].verified = true
      })

      if (balanceP) {
        previous = await settlements.aggregate([
          {
            $match: {
              probi: { $gt: 0 },
              altcurrency: { $eq: altcurrency },
              type: 'contribution'
            }
          },
          {
            $group: {
              _id: '$publisher',
              probi: { $sum: '$probi' },
              fees: { $sum: '$fees' }
            }
          }
        ])
        previous.forEach((entry) => {
          const p = publishers[entry._id]

          if (typeof p === 'undefined') return

          p.probi = p.probi.minus(new BigNumber(entry.probi.toString()))
          if (p.probi.isNegative() && !includeNegative) {
            delete publishers[entry._id]
            return
          }

          p.fees = p.fees.minus(new BigNumber(entry.fees.toString()))
          if (p.fees.isNegative() && !includeNegative) p.fees = new BigNumber(0)
        })
      }

      usd = runtime.currency.alt2fiat(altcurrency, 1, 'USD', true) || new BigNumber(0)
      info = publisherContributions(runtime, publishers, authority, authorized, verified, format, reportId, summaryP,
                                    threshold, usd)
      data = info.data

      file = await create(runtime, 'publishers-', payload)
      if (format === 'json') {
        entries = []
        for (let datum of data) {
          let entry, props, provider

          delete datum.currency
          delete datum.amount
          delete datum.fee

          let wallet = null
          try {
            entry = await publishersC.findOne({ publisher: datum.publisher })
            if (!entry) continue

            if (!entry.owner) {
              debug('report-publishers-contributions', { reason: 'publisher is missing an owner' })
              continue
            }

            datum.owner = entry.owner
            datum.type = 'contribution'

            props = getPublisherProps(datum.publisher)
            datum.name = entry.info && entry.info.name
            datum.URL = props && props.URL

            entry = await owners.findOne({ owner: entry.owner })
            provider = entry && entry.provider
            if (provider && entry.parameters) {
              wallet = await runtime.wallet.status(entry)
            }

            if (validateWallet(wallet)) {
              datum.address = wallet.address
              datum.currency = wallet.defaultCurrency
            } else {
              await notification(debug, runtime, entry.owner, datum.publisher, { type: 'verified_no_wallet' })
            }
          } catch (ex) {
            debug('wallet not available', {
              message: ex.message,
              stack: ex.stack
            })
            await notification(debug, runtime, entry.owner, datum.publisher, { type: 'verified_invalid_wallet' })
          }
          if (includeUnpayable || validateWallet(wallet)) {
            entries.push(datum)
          }
        }
        data = entries

        await file.write(utf8ify(entries), true)
        return runtime.notify(debug, {
          channel: '#publishers-bot',
          text: authority + ' report-publishers-contributions completed'
        })
      }

      if (!publisher) {
        data.push({
          publisher: 'TOTAL',
          altcurrency: info.altcurrency,
          probi: info.probi.truncated().toString(),
          fees: info.fees.truncated().toString(),
          'publisher USD': usd && info.probi.times(usd).dividedBy(scale).toFixed(2),
          'processor USD': usd && info.fees.times(usd).dividedBy(scale).toFixed(2)
        })
      } else if (data.length === 0) {
        data.push({
          publisher: publisher,
          altcurrency: altcurrency,
          probi: 0,
          fees: 0,
          'publisher USD': 0,
          'processor USD': 0
        })
      }

      try { await file.write(utf8ify(json2csv({ data: await labelize(debug, runtime, data) })), true) } catch (ex) {
        debug('reports', { report: 'report-publishers-contributions', reason: ex.toString() })
        file.close()
      }
      runtime.notify(debug, { channel: '#publishers-bot', text: authority + ' report-publishers-contributions completed' })
    },

/* sent by GET /v1/reports/publisher/{publisher}/settlements
           GET /v1/reports/publishers/settlements

    { queue            : 'report-publishers-settlements'
    , message          :
      { reportId       : '...'
      , reportURL      : '...'
      , authority      : '...:...'
      , format         : 'json' | 'csv'
      , publisher      : '...'
      , summary        :  true  | false
      }
    }
 */
  'report-publishers-settlements':
    async (debug, runtime, payload) => {
      const authority = payload.authority
      const format = payload.format || 'csv'
      const publisher = payload.publisher
      const summaryP = payload.summary
      const settlements = runtime.database.get('settlements', debug)
      let data, entries, file, info

      entries = publisher ? (await settlements.find({ publisher: publisher })) : (await settlements.find())

      info = publisherSettlements(runtime, entries, format, summaryP, !publisher)
      data = info.data

      file = await create(runtime, 'publishers-settlements-', payload)
      if (format === 'json') {
        await file.write(utf8ify(data), true)
        return runtime.notify(debug, {
          channel: '#publishers-bot',
          text: authority + ' report-publishers-settlements completed' })
      }

      if (!publisher) {
        data.push({
          publisher: 'TOTAL',
          altcurrency: info.altcurrency,
          probi: info.probi,
          currency: info.currency,
          amount: info.amount,
          fees: info.fees
        })
      } else if (data.length === 0) {
        data.push({
          publisher: publisher,
          altcurrency: altcurrency,
          probi: 0,
          currency: '',
          amount: 0,
          fees: 0
        })
      }

      try { await file.write(utf8ify(json2csv({ data: await labelize(debug, runtime, data) })), true) } catch (ex) {
        debug('reports', { report: 'report-publishers-settlements', reason: ex.toString() })
        file.close()
      }
      runtime.notify(debug, { channel: '#publishers-bot', text: authority + ' report-publishers-settlements completed' })
    },

/* sent by GET /v1/publishers/{publisher}/statement
           GET /v1/reports/publishers/statements
           GET /v1/reports/publisher/{publisher}/statements
           GET /v1/reports/publishers/statements/{hash}
           GET /v2/reports/publishers/statements
           GET /v1/owners/{owner}/statement

    { queue            : 'report-publishers-statements'
    , message          :
      { reportId       : '...'
      , reportURL      : '...'
      , authority      : '...:...'
      , hash           : '...'
      , settlementId   : '...'
      , owner          : '...'
      , publisher      : '...'
      , rollup         :  true  | false
      , summary        :  true  | false
      , starting       : 'ISO 8601 timestamp'
      , ending         : 'ISO 8601 timestamp'
      }
    }
 */
  'report-publishers-statements':
    async (debug, runtime, payload) => {
      const authority = payload.authority
      const starting = payload.starting
      const owner = payload.owner
      const publisher = payload.publisher
      const publisherP = !!publisher
      const publishersC = runtime.database.get('publishers', debug)
      const referrals = runtime.database.get('referrals', debug)
      const settlements = runtime.database.get('settlements', debug)
      const summaryP = payload.summary
      const scale = new BigNumber(runtime.currency.alt2scale(altcurrency) || 1)
      let contributions, data, data1, data2, file, entries, publishers, query, range, referralTotals, usd
      let ending = payload.ending
      let rollupP = payload.rollup

      if ((starting) || (ending)) {
        range = {}
        if (starting) range.$gte = date2objectId(starting, false)
        if (ending) range.$lte = date2objectId(ending, true)
      }
      if (publisher) {
        query = { publisher: publisher }
        entries = await settlements.find(query)
        contributions = await mixer(debug, runtime, [ publisher ], range)
      } else {
        query = underscore.pick(payload, [ 'owner', 'hash', 'settlementId' ])
        if (underscore.size(query) === 0) rollupP = false
        if (range) query._id = range
        entries = await settlements.find(query)
        if ((rollupP) && (entries.length > 0)) {
          query = { $or: [] }
          entries.forEach((entry) => { query.$or.push({ publisher: entry.publisher }) })
          entries = await settlements.find(query)
        }
        if (owner) {
          publishers = await publishersC.find({ owner: owner })
          contributions = await mixer(debug, runtime, publishers.map((p) => p.publisher), range)
        } else {
          contributions = await mixer(debug, runtime, undefined, range)
        }
      }

      if (owner) {
        referralTotals = await referrals.aggregate([
          { $match: { owner: owner } },
          {
            $group: {
              _id: '$publisher',
              count: { $sum: 1 },
              probi: { $sum: '$probi' }
            }
          }
        ])
        referralTotals = referralTotals.reduce((obj, item) => {
          item.publisher = item._id
          item.probi = new BigNumber(item.probi.toString())
          item.fees = item.probi.times(feePercent).truncated()
          item.probi = item.probi.minus(item.fees)
          item.altcurrency = altcurrency
          item.note = 'Finalized referrals'

          obj[item._id] = item
          return obj
        }, {})
      } else referralTotals = {}

      publishers = underscore.keys(contributions)
      if (owner) {
        publishers.push(...underscore.keys(referralTotals))
        publishers = underscore.uniq(publishers)
      }

      usd = runtime.currency.alt2fiat(altcurrency, 1, 'USD', true) || new BigNumber(0)
      data = []
      data1 = { altcurrency: altcurrency, probi: new BigNumber(0), fees: new BigNumber(0) }
      data2 = { altcurrency: altcurrency, probi: new BigNumber(0), fees: new BigNumber(0) }

      publishers.sort(braveHapi.domainCompare).forEach((publisher) => {
        if ((!publisherP) && (!owner) && (!underscore.findWhere(entries, { publisher: publisher }))) return

        const entry = {}
        let info

        if (contributions[publisher]) {
          entry[publisher] = contributions[publisher]
          info = publisherContributions(runtime, entry, undefined, undefined, undefined, 'csv', undefined, summaryP, undefined,
                                        usd)
          info.data.forEach((datum) => {
            datum.probi = datum.probi.toString()
            datum.fees = datum.fees.toString()
            datum.note = 'User contributions'
          })
          data = data.concat(info.data)
          data1.probi = data1.probi.plus(info.probi)
          data1.fees = data1.fees.plus(info.fees)
        }
        if (!summaryP) data.push([])

        if (referralTotals[publisher]) {
          info = referralTotals[publisher]
          data.push(info)
          data1.probi = data1.probi.plus(info.probi)
          data1.fees = data1.fees.plus(info.fees)
        }
        if (!summaryP) data.push([])

        info = publisherSettlements(runtime, underscore.where(entries, { publisher: publisher }), 'csv', summaryP)
        if ((summaryP) && (info.data.length > 1)) data.push([])
        info.data.forEach((datum) => {
          if (typeof datum.probi === 'undefined') return

          datum.probi = datum.probi.toString()
          datum.fees = datum.fees.toString()
          datum.amount = datum.amount.toString()
          if (datum.type) {
            datum.note = datum.type[0].toUpperCase() + datum.type.substr(1) + ' payout'
          }
        })
        data = data.concat(info.data)
        data2.probi = data2.probi.plus(info.probi)
        data2.fees = data2.fees.plus(info.fees)
        if (info.currency) {
          data2.amount = info.amount
          data2.currency = info.currency
        }
        data.push([])
        if ((!summaryP) && (!owner)) data.push([])
      })
      if ((!publisher) && ((!owner) || (underscore.size(publishers) > 1))) {
        data.push({
          note: 'ACTIVITY',
          altcurrency: data1.altcurrency,
          probi: data1.probi.toString(),
          fees: data1.fees.toString(),
          'publisher USD': usd && data1.probi.times(usd).dividedBy(scale).toFixed(2),
          'processor USD': usd && data1.fees.times(usd).dividedBy(scale).toFixed(2)
        })
        if ((!summaryP) && (!owner)) data.push([])
        data.push({
          note: 'TOTAL PAID OUT',
          altcurrency: data2.altcurrency,
          probi: data2.probi.toString(),
          fees: data2.fees.toString()
        })
      }

      data.forEach((datum) => {
        const probi2alt = (probi) => { return new BigNumber(probi).dividedBy(runtime.currency.alt2scale(altcurrency)) }

        if (typeof datum.probi !== 'undefined') datum.probi = probi2alt(datum.probi)
        if (typeof datum.fees !== 'undefined') datum.fees = probi2alt(datum.fees)
      })

      file = await create(runtime, 'publishers-statements-', payload)
      try {
        let fields = []
        let fieldNames = []

        fields.push('note', 'timestamp', 'publisher')
        fieldNames.push('note', 'timestamp', 'publisher')
        if (!owner) {
          fields.push('publisher USD', 'processor USD')
          fieldNames.push('estimated USD', 'estimated fees')
        }
        fields.push('currency', 'amount')
        fieldNames.push('currency', 'amount')
        if ((!summaryP) && (!owner)) {
          fields.push('transactionId', 'altcurrency')
          fieldNames.push('transactionId', 'altcurrency')
        }
        fields.push('probi', 'fees')
        fieldNames.push(altcurrency, altcurrency + ' fees')
        if ((!summaryP) && (!owner)) {
          fields.push('counts')
          fieldNames.push('counts')
        }

        await file.write(utf8ify(json2csv({
          data: await labelize(debug, runtime, data),
          fields: fields,
          fieldNames: fieldNames
        })), true)
      } catch (ex) {
        debug('reports', { report: 'report-publishers-statements', reason: ex.toString() })
        file.close()
      }
      runtime.notify(debug, { channel: '#publishers-bot', text: authority + ' report-publishers-statements completed' })
    },

/* sent by GET /v1/reports/publishers/status
               /v2/reports/publishers/status

    { queue            : 'report-publishers-status'
    , message          :
      { reportId       : '...'
      , reportURL      : '...'
      , authority      : '...:...'
      , format         : 'json' | 'csv'
      , elide          :  true  | false
      , summary        :  true  | false
      , verified       :  true  | false | undefined
      }
    }
 */
  'report-publishers-status':
    async (debug, runtime, payload) => {
      const authority = payload.authority
      const format = payload.format || 'csv'
      const elideP = payload.elide
      const summaryP = payload.summary
      const verified = payload.verified
      const owners = runtime.database.get('owners', debug)
      const publishers = runtime.database.get('publishers', debug)
      const referrals = runtime.database.get('referrals', debug)
      const settlements = runtime.database.get('settlements', debug)
      const tokens = runtime.database.get('tokens', debug)
      const voting = runtime.database.get('voting', debug)
      const probi = {}
      let data, entries, f, fields, file, keys, now, results, summary

      const daysago = (timestamp) => {
        return Math.round((now - timestamp) / (86400 * 1000))
      }

      now = underscore.now()
      results = {}
      entries = await tokens.find()
      entries.forEach((entry) => {
        let publisher

        publisher = entry.publisher
        if (!publisher) return

        if (!results[publisher]) results[publisher] = underscore.pick(entry, [ 'publisher', 'verified' ])
        if (entry.verified) {
          underscore.extend(results[publisher], underscore.pick(entry, [ 'verified', 'verificationId', 'token', 'reason' ]))
        }

        if (!results[publisher].history) results[publisher].history = []
        entry.created = new Date(parseInt(entry._id.toHexString().substring(0, 8), 16) * 1000).getTime()
        entry.modified = (entry.timestamp.high_ * 1000) + (entry.timestamp.low_ / bson.Timestamp.TWO_PWR_32_DBL_)
        results[publisher].history.push(underscore.extend(underscore.omit(entry, [ 'publisher', 'timestamp', 'info' ]),
                                                          entry.info || {}))
      })
      if (typeof verified === 'boolean') {
        underscore.keys(results).forEach((publisher) => {
          if (results[publisher].verified !== verified) delete results[publisher]
        })
      }

      summary = await voting.aggregate([
        {
          $match: {
            probi: { $gt: 0 },
            altcurrency: { $eq: altcurrency },
            exclude: false
          }
        },
        {
          $group: {
            _id: '$publisher',
            probi: { $sum: '$probi' }
          }
        }
      ])
      summary.forEach((entry) => { probi[entry._id] = new BigNumber(entry.probi.toString()) })

      summary = await referrals.aggregate([
        {
          $match: {
            probi: { $gt: 0 },
            altcurrency: { $eq: altcurrency },
            exclude: false
          }
        },
        {
          $group: {
            _id: '$publisher',
            probi: { $sum: '$probi' }
          }
        }
      ])
      summary.forEach((entry) => {
        if (!probi[entry._id]) probi[entry._id] = new BigNumber(0)
        probi[entry._id] = probi[entry._id].plus(new BigNumber(entry.probi.toString()))
      })

      summary = await settlements.aggregate([
        {
          $match: {
            probi: { $gt: 0 },
            altcurrency: { $eq: altcurrency }
          }
        },
        {
          $group: {
            _id: '$publisher',
            probi: { $sum: '$probi' }
          }
        }
      ])
      summary.forEach((entry) => {
        if (typeof probi[entry._id] !== 'undefined') {
          probi[entry._id] = new BigNumber(probi[entry._id].toString()).minus(entry.probi)
        }
      })

      f = async (publisher) => {
        let datum, owner

        results[publisher].probi = probi[publisher] || new BigNumber(0)
        results[publisher].USD = runtime.currency.alt2fiat(altcurrency, results[publisher].probi, 'USD')
        results[publisher].probi = results[publisher].probi.truncated().toString()

        if (results[publisher].history) {
          results[publisher].history = underscore.sortBy(results[publisher].history, (record) => {
            return (record.verified ? Number.POSITIVE_INFINITY : record.modified)
          })
          if (!results[publisher].verified) results[publisher].reason = underscore.last(results[publisher].history).reason
        }

        datum = await publishers.findOne({ publisher: publisher })
        if (datum) {
          datum.created = new Date(parseInt(datum._id.toHexString().substring(0, 8), 16) * 1000).getTime()
          datum.modified = (datum.timestamp.high_ * 1000) + (datum.timestamp.low_ / bson.Timestamp.TWO_PWR_32_DBL_)
          underscore.extend(results[publisher],
                            underscore.omit(datum, [ '_id', 'publisher', 'timestamp', 'verified', 'info' ]), datum.info)

          owner = (datum.owner) && (await owners.findOne({ owner: datum.owner }))
          if (owner) {
            if (!owner.info) owner.info = {}

            results[publisher].owner = owner.info && owner.info.name
            if (!datum.provider) results[publisher].provider = owner.provider

            if (!results[publisher].name) results[publisher].name = owner.info.name
            if (!results[publisher].email) results[publisher].email = owner.info.email
            if (!results[publisher].phone) results[publisher].phone = owner.info.phone
          }
        }

        if (elideP) {
          if (results[publisher].email) results[publisher].email = 'yes'
          if (results[publisher].phone) results[publisher].phone = 'yes'
          if (results[publisher].verificationId) results[publisher].verificationId = 'yes'
          if (results[publisher].token) results[publisher].token = 'yes'
        }

        data.push(results[publisher])
      }
      data = []
      keys = underscore.keys(results)
      for (let key of keys) await f(key)
      results = data.sort(publisherCompare)

      file = await create(runtime, 'publishers-status-', payload)
      if (format === 'json') {
        await file.write(utf8ify(data), true)
        return runtime.notify(debug, { channel: '#publishers-bot', text: authority + ' report-publishers-status completed' })
      }

      data = []
      results.forEach((result) => {
        const props = getPublisherProps(result.publisher)
        const publisher = result.publisher

        if ((props) && (props.URL)) result.publisher = props.URL
        if (!result.created) {
          underscore.extend(result, underscore.pick(underscore.last(result.history), [ 'created', 'modified' ]))
        }
        result = underscore.extend(underscore.omit(result, [ 'history' ]), {
          created: dateformat(result.created, datefmt),
          modified: dateformat(result.modified, datefmt)
        })
        if (result.reason !== 'bulk loaded') result.daysInQueue = daysago(result.created)
        data.push(result)

        if ((!summaryP) && (result.history)) {
          result.history.forEach((record) => {
            if (elideP) {
              if (record.email) record.email = 'yes'
              if (record.phone) record.phone = 'yes'
              if (record.verificationId) record.verificationId = 'yes'
              if (record.token) record.token = 'yes'
            }
            data.push(underscore.extend({ publisher: publisher }, record,
              { created: dateformat(record.created, datefmt),
                modified: dateformat(record.modified, datefmt),
                daysInQueue: daysago(record.created)
              }))
          })
        }
      })

      fields = [ 'owner', 'publisher', 'USD', 'probi',
        'verified', 'authorized', 'authority',
        'name', 'email', 'phone', 'provider', 'altcurrency', 'visible',
        'verificationId', 'reason',
        'daysInQueue', 'created', 'modified' ]
      if (!summaryP) fields.push('token')
      try { await file.write(utf8ify(json2csv({ data: data, fields: fields })), true) } catch (ex) {
        debug('reports', { report: 'report-publishers-status', reason: ex.toString() })
        file.close()
      }
      runtime.notify(debug, { channel: '#publishers-bot', text: authority + ' report-publishers-status completed' })
    },

/* sent by GET /v1/reports/surveyors-contributions

    { queue            : 'report-surveyors-contributions'
    , message          :
      { reportId       : '...'
      , reportURL      : '...'
      , authority      : '...:...'
      , format         : 'json' | 'csv'
      , summary        :  true  | false
      , excluded       :  true  | false | undefined
      }
    }
 */
  'report-surveyors-contributions':
    async (debug, runtime, payload) => {
      const authority = payload.authority
      const format = payload.format || 'csv'
      const excluded = payload.excluded
      const summaryP = (excluded !== true) ? payload.summary : false
      const settlements = runtime.database.get('settlements', debug)
      const voting = runtime.database.get('voting', debug)
      let data, fields, file, mixerP, previous, results, slices, publishers

      if (!summaryP) {
        previous = await settlements.aggregate([
          {
            $match: {
              probi: { $gt: 0 },
              altcurrency: { $eq: altcurrency },
              type: 'contribution'
            }
          },
          {
            $group: {
              _id: '$publisher',
              probi: { $sum: '$probi' },
              fees: { $sum: '$fees' }
            }
          }
        ])
        publishers = []
        previous.forEach((entry) => {
          publishers[entry._id] = underscore.omit(entry, [ '_id' ])
        })
      }

      data = underscore.sortBy(await quanta(debug, runtime, undefined), 'created')
      if (!summaryP) {
        for (let quantum of data) {
          slices = await voting.find({ surveyorId: quantum.surveyorId, exclude: false })
          for (let slice of slices) {
            if (slice.probi) continue

            mixerP = true
            break
          }

          if (mixerP) break
        }

        if (mixerP) await mixer(debug, runtime, undefined, undefined)
      }

      results = []
      for (let quantum of data) {
        quantum = underscore.extend(quantum, {
          probi: new BigNumber(quantum.probi.toString()).truncated().toString(),
          fee: quantum.fee.toString(),
          inputs: quantum.inputs.toString(),
          quantum: new BigNumber(quantum.quantum.toString()).truncated().toString()
        })
        results.push(quantum)
        if (summaryP) continue

        slices = await voting.find(underscore.extend({ surveyorId: quantum.surveyorId },
                                                     typeof excluded !== 'undefined' ? { exclude: excluded } : {}))
        slices.forEach((slice) => {
          let probi

          slice.probi = new BigNumber(slice.probi ? slice.probi.toString() : '0')
          if (publishers[slice.publisher]) {
            probi = new BigNumber(publishers[slice.publisher].probi.toString())

            if (probi.lessThan(slice.probi)) slice.probi = slice.probi.minus(probi)
            else {
              probi = probi.minus(slice.probi)
              if (probi.greaterThan(0)) publishers[slice.publisher].probi = probi
              else if (!excluded) delete publishers[slice.publisher]

              return
            }
          }

          results.push({
            surveyorId: slice.surveyorId,
            altcurrency: slice.altcurrency,
            probi: slice.probi.truncated().toString(),
            publisher: slice.publisher,
            votes: slice.counts,
            created: new Date(parseInt(slice._id.toHexString().substring(0, 8), 16) * 1000).getTime(),
            modified: (slice.timestamp.high_ * 1000) + (slice.timestamp.low_ / bson.Timestamp.TWO_PWR_32_DBL_),
            cohort: slice.cohort || 'control'
          })
        })
      }

      file = await create(runtime, 'surveyors-contributions-', payload)
      if (format === 'json') {
        await file.write(utf8ify(results), true)
        return runtime.notify(debug, {
          channel: '#publishers-bot',
          text: authority + ' report-surveyors-contributions completed'
        })
      }

      results.forEach((result) => {
        underscore.extend(result,
                          { created: dateformat(result.created, datefmt), modified: dateformat(result.modified, datefmt) })
      })

      fields = [ 'surveyorId', 'probi', 'fee', 'inputs', 'quantum' ]
      if (!summaryP) fields.push('publisher')
      fields = fields.concat([ 'votes', 'created', 'modified' ])
      if (!summaryP) fields.push('cohort')
      try {
        await file.write(utf8ify(json2csv({ data: await labelize(debug, runtime, results), fields: fields })), true)
      } catch (ex) {
        debug('reports', { report: 'report-surveyors-contributions', reason: ex.toString() })
        file.close()
      }
      runtime.notify(debug, { channel: '#publishers-bot', text: authority + ' report-surveyors-contributions completed' })
    },
/* sent by GET /v1/reports/grants-outstanding

    { queue            : 'report-grants-outstanding'
    , message          :
      { reportId       : '...'
      , reportURL      : '...'
      , authority      : '...:...'
      , format         : 'json' | 'csv'
      }
    }
 */
  'report-grants-outstanding':
    async (debug, runtime, payload) => {
      const authority = payload.authority
      const format = payload.format
      const grants = runtime.database.get('grants', debug)
      let results

      const promotions = await grants.aggregate([
        {
          $match: {
            probi: { $gt: 0 },
            altcurrency: { $eq: altcurrency }
          }
        },
        {
          $group: {
            _id: '$promotionId',
            probi: { $sum: '$probi' },
            outstandingProbi: { $sum: { $cond: [ { $ne: [ '$redeemed', true ] }, '$probi', 0 ] } },
            count: { $sum: 1 },
            outstandingCount: { $sum: { $cond: [ { $ne: [ '$redeemed', true ] }, 1, 0 ] } }
          }
        }
      ])
      results = []
      const total = { probi: new BigNumber(0), outstandingProbi: new BigNumber(0), count: 0, outstandingCount: 0 }
      for (let promotion of promotions) {
        results.push({
          promotionId: promotion._id,
          probi: promotion.probi.toString(),
          outstandingProbi: promotion.outstandingProbi.toString(),
          count: promotion.count.toString(),
          outstandingCount: promotion.outstandingCount.toString()
        })
        total.probi.plus(promotion.probi.toString())
        total.outstandingProbi.plus(promotion.outstandingProbi.toString())
        total.count += promotion.count
        total.outstandingCount += promotion.outstandingCount
      }

      total.probi = total.probi.toString()
      total.outstandingProbi = total.outstandingProbi.toString()
      total.count = total.count.toString()
      total.outstandingCount = total.outstandingCount.toString()
      results.unshift(total)

      const file = await create(runtime, 'grants-outstanding-', payload)
      if (format === 'json') {
        await file.write(utf8ify(results), true)
        return runtime.notify(debug, {
          channel: '#publishers-bot',
          text: authority + ' report-grants-outstanding completed'
        })
      }

      const fields = [ 'promotionId', 'probi', 'outstandingProbi', 'count', 'outstandingCount' ]
      try {
        await file.write(utf8ify(json2csv({ data: await labelize(debug, runtime, results), fields: fields })), true)
      } catch (ex) {
        debug('reports', { report: 'report-grants-outstanding', reason: ex.toString() })
        file.close()
      }
      runtime.notify(debug, { channel: '#publishers-bot', text: authority + ' report-grants-outstanding completed' })
    }
}

module.exports = exports
