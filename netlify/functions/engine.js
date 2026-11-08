/**
 * FUNDO Autopilot Engine — v6.4 (Netlify Function)
 *
 * ONE endpoint does everything:  https://<your-site>.netlify.app/.netlify/functions/engine
 *
 *  POST { "sms": "<bank alert text>" }        → parse alert, approve matching pending request
 *  GET  ?sweep=1                              → run withdrawal autopilot pass + stale-order cleanup
 *  GET  ?ping=1&key=HOOK_KEY                  → self-test / diagnostics (no writes)
 *  GET  ?approve=AMOUNT&name=NAME&key=KEY     → force-approve one pending order (test tool)
 *
 * Every call (except OPTIONS) needs the HOOK_KEY: header  x-autopilot-key: <key>  or ?key=<key>.
 *
 * v6.4 changes vs v6.3 — timezone-safe time matching:
 *  - Sparkle stamps "When" in NIGERIA time (WAT, UTC+1); the server runs UTC.
 *    Even after the 12-hour-clock repair the stamp sits ~1h off the server
 *    clock, so comparing it to the order timestamp with ±10min failed every
 *    payment that relied on amount+time. The stamp is now only compared to
 *    the SMS ARRIVAL time (±3h sanity bound): the message arriving IS the
 *    proof the deposit just happened. Order freshness is judged by the
 *    order's own age (< MATCH_WINDOW 45min, and in practice < windowMinutes
 *    because auto-decline kills anything older).
 *
 * v6.3 changes vs v6.2 — Sparkle format fixes:
 *  - Sparkle "When" is 12-hour clock without AM/PM (a 3:48 PM deposit is
 *    stamped "03:48"). When the parsed When is >2h away from the SMS arrival
 *    time but +12h lands within 2h of now, the stamp is auto-repaired.
 *  - Time tolerance raised 2min → 10min: a still-pending order can never
 *    outlive the auto-decline window, so ±10min stays safe while letting
 *    buyers who take a few minutes to transfer still match.
 *
 * v6.2 changes vs v6.1 — smarter payment matching (FND / verify / upgrade):
 *  - The alert's RECEIVER name ("To: NAME" / "credited to NAME") is now parsed and
 *    matched against the order owner's linked-account / profile names. Chain:
 *      1. sender name vs order ref/note
 *      2. receiver name vs linked account / profile name   ← NEW
 *      3. sender name vs profile name
 *      4. amount + time window
 *  - AMOUNT-DIFFERENCE RESCUE (NEW): if no pending order matches the alert amount
 *    exactly (bank fees shave credits), a strong name match (receiver or sender)
 *    + valid time window approves the closest-amount pending order instead of
 *    letting it auto-decline. The approval log records the exact difference.
 *
 * v6/v5 changes:
 *  - Withdrawal autopilot honours settings/withdrawAutopilot.delaySeconds (default 30).
 *  - Upgrade approvals stamp planExpiresAt from the plan's durationMonths.
 *  - sweep=1 returns a full per-run summary.
 */

const admin = require('firebase-admin')

/* --------------------------- firebase init -------------------------------- */

function initFirebase() {
  if (admin.apps.length) return
  const json = process.env.FIREBASE_SERVICE_ACCOUNT
  if (json && json.trim().startsWith('{')) {
    const sa = JSON.parse(json)
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n')
    admin.initializeApp({ credential: admin.credential.cert(sa) })
    return
  }
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env
  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    })
    return
  }
  // last resort — works only if GOOGLE_APPLICATION_CREDENTIALS is set on the builder
  admin.initializeApp()
}

initFirebase()
const db = admin.firestore()
let messaging = null
try { messaging = admin.messaging() } catch (e) { console.log('FCM unavailable:', e.message) }

/* ------------------------------- consts ----------------------------------- */

