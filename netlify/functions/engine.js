/**
 * FUNDO engine v2 — Netlify Functions edition, with full self-diagnostics.
 *   POST  /.netlify/functions/engine           body {"sms": "..."} -> match + approve
 *   GET   /.netlify/functions/engine?sweep=1   -> withdrawal autopilot + auto-decline
 *   GET   /.netlify/functions/engine?ping=1&key=YOUR_HOOK_KEY  -> self-test (open in browser)
 * Every call needs header x-autopilot-key: <HOOK_KEY> (or ?key= for the ping test only).
 */
const admin = require('firebase-admin')

const VERIFY_CHARGE = 200
const MATCH_WINDOW_MS = 45 * 60 * 1000

const KINDS = {
  fnd: { collection: 'fndOrders', label: 'FND order' },
  verify: { collection: 'verifyRequests', label: 'Verification deposit' },
  upgrade: { collection: 'upgradeRequests', label: 'Upgrade deposit' },
}

/* ------------------------------- parsing ---------------------------------- */

function parseAmount(text) {
  if (!text) return 0
  const num = raw => Number(String(raw).replace(/,/g, ''))
  const ok = v => Number.isFinite(v) && v >= 100
  let m
  if ((m = /\b(?:amt|amount)\b\s*[:\-]?\s*(?:₦|ngn|n)?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text))) { const v = num(m[1]); if (ok(v)) return v }
  if ((m = /([\d,]+\.\d{2})\s*(?:was\s+)?(?:credited|received|deposited)/i.exec(text))) { const v = num(m[1]); if (ok(v)) return v }
  if ((m = /(?:₦|NGN|N(?![a-z]))\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text))) { const v = num(m[1]); if (ok(v)) return v }
  return 0
}

function isCreditAlert(text) {
  if (!text) return false
  const credit = /(credit|credited|deposited|has been funded|received)/i.test(text)
  const debit = /(debit|debited|withdrawn|deducted|reversed)/i.test(text)
  return credit && !debit
}

/* --------------------------- firestore helpers ----------------------------- */

let db, messaging

function init() {
  if (db) return
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is missing — add it under Environment variables (NOT Secrets), then redeploy')
  let sa
  try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) }
  catch (e) { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON (pasted wrong / truncated / smart quotes). Re-copy the whole service-account file.') }
  admin.initializeApp({ credential: admin.credential.cert(sa) })
  db = admin.firestore()
  messaging = admin.messaging()
}

function getCreatedMs(data, fallback) {
  const c = data.createdAt
  if (c && typeof c.toMillis === 'function') return c.toMillis()
  if (typeof c === 'number') return c
  if (c && typeof c.seconds === 'number') return c.seconds * 1000
  if (c instanceof Date) return c.getTime()
  return fallback
}

async function getAutopilotConfig() {
  const snap = await db.doc('settings/autopilot').get()
  const data = snap.exists ? snap.data() : {}
  return {
    fnd: data.fnd !== false,
    verify: data.verify !== false,
    upgrade: data.upgrade !== false,
    windowMinutes: Math.max(1, Number(data.windowMinutes) || 60),
  }
}

async function notifyAdmins(title, body) {
  try {
    const devices = await db.collection('adminDevices').limit(500).get()
    const tokens = devices.docs.map(d => d.data().token).filter(Boolean)
    for (let i = 0; i < tokens.length; i += 500) {
      try { await messaging.sendEachForMulticast({ tokens: tokens.slice(i, i + 500), notification: { title, body } }) }
      catch (e) { console.error('push failed', e.message) }
    }
  } catch (e) { console.error('notifyAdmins failed', e.message) }
}