const KINDS = {
  fnd: { collection: 'fndOrders', label: 'FND order' },
  verify: { collection: 'verifyRequests', label: 'Verification deposit' },
  upgrade: { collection: 'upgradeRequests', label: 'Upgrade deposit' },
}
const VERIFY_CHARGE = 200
const MATCH_WINDOW_MS = 45 * 60 * 1000   // no usable "When" in the SMS → order must be younger than this
const WHEN_SANE_MS = 3 * 60 * 60 * 1000  // bank "When" stamps are in the BANK's timezone (Sparkle = WAT,
                                         // server = UTC), so the stamp is only trusted as "the deposit
                                         // just happened" when it lands within ±3h of the SMS arriving.
                                         // Never compared directly to the server clock.

/* ------------------------------- parsing ---------------------------------- */

function parseAmount(text) {
  if (!text) return 0
  const num = raw => Number(String(raw).replace(/,/g, ''))
  const ok = v => Number.isFinite(v) && v >= 100
  let m
  if ((m = /\b(?:amt|amount)\b\s*[:\-]?\s*(?:₦|ngn|n)?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text))) {
    const v = num(m[1]); if (ok(v)) return v
  }
  if ((m = /([\d,]+\.\d{2})\s*(?:was\s+)?(?:credited|received|deposited)/i.exec(text))) {
    const v = num(m[1]); if (ok(v)) return v
  }
  if ((m = /(?:₦|NGN|N(?![a-z]))\s*([\d,]+(?:\.\d{1,2})?)/i.exec(text))) {
    const v = num(m[1]); if (ok(v)) return v
  }
  return 0
}

function isCreditAlert(text) {
  if (!text) return false
  const credit = /(credit|credited|deposited|has been funded|received)/i.test(text)
  const debit = /(debit|debited|withdrawn|deducted|reversed)/i.test(text)
  return credit && !debit
}

// "From: JOHN CHIDI OBIANO" → sender name
function parseName(text) {
  if (!text) return ''
  const m = /\bfrom:\s*([A-Za-z][A-Za-z .,'-]{2,60})/i.exec(text)
  if (!m) return ''
  const cut = /\b(desc|description|ref|reference|when|bal|balance|date|narration|time|via|to)\b/i.exec(m[1])
  return (cut ? m[1].slice(0, cut.index) : m[1]).trim()
}

// "To: JOHN CHIDI OBIANO" / "credited to JOHN OBIANO" / "paid into JOHN OBIANO's account"
// → receiver name (the FUNDO account the buyer deposited into)
function parseReceiver(text) {
  if (!text) return ''
  let m = /\bto:\s*([A-Za-z][A-Za-z .,'-]{2,60})/i.exec(text)
  if (!m) m = /(?:credited|paid|transferred)\s+(?:to|into)\s+([A-Za-z][A-Za-z .,'-]{2,60})/i.exec(text)
  if (!m) return ''
  const cut = /\b(desc|description|ref|reference|when|bal|balance|date|narration|time|via|from|amt|amount)\b/i.exec(m[1])
  return (cut ? m[1].slice(0, cut.index) : m[1]).trim()
}

// "When: 02/11/26 14:35" (DD/MM/YY[YY]) → epoch ms
function parseWhen(text) {
  if (!text) return 0
  const m = /\bwhen:\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})[ T](\d{1,2}):(\d{2})/i.exec(text)
  if (!m) return 0
  let [, d, mo, y, h, mi] = m
  d = Number(d); mo = Number(mo); y = Number(y); h = Number(h); mi = Number(mi)
  if (y < 100) y += y < 70 ? 2000 : 1900
  const ms = new Date(y, mo - 1, d, h, mi).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function parseAlert(text) {
  return { amount: parseAmount(text), name: parseName(text), receiver: parseReceiver(text), whenMs: parseWhen(text), text: String(text || '').slice(0, 500) }
}

/* ------------------------------ name match -------------------------------- */

function nameTokens(name) {
  if (!name) return []
  return String(name).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(t => t.length >= 3)
}

// true when the two names share enough tokens (handles "JOHN OBIANO" vs "John Chidi Obiano")
function nameMatches(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b)
  if (!ta.length || !tb.length) return false
  const setB = new Set(tb)
  const shared = ta.filter(t => setB.has(t)).length
  const minSize = Math.min(ta.length, tb.length)
  return shared >= Math.ceil(minSize * 0.5) // ≥50% of the smaller token set (covers full match too)
}

function profileNames(user) {
  if (!user) return []
  const out = []
  for (const k of ['fullName', 'name', 'displayName', 'bankAccountName', 'accountName', 'bankHolderName', 'accName']) {
    if (user[k]) out.push(String(user[k]))
  }
  if (user.firstName && user.lastName) out.push(`${user.firstName} ${user.lastName}`)
  // linked account stored as a nested object (verify page / app variants)
  const la = user.linkedAccount
  if (la && typeof la === 'object') {
    for (const k of ['accountName', 'holderName', 'name', 'fullName']) {
      if (la[k]) out.push(String(la[k]))
    }
  }
  return out
}

/* ------------------------------ helpers ----------------------------------- */

async function getAutopilotConfig() {
  const snap = await db.doc('settings/autopilot').get()
  const data = snap.exists ? snap.data() : {}
  return {
    fnd: data.fnd !== false,
    verify: data.verify !== false,
    upgrade: data.upgrade !== false,
    windowMinutes: Math.max(1, Number(data.windowMinutes) || 3),
    smsEndpoint: data.smsEndpoint || '',
  }
}

async function getWithdrawConfig() {
  const snap = await db.doc('settings/withdrawAutopilot').get()
  const data = snap.exists ? snap.data() : {}
  const mode = data.mode === 'approve' || data.mode === 'decline' ? data.mode : 'manual'
  const delaySeconds = Math.max(0, Math.min(3600, Number(data.delaySeconds) || 30))
  return { mode, delaySeconds }
}

async function notifyAdmins(title, body) {
  try {
    if (!messaging) return
    const devices = await db.collection('adminDevices').limit(500).get()
    const tokens = devices.docs.map(d => d.data().token).filter(Boolean)
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500)
      try { await messaging.sendEachForMulticast({ tokens: chunk, notification: { title, body } }) }
      catch (e) { console.error('push failed', e.message) }
    }
  } catch (e) { console.error('notifyAdmins failed', e.message) }
}

async function logAction(kind, action, data, detail) {
  try {
    await db.collection('autopilotLog').add({
      kind, action,
      amount: Number(data.amount) || 0,
      charge: action === 'approved' && kind === 'verify' ? VERIFY_CHARGE : 0,
      uid: data.uid || null,
      ref: data.ref || data.note || null,
      detail: detail || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  } catch (e) { console.error('logAction failed', e.message) }
}

function userNotif(uid, title, body, type) {
  return db.collection('usernotifs').doc(uid).collection('items').add({
    title, body, type, createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.error('userNotif failed', e.message))
}

const createdMsOf = data => (data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : Date.now())
const naira = v => '₦' + Number(v || 0).toLocaleString('en-NG')

/* ------------------------- approve matched request ------------------------ */

async function approveMatch(alert, options = {}) {
  const { force = false, debug = [] } = options
  const config = await getAutopilotConfig()
  const now = Date.now()

  // Sparkle sends "When" in 12-hour clock WITHOUT AM/PM — a 3:48 PM deposit
  // arrives stamped "03:48", exactly 12h behind the real time. If the parsed
  // When is implausibly far from the moment the SMS arrived but adding 12
  // hours lands close to now, treat it as a 12-hour-clock stamp and repair it.
  if (alert.whenMs && Math.abs(alert.whenMs - now) > 2 * 60 * 60 * 1000) {
    const repaired = alert.whenMs + 12 * 60 * 60 * 1000
    if (Math.abs(repaired - now) <= 2 * 60 * 60 * 1000) {
      debug.push(`alert When ${new Date(alert.whenMs).toISOString()} looks like 12-hour clock — repaired to ${new Date(repaired).toISOString()}`)
      alert.whenMs = repaired
    }
  }
  for (const [kind, meta] of Object.entries(KINDS)) {
    if (!config[kind] && !force) continue

    // Pass 1: pending orders with the EXACT alert amount.
    // Pass 2 (rescue): no exact-amount order exists and the alert carries a name
    //   → look across ALL pending amounts; a strong name match + time window
    //     approves the closest amount (handles bank fees shaving the credit).
    let pendingSnap = null
    let exactAmount = true
    {
      let q = db.collection(meta.collection).where('status', '==', 'pending')
      if (!force) q = q.where('amount', '==', alert.amount)
      q = q.orderBy('createdAt', 'asc').limit(10)
      pendingSnap = await q.get()
    }
    if (!force && pendingSnap.empty && (alert.name || alert.receiver)) {
      exactAmount = false
      debug.push(`${kind}: no pending order at exactly ${naira(alert.amount)} — trying name match across amounts`)
      pendingSnap = await db.collection(meta.collection).where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(10).get()
    }
    if (pendingSnap.empty) continue

    const candidates = []
    for (const doc of pendingSnap.docs) {
      const data = doc.data()
      const createdMs = createdMsOf(data)
      const selfName = data.ref || data.note || ''
      const nmSelf = Boolean(alert.name) && nameMatches(alert.name, selfName)
      let nmProfile = false, nmLinked = false
      try {
        const userSnap = await db.collection('users').doc(data.uid).get()
        const pnames = profileNames(userSnap.data())
        nmProfile = Boolean(alert.name) && pnames.some(p => nameMatches(alert.name, p))
        nmLinked = Boolean(alert.receiver) && pnames.some(p => nameMatches(alert.receiver, p))
      } catch (e) { /* user lookup failed — treat as no profile match */ }
      // Time evidence: the SMS arriving NOW is the anchor, not the server clock.
      // The order must still be fresh, and the bank stamp (already 12h-repaired)
      // must be plausibly "just now" within ±3h — after that it's an old payment.
      let timeOk, timediff = null
      if (alert.whenMs) {
        timediff = alert.whenMs - now
        timeOk = (now - createdMs) <= MATCH_WINDOW_MS && Math.abs(timediff) <= WHEN_SANE_MS
      } else {
        timeOk = now - createdMs <= MATCH_WINDOW_MS
      }
      const anyName = nmSelf || nmLinked || nmProfile
      // Rescue-mode guard: the amount is wrong by design (fees), but only within
      // reason — beyond fee tolerance the alert is NOT for this order.
      const diff = Math.abs((Number(data.amount) || 0) - alert.amount)
      const feeTol = Math.max(500, Math.round((alert.amount || 0) * 0.1))
      if (!exactAmount && diff > feeTol) {
        debug.push(`${kind}: order ${data.ref || data.note || data.uid} | amount differs by ${naira(diff)} — beyond ${naira(feeTol)} fee tolerance, skipped`)
        continue
      }
      // In rescue mode a name match + time window is mandatory (amount is unreliable).
      let via = nmSelf ? 'sender name from order'
        : nmLinked ? 'receiver name = linked account'
        : nmProfile ? 'sender name = account name'
        : timeOk && exactAmount ? 'amount+time'
        : !exactAmount && anyName && timeOk ? 'name+time' : null
      if (!exactAmount && via) via = `${via} (amount differs by ${naira(diff)}, within ${naira(feeTol)} fee tolerance)`
      debug.push(`${kind}: order ${data.ref || data.note || data.uid} | sender=${nmSelf ? 'MATCH' : 'no'} | receiver-linked=${nmLinked ? 'MATCH' : 'no'} | profile=${nmProfile ? 'MATCH' : 'no'} | when-vs-arrival=${timediff === null ? 'n/a' : Math.round(timediff / 1000) + 's'} | orderAge=${Math.round((now - createdMs) / 1000) + 's'} | timeOk=${timeOk}`)
      if (!via && !(force && !alert.name)) continue // no clue matched — leave it for the next alert
      // force approve with no name: take the oldest pending of this amount regardless of time
      candidates.push({ doc, data, via })
    }
    if (!candidates.length) continue
    // rescue mode: among the name-matched orders pick the amount closest to the alert
    const pick = exactAmount
      ? candidates[0]
      : candidates.reduce((a, b) => Math.abs((Number(a.data.amount) || 0) - alert.amount) <= Math.abs((Number(b.data.amount) || 0) - alert.amount) ? a : b)

    {
      const doc = pick.doc
      const data = pick.data
      const via = pick.via

      const userRef = db.collection('users').doc(data.uid)
      try {
        await db.runTransaction(async tx => {
          const [reqSnap, userSnap] = await Promise.all([tx.get(doc.ref), tx.get(userRef)])
          if (!reqSnap.exists || reqSnap.data().status !== 'pending') throw new Error('already processed')
          if (!userSnap.exists) throw new Error('user missing')
          tx.update(doc.ref, { status: 'approved', processedAt: admin.firestore.FieldValue.serverTimestamp(), processedBy: 'autopilot' })
          if (kind === 'fnd') {
            tx.update(userRef, { fndBalance: admin.firestore.FieldValue.increment(Number(data.fnd) || 0) })
          } else if (kind === 'verify') {
            tx.update(userRef, { bankVerified: true, balance: admin.firestore.FieldValue.increment(Number(data.amount) - VERIFY_CHARGE) })
          } else if (kind === 'upgrade') {
            // Plan duration: stamp when the paid plan lapses. Read the plan
            // doc's durationMonths (1/2/3 months, or 0/absent = lifetime) and
            // set planExpiresAt accordingly — the app downgrades the account
            // to Free once it passes.
            let months = 0
            try {
              const planSnap = await tx.get(db.collection('plans').doc(String(data.tier || 'free')))
              if (planSnap.exists) months = Math.floor(Number(planSnap.data().durationMonths) || 0)
            } catch (e) { /* plan doc missing — treat as lifetime */ }
            tx.update(userRef, { miningTier: data.tier || 'free', planExpiresAt: months > 0 ? Math.round(Date.now() + months * 30.44 * 86400000) : null })
          }
        })
      } catch (e) {
        debug.push(`${kind}: order ${data.ref || data.note || data.uid} | transaction failed: ${e.message}`)
        continue
      }
      const detail = `Matched bank alert ${naira(alert.amount || data.amount)} via ${via}`
      await logAction(kind, 'approved', { ...data, amount: Number(data.amount) || alert.amount }, detail)
      if (kind === 'fnd') await userNotif(data.uid, 'FND order approved', `${Number(data.fnd) || 0} FND has been added to your wallet.`, 'payout')
      if (kind === 'verify') await userNotif(data.uid, 'Account verified', `Your bank account has been verified. Your verification deposit of ${naira(Number(data.amount) - VERIFY_CHARGE)} has been refunded (${naira(VERIFY_CHARGE)} verification charge applied).`, 'payout')
      if (kind === 'upgrade') await userNotif(data.uid, 'Plan upgraded', `Your plan was upgraded to ${String(data.tier || '').toUpperCase()}. Higher mining rates are now active!`, 'bonus')
      await notifyAdmins(`Autopilot approved ${meta.label}`, `${naira(data.amount)} · ${data.ref || data.note || ''} · ${detail}`)
      return { kind, amount: Number(data.amount) || alert.amount, via, ref: data.ref || data.note || '' }
    }
  }
  return null
}

/* ------------------------- withdrawal autopilot ---------------------------
 * mode 'approve': approve pending withdrawals older than delaySeconds.
 * mode 'decline': decline AND refund pending withdrawals older than delaySeconds.
 * mode 'manual':  does nothing.
 */

async function sweepWithdrawals() {
  const { mode, delaySeconds } = await getWithdrawConfig()
  if (mode !== 'approve' && mode !== 'decline') return { mode, delaySeconds, processed: 0, tooFresh: 0, skipped: 'manual mode — nothing to do' }
  const now = Date.now()
  const pending = await db.collection('withdrawals').where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(20).get()
  let processed = 0, tooFresh = 0, totalValue = 0
  const details = []
  for (const doc of pending.docs) {
    const data = doc.data()
    const amount = Number(data.amount) || 0
    const ageSec = Math.round((now - createdMsOf(data)) / 1000)
    if (ageSec < delaySeconds) { tooFresh += 1; details.push(`${data.ref || doc.id}: ${ageSec}s old — waiting for ${delaySeconds}s`); continue }
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
            ? `Your withdrawal of ${naira(amount)} has been approved and is being processed to your ${data.bankName || 'bank'}.`
            : `Your withdrawal of ${naira(amount)} was declined. The amount has been refunded to your balance.`,
          type: mode === 'approve' ? 'payout' : 'alert',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        })
      })
      processed += 1; totalValue += amount
      details.push(`${data.ref || doc.id}: auto-${mode} ${naira(amount)} (${ageSec}s old)`)
    } catch (e) {
      console.error('sweepWithdrawals skipped a request:', e.message)
      details.push(`${data.ref || doc.id}: FAILED — ${e.message}`)
    }
  }
  if (processed) {
    await logAction('withdraw', mode, { amount: totalValue, uid: null, ref: null }, `${processed} request(s) auto-${mode} after ${delaySeconds}s · ${naira(totalValue)}${mode === 'decline' ? ' refunded' : ''}`)
    await notifyAdmins(`Autopilot ${mode === 'approve' ? 'approved' : 'declined & refunded'} ${processed} withdrawal${processed === 1 ? '' : 's'}`,
      `${naira(totalValue)} total · each request waited ${delaySeconds}s before auto-${mode}${mode === 'decline' ? ' · balances refunded' : ''}.`)
  }
  return { mode, delaySeconds, processed, tooFresh, totalValue, details }
}