async function logAction(kind, action, data, detail) {
  await db.collection('autopilotLog').add({
    kind, action,
    amount: Number(data.amount) || 0,
    charge: action === 'approved' && kind === 'verify' ? VERIFY_CHARGE : 0,
    uid: data.uid || null,
    ref: data.ref || data.note || null,
    detail: detail || '',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
}

function userNotif(uid, title, body, type) {
  return db.collection('usernotifs').doc(uid).collection('items').add({
    title, body, type, createdAt: admin.firestore.FieldValue.serverTimestamp(),
  })
}

/* ------------------------- approve matched request ------------------------- */

async function approveMatch(amount, debug) {
  const config = await getAutopilotConfig()
  debug.config = config
  const now = Date.now()
  for (const [kind, meta] of Object.entries(KINDS)) {
    if (!config[kind]) { debug.steps.push(kind + ': autopilot OFF'); continue }
    let pending
    try {
      pending = await db.collection(meta.collection).where('status', '==', 'pending').limit(100).get()
    } catch (e) {
      debug.steps.push(kind + ': query FAILED - ' + e.message)
      continue
    }
    const candidates = pending.docs
      .map(d => ({ ref: d.ref, data: d.data() }))
      .filter(x => Number(x.data.amount) === amount)
      .sort((a, b) => getCreatedMs(a.data, now) - getCreatedMs(b.data, now))
    debug.steps.push(kind + ': ' + pending.size + ' pending, ' + candidates.length + ' with amount ' + amount)
    const doc = candidates[0]
    if (!doc) continue
    const createdMs = getCreatedMs(doc.data, now)
    if (now - createdMs > MATCH_WINDOW_MS) { debug.steps.push(kind + ': match too old'); continue }
    const data = doc.data
    const userRef = db.collection('users').doc(data.uid)

    await db.runTransaction(async tx => {
      const [reqSnap, userSnap] = await Promise.all([tx.get(doc.ref), tx.get(userRef)])
      if (!reqSnap.exists || reqSnap.data().status !== 'pending') throw new Error('already processed')
      if (!userSnap.exists) throw new Error('user doc missing: ' + data.uid)
      tx.update(doc.ref, { status: 'approved', processedAt: admin.firestore.FieldValue.serverTimestamp(), processedBy: 'autopilot' })
      if (kind === 'fnd') {
        tx.update(userRef, { fndBalance: admin.firestore.FieldValue.increment(Number(data.fnd) || 0) })
      } else if (kind === 'verify') {
        tx.update(userRef, { bankVerified: true, balance: admin.firestore.FieldValue.increment(amount - VERIFY_CHARGE) })
      } else if (kind === 'upgrade') {
        tx.update(userRef, { miningTier: data.tier || 'free' })
      }
    })

    const detail = `Matched bank alert ₦${amount.toLocaleString('en-NG')}`
    await logAction(kind, 'approved', { ...data, amount }, detail)
    if (kind === 'fnd') await userNotif(data.uid, 'FND order approved', `${Number(data.fnd) || 0} FND has been added to your wallet.`, 'payout')
    if (kind === 'verify') await userNotif(data.uid, 'Account verified', `Your bank account has been verified. Your verification deposit of ₦${(amount - VERIFY_CHARGE).toLocaleString('en-NG')} has been refunded (₦${VERIFY_CHARGE.toLocaleString('en-NG')} verification charge applied).`, 'payout')
    if (kind === 'upgrade') await userNotif(data.uid, 'Plan upgraded', `Your plan was upgraded to ${String(data.tier || '').toUpperCase()}. Higher mining rates are now active!`, 'bonus')
    await notifyAdmins(`Autopilot approved ${meta.label}`, `₦${amount.toLocaleString('en-NG')} · ${data.ref || data.note || ''} · ${detail}`)
    debug.steps.push(kind + ': APPROVED')
    return { kind, amount }
  }
  return null
}

/* ------------------------- scheduled sweep work ---------------------------- */

async function sweepWithdrawals() {
  const snap = await db.doc('settings/withdrawAutopilot').get()
  const mode = snap.exists && snap.data().mode
  if (mode !== 'approve' && mode !== 'decline') return { processed: 0 }
  const pending = await db.collection('withdrawals').where('status', '==', 'pending').limit(20).get()
  let processed = 0, totalValue = 0
  for (const doc of pending.docs) {
    const data = doc.data()
    const amount = Number(data.amount) || 0
    try {
      await db.runTransaction(async tx => {
        const reqSnap = await tx.get(doc.ref)
        if (!reqSnap.exists || reqSnap.data().status !== 'pending') return
        tx.update(doc.ref, { status: mode, processedAt: admin.firestore.FieldValue.serverTimestamp(), processedBy: 'autopilot' })
        if (mode === 'decline') {
          const userRef = db.collection('users').doc(data.uid)
          const userSnap = await tx.get(userRef)
          if (!userSnap.exists) throw new Error('user missing — no refund made')
          tx.update(userRef, { balance: admin.firestore.FieldValue.increment(amount) })
        }
        tx.set(db.collection('usernotifs').doc(data.uid).collection('items').doc(), {
          title: mode === 'approve' ? 'Withdrawal approved' : 'Withdrawal declined',
          body: mode === 'approve'
            ? `Your withdrawal of ₦${amount.toLocaleString('en-NG')} has been approved and is being processed to your ${data.bankName || 'bank'}.`
            : `Your withdrawal of ₦${amount.toLocaleString('en-NG')} was declined. The amount has been refunded to your balance.`,
          type: mode === 'approve' ? 'payout' : 'alert',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })
      })
      processed += 1; totalValue += amount
    } catch (e) { console.error('withdrawal skipped:', e.message) }
  }
  if (processed) {
    await logAction('withdraw', mode, { amount: totalValue, uid: null, ref: null }, `${processed} request(s) auto-${mode} · ₦${totalValue.toLocaleString('en-NG')}${mode === 'decline' ? ' refunded' : ''}`)
    await notifyAdmins(`Autopilot ${mode === 'approve' ? 'approved' : 'declined & refunded'} ${processed} withdrawal${processed === 1 ? '' : 's'}`,
      `₦${totalValue.toLocaleString('en-NG')} total · ${processed} pending request(s) auto-${mode}${mode === 'decline' ? ' · balances refunded' : ''}.`)
  }
  return { processed, mode }
}

async function autoDeclineStale() {
  const config = await getAutopilotConfig()
  const windowMs = config.windowMinutes * 60 * 1000
  const now = Date.now()
  let declined = 0
  for (const [kind, meta] of Object.entries(KINDS)) {
    if (!config[kind]) continue
    const stale = await db.collection(meta.collection).where('status', '==', 'pending').limit(20).get()
    for (const doc of stale.docs) {
      const data = doc.data()
      const createdMs = getCreatedMs(data, now)
      if (now - createdMs < windowMs) continue
      const userRef = db.collection('users').doc(data.uid)
      await db.runTransaction(async tx => {
        const reqSnap = await tx.get(doc.ref)
        if (!reqSnap.exists || reqSnap.data().status !== 'pending') return
        tx.update(doc.ref, { status: 'declined', processedAt: admin.firestore.FieldValue.serverTimestamp(), processedBy: 'autopilot' })
        if (kind === 'verify') {
          const userSnap = await tx.get(userRef)
          if (userSnap.exists) tx.update(userRef, { balance: admin.firestore.FieldValue.increment(Number(data.amount) || 0) })
        }
      })
      const detail = `No bank alert within ${config.windowMinutes} minutes`
      await logAction(kind, 'declined', data, detail)
      const title = kind === 'fnd' ? 'FND order declined' : kind === 'verify' ? 'Verification declined' : 'Upgrade declined'
      const body = kind === 'verify'
        ? `Your verification deposit was not confirmed and ₦${Number(data.amount || 0).toLocaleString('en-NG')} has been refunded. Contact support with your payment reference.`
        : `Your ${meta.label.toLowerCase()} was not confirmed. Contact support with your payment reference if you believe this is a mistake.`
      await userNotif(data.uid, title, body, 'alert')
      await notifyAdmins(`Autopilot declined ${meta.label}`, `₦${Number(data.amount || 0).toLocaleString('en-NG')} · ${data.ref || data.note || ''} · ${detail}`)
      declined += 1
    }
  }
  return { declined }
}

/* -------------------------------- handler ---------------------------------- */

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
  const params = event.queryStringParameters || {}
  const headers = event.headers || {}
  const key = headers['x-autopilot-key'] || headers['X-Autopilot-Key'] || params.key || ''
  const auth = { hookKeyEnvSet: !!process.env.HOOK_KEY, authMatched: !!(process.env.HOOK_KEY && key === process.env.HOOK_KEY) }

  if (!auth.authMatched) return json(401, { ok: false, error: 'unauthorised — HOOK_KEY mismatch', auth })

  // ---- self-test: open in browser -> .../engine?ping=1&key=YOUR_HOOK_KEY ----
  if (params.ping === '1') {
    const diag = { ok: true, auth, env: { serviceAccountSet: !!process.env.FIREBASE_SERVICE_ACCOUNT }, parseTest: parseAmount('Sparkle Alert Money received! Amt: N6,500.00 Bal: N6,590.00') }
    try {
      init()
      diag.firebaseInit = 'ok'
      diag.config = await getAutopilotConfig()
      await db.doc('settings/autopilot').get()
      diag.firestoreRead = 'ok'
      const t = await db.collection('fndOrders').where('status', '==', 'pending').limit(5).get()
      diag.pendingFndOrders = t.size
      diag.samplePendingAmounts = t.docs.map(d => Number(d.data().amount) || 0)
    } catch (e) {
      diag.firebaseInit = 'ERROR: ' + e.message
      diag.ok = false
    }
    return json(200, diag)
  }

  try { init() } catch (e) { return json(500, { ok: false, error: e.message, auth }) }

  try {
    if (params.sweep === '1') {
      const withdrawals = await sweepWithdrawals()
      const stale = await autoDeclineStale()
      return json(200, { ok: true, withdrawals, stale })
    }

    let body = {}
    try { body = JSON.parse(event.body || '{}') } catch (e) { /* form posts fall through */ }
    const sms = String(body.sms || body.text || body.message || '')
    if (!sms.trim()) return json(400, { ok: false, error: 'missing sms' })

    if (!isCreditAlert(sms)) return json(200, { ok: true, ignored: 'not a credit alert' })
    const amount = parseAmount(sms)
    if (!amount) return json(200, { ok: true, ignored: 'no amount found' })

    await db.collection('bankAlerts').add({
      amount, text: sms.slice(0, 500), createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    const debug = { steps: [] }
    const match = await approveMatch(amount, debug)
    return json(200, { ok: true, amount, matched: match, debug })
  } catch (e) {
    console.error('ENGINE ERROR:', e)
    return json(500, { ok: false, error: e.message, stack: String(e.stack || '').split('\n')[0] })
  }
}