/* --------------------------- auto-decline stale ---------------------------
 * Pending fnd/verify/upgrade requests that received no bank alert inside
 * settings/autopilot.windowMinutes get declined (verify deposits are refunded).
 */

async function autoDeclineStale() {
  const config = await getAutopilotConfig()
  const windowMs = config.windowMinutes * 60 * 1000
  const now = Date.now()
  const summary = []
  for (const [kind, meta] of Object.entries(KINDS)) {
    if (!config[kind]) continue
    const stale = await db.collection(meta.collection).where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(20).get()
    for (const doc of stale.docs) {
      const data = doc.data()
      if (now - createdMsOf(data) < windowMs) continue
      const userRef = db.collection('users').doc(data.uid)
      try {
        await db.runTransaction(async tx => {
          const reqSnap = await tx.get(doc.ref)
          if (!reqSnap.exists || reqSnap.data().status !== 'pending') return
          tx.update(doc.ref, { status: 'declined', processedAt: admin.firestore.FieldValue.serverTimestamp(), processedBy: 'autopilot' })
          if (kind === 'verify') {
            const userSnap = await tx.get(userRef)
            if (userSnap.exists) tx.update(userRef, { balance: admin.firestore.FieldValue.increment(Number(data.amount) || 0) })
          }
        })
      } catch (e) { console.error('autoDeclineStale failed:', e.message); continue }
      const detail = `No bank alert within ${config.windowMinutes} minutes`
      await logAction(kind, 'declined', data, detail)
      const title = kind === 'fnd' ? 'FND order declined' : kind === 'verify' ? 'Verification declined' : 'Upgrade declined'
      const body = kind === 'verify'
        ? `Your verification deposit was not confirmed and ${naira(data.amount)} has been refunded. Contact support with your payment reference.`
        : `Your ${meta.label.toLowerCase()} was not confirmed. Contact support with your payment reference if you believe this is a mistake.`
      await userNotif(data.uid, title, body, 'alert')
      await notifyAdmins(`Autopilot declined ${meta.label}`, `${naira(data.amount)} · ${data.ref || data.note || ''} · ${detail}`)
      summary.push(`${kind} ${data.ref || doc.id} declined`)
    }
  }
  return summary
}

/* ------------------------------- handler ---------------------------------- */

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-autopilot-key',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    },
    body: JSON.stringify(obj),
  })
  const params = event.queryStringParameters || {}
  const headers = event.headers || {}
  const key = headers['x-autopilot-key'] || headers['X-Autopilot-Key'] || params.key || ''
  const auth = { hookKeyEnvSet: Boolean(process.env.HOOK_KEY), authMatched: Boolean(process.env.HOOK_KEY && key === process.env.HOOK_KEY) }
  console.log('ENGINE HIT', event.httpMethod, 'sweep=' + (params.sweep || '0'), 'ping=' + (params.ping || '0'), 'authMatched=' + auth.authMatched)

  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true })
  if (!auth.authMatched) return json(401, { ok: false, error: 'unauthorised — HOOK_KEY mismatch', auth })

  try {
    /* ---- self-test: GET ?ping=1 ---- */
    if (params.ping === '1') {
      const config = await getAutopilotConfig()
      const withdraw = await getWithdrawConfig()
      const [pendingFnd, alertsSnap] = await Promise.all([
        db.collection('fndOrders').where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(5).get(),
        db.collection('bankAlerts').orderBy('createdAt', 'desc').limit(5).get(),
      ])
      const diag = {
        ok: true, engine: 'v6.4', now: new Date().toISOString(), auth,
        config, withdrawAutopilot: withdraw,
        pendingFndOrders: pendingFnd.size,
        samplePendingAmounts: pendingFnd.docs.map(d => Number(d.data().amount) || 0),
        sampleNotes: pendingFnd.docs.map(d => String(d.data().ref || d.data().note || '')),
        recentAlerts: alertsSnap.docs.map(d => { const a = d.data(); return { amount: a.amount, name: a.name || '', receiver: a.receiver || '', whenMs: a.whenMs || 0, at: a.createdAt && a.createdAt.toMillis ? new Date(a.createdAt.toMillis()).toISOString() : '' } }),
      }
      if (params.approve) {
        const alert = { amount: Number(params.approve) || 0, name: String(params.name || ''), receiver: String(params.receiver || ''), whenMs: 0 }
        const debug = []
        const match = await approveMatch(alert, { force: true, debug })
        diag.testApprove = { requestedAmount: alert.amount, name: alert.name || null, receiver: alert.receiver || null, result: match, debug }
      }
      return json(200, diag)
    }

    /* ---- scheduled sweep: GET ?sweep=1 (call from your phone app's timer) ---- */
    if (params.sweep === '1') {
      const withdrawals = await sweepWithdrawals()
      const stale = await autoDeclineStale()
      return json(200, { ok: true, engine: 'v6.4', withdrawals, staleDeclined: stale })
    }

    /* ---- force approve (test tool): ?approve=AMOUNT&name=NAME ---- */
    if (params.approve) {
      const alert = { amount: Number(params.approve) || 0, name: String(params.name || ''), receiver: String(params.receiver || ''), whenMs: 0 }
      const debug = []
      const match = await approveMatch(alert, { force: true, debug })
      return json(200, { ok: true, forced: true, match, debug })
    }

    /* ---- bank alert webhook: POST { "sms": "..." } ---- */
    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST { "sms": "..." } or GET ?sweep=1 / ?ping=1' })
    let body = {}
    try { body = JSON.parse(event.body || '{}') } catch (e) { return json(400, { ok: false, error: 'body is not valid JSON — send { "sms": "..." }' }) }
    const sms = String(body.sms || body.text || body.message || '')
    if (!sms.trim()) return json(400, { ok: false, error: 'missing sms' })
    if (!isCreditAlert(sms)) return json(200, { ok: true, ignored: 'not a credit alert' })

    const alert = parseAlert(sms)
    if (!alert.amount) return json(200, { ok: true, ignored: 'no amount found' })

    await db.collection('bankAlerts').add({ ...alert, createdAt: admin.firestore.FieldValue.serverTimestamp() })
    const debug = []
    const match = await approveMatch(alert, { debug })
    return json(200, { ok: true, parsed: { amount: alert.amount, name: alert.name || null, whenMs: alert.whenMs || null }, matched: match, debug })
  } catch (e) {
    console.error('ENGINE ERROR', e)
    return json(500, { ok: false, error: e.message, stack: String(e.stack || '').split('\n')[0] })
  }
}
