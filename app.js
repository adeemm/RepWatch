/* ============================================================
   Loads data/data.json and renders four views: home, find, member, compare.
   Hash-based routing and saves user's reps in localStorage.
   ============================================================ */
'use strict';

/* ---------------- Constants & state ---------------- */

const STORE_KEY = 'repwatch.saved.v1';
const MAIN = document.getElementById('main');
const LOADING = document.getElementById('loading');

let DB = null;
let membersById = new Map();
let votesByMember = new Map();      // memberId -> array of votes
let billsByKey = new Map();         // "hr1234" -> bill
let misconductByMember = new Map(); // memberId -> entries
let issueLabels = new Map();        // issueId -> label
let savedIds = [];

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', GU: 'Guam', VI: 'U.S. Virgin Islands', MP: 'N. Mariana Islands', AS: 'American Samoa',
};
const STATE_ORDER = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','PR','GU','VI','MP','AS'];

/* Vote kinds that involve a real policy decision (shown by default). */
const POLICY_KINDS = new Set(['passage', 'passage-suspension', 'amendment']);
const NON_POLICY_LABEL = 'Nominations & procedure';
const KIND_NOTES = {
  passage: 'A final vote on the bill.',
  'passage-suspension': 'A final vote on the bill (suspension of the rules).',
  amendment: 'A vote on a change (amendment) to a bill.',
  cloture: 'A procedural vote to limit debate in the Senate.',
  nomination: 'A vote on a presidential nomination.',
  recommit: 'A vote to send a bill back to committee.',
  procedural: 'A routine procedural vote. It does not change a law by itself.',
  quorum: 'A roll call to count members present. Not a policy vote.',
  leadership: 'A vote on House leadership. Not a policy vote.',
  treaty: 'A vote on a treaty.',
  conviction: 'An impeachment-related vote.',
  unknown: '',
};

/* ---------------- Utilities ---------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initials(name) {
  const words = String(name || '').split(/\s+/).filter(Boolean);
  const first = words[0] || '?';
  const last = words.length > 1 ? words[words.length - 1] : '';
  return ((first[0] || '') + (last[0] || '')).toUpperCase() || '?';
}

function partyClass(party) {
  const p = String(party || '').toLowerCase();
  if (p.startsWith('republican') || p === 'r') return 'party-R';
  if (p.startsWith('democrat') || p === 'd') return 'party-D';
  return 'party-I';
}

function partyLabel(party) {
  const p = String(party || '');
  if (/republican/i.test(p)) return 'Republican';
  if (/democrat/i.test(p)) return 'Democrat';
  return p || 'Independent';
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : ''));
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function memberTitle(m) {
  const ch = m.chamber === 'senate'
    ? `U.S. Senator · ${STATE_NAMES[m.state] || m.state}`
    : `U.S. Representative · ${STATE_NAMES[m.state] || m.state}, District ${m.district}`;
  return ch;
}

function billKey(vote) {
  return vote.bill ? vote.bill.type + vote.bill.number : null;
}

/* congress.gov URL pattern per bill type used as a fallback link when
   the bill's status record (which normally carries the URL) is missing. */
const BILL_TYPE_SLUGS = {
  hr: 'house-bill', s: 'senate-bill',
  hres: 'house-resolution', sres: 'senate-resolution',
  hjres: 'house-joint-resolution', sjres: 'senate-joint-resolution',
  hconres: 'house-concurrent-resolution', sconres: 'senate-concurrent-resolution',
};

function congressBillURL(bill) {
  const slug = BILL_TYPE_SLUGS[bill.type];
  const congress = (DB && DB.meta && DB.meta.congress) || 0;
  if (!slug || !congress) return null;
  return `https://www.congress.gov/bill/${congress}th-congress/${slug}/${bill.number}`;
}

/* A bare "On Passage" question names no measure (it occurs on House roll
   calls for joint resolutions). Title falls back to the Clerk's description instead. */
function barePassageQuestion(v) {
  return /^\s*on passage\s*:?\s*$/i.test((v.question || '').trim());
}

function isSaved(id) { 
  return savedIds.includes(id);
}

function toggleSaved(id) {
  savedIds = isSaved(id) ? savedIds.filter((x) => x !== id) : [...savedIds, id];
  try { 
    localStorage.setItem(STORE_KEY, JSON.stringify(savedIds));
  }
  catch (e) { }
  route(); // re-render current view
}

function loadSaved() {
  try { 
    savedIds = JSON.parse(localStorage.getItem(STORE_KEY)) || [];
  }
  catch (e) { 
    savedIds = [];
  }
  savedIds = savedIds.filter((id) => membersById.has(id));
}

/* ---------------- Data loading & indexes ---------------- */

async function loadData() {
  try {
    const res = await fetch('data/data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('no data.json');
    DB = await res.json();
  }
  catch (e) {
    /* const res = await fetch('data/sample.json');
    if (!res.ok) throw new Error('No data file found.');
    DB = await res.json();
    isSample = true; */
    throw new Error('No data file found.');
  }
  DB.votes = DB.votes || [];
  DB.members = DB.members || [];
  DB.bills = DB.bills || {};
  DB.misconduct = DB.misconduct || [];

  for (const m of DB.members) membersById.set(m.id, m);
  for (const v of DB.votes) {
    for (const id of v.yea || []) (votesByMember.get(id) || votesByMember.set(id, []).get(id)).push(v);
    for (const id of v.nay || []) (votesByMember.get(id) || votesByMember.set(id, []).get(id)).push(v);
  }
  for (const v of DB.votes) {
    for (const list of [v.yea, v.nay]) {
      for (const id of list || []) {
        if (!membersById.has(id)) {
          membersById.set(id, { id, name: id, chamber: v.chamber, state: '??', party: 'Unknown' });
        }
      }
    }
  }
  for (const [k, b] of Object.entries(DB.bills)) billsByKey.set(k, b);
  for (const e of DB.misconduct) {
    if (!misconductByMember.has(e.member_id)) misconductByMember.set(e.member_id, []);
    misconductByMember.get(e.member_id).push(e);
  }
  for (const [id, label] of Object.entries(DB.issues || {})) issueLabels.set(id, label);
  loadSaved();

  const el = document.getElementById('data-date');
  if (el && DB.meta) {
    const firstYear = 1989 + 2 * ((DB.meta.congress || 119) - 101);
    el.textContent = `Voting data covers the ${DB.meta.congress}th Congress (${firstYear}-${firstYear + 2}) and was last updated ${formatDate(DB.meta.generated)}.`;
  }
}

/* ---------------- Per-member vote stats ---------------- */

function memberStats(id) {
  const votes = votesByMember.get(id) || [];
  const byIssue = new Map(); // issue -> {for, against, none} (policy votes only)
  let forC = 0, againstC = 0, noneC = 0, nonPolicyC = 0;
  for (const v of votes) {
    const isPolicy = POLICY_KINDS.has(v.kind || 'unknown');
    const issue = isPolicy ? voteIssue(v) : NON_POLICY_LABEL;
    let row = byIssue.get(issue);
    if (!row) { row = { for: 0, against: 0, none: 0, total: 0 }; byIssue.set(issue, row); }
    row.total++;
    if (!isPolicy) nonPolicyC++;
    if ((v.yea || []).includes(id)) { row.for++; forC++; }
    else if ((v.nay || []).includes(id)) { row.against++; againstC++; }
    else { row.none++; noneC++; }
  }
  return { votes, byIssue, for: forC, against: againstC, none: noneC,
           total: votes.length, nonPolicy: nonPolicyC };
}

/* Which issue does a vote belong to? (from its bill, else from keywords) */
function voteIssue(v) {
  const b = DB.bills && DB.bills[billKey(v)];
  if (b && b.issue) return b.issue;
  return 'Other';
}

function voteFor(id, v) {
  if ((v.yea || []).includes(id)) return 'for';
  if ((v.nay || []).includes(id)) return 'against';
  return 'none';
}

function voteTitle(v) {
  const key = billKey(v);
  const b = key ? (DB.bills || {})[key] : null;
  const q = (v.question || '').trim();
  let base = (b && b.title) ? b.title
    : (!barePassageQuestion(v) && q) ? q
    : (v.desc || 'Roll call vote');
  if (v.amendment) base = `Amendment: ${base}`;
  return base;
}

/* Kinds where the raw Senate question wording is worth showing. */
const QUESTION_KINDS = new Set(['nomination', 'treaty', 'conviction', 'recommit']);

/* Label for a vote on a motion (table, previous question, recommit, cloture, discharge, etc.)
   Returns null for final passage votes and amendments (already labelled by the bill title / "Amendment:"). */
const MOTION_LABELS = [
  [/motion to table/i, 'Motion to table'],
  [/previous question/i, 'Previous question'],
  [/motion to recommit/i, 'Motion to recommit'],
  [/cloture/i, 'Motion to invoke cloture'],
  [/motion to discharge/i, 'Motion to discharge the committee'],
  [/motion to proceed/i, 'Motion to proceed to the measure'],
  [/motion to refer/i, 'Motion to refer to committee'],
  [/motion to commit/i, 'Motion to commit to committee'],
  [/motion to concur/i, 'Motion to concur with the other chamber'],
  [/motion to instruct/i, 'Motion to instruct conferees'],
  [/motion to reconsider/i, 'Motion to reconsider'],
  [/motion to recess/i, 'Motion to recess'],
  [/motion to adjourn/i, 'Motion to adjourn'],
  [/motion to waive/i, 'Motion to waive a rule'],
  [/point of order/i, 'Point of order'],
  [/decision of the chair/i, 'Decision of the Chair'],
  [/consideration of the (resolution|bill|measure)/i, 'Consideration of the measure'],
  [/retaining division/i, 'Motion on dividing the measure'],
];

function motionLabel(v) {
  const kind = v.kind || 'unknown';
  if (kind === 'passage' || kind === 'passage-suspension' || kind === 'amendment') return null;
  const key = billKey(v);
  if (!key) return null; // no bill: the question wording is already the title
  const q = (v.question || '').trim();
  if (!q) return null;
  // A few final-passage votes are tagged "procedural" (e.g. "Passage,
  // Objections of the President … Notwithstanding") - those are on the measure.
  if (/^passage/i.test(q)) return null;
  for (const [re, label] of MOTION_LABELS) if (re.test(q)) return label;
  const cleaned = q.replace(/^on (the )?/i, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > 48 ? cleaned.slice(0, 48).trimEnd() + '…' : cleaned;
}

function voteDescription(v) {
  const key = billKey(v);
  const b = key ? (DB.bills || {})[key] : null;
  const kind = v.kind || 'unknown';
  if (v.amendment) {
    let s = '';
    const author = v.amendment.author || '';
    // House "author" strings look like "Trahan of Massachusetts Amendment No. 3"
    const sponsor = author.match(/^(.+) Amendment No\. \d+$/i);
    if (sponsor) s = `This was a proposed change (amendment) offered by ${sponsor[1].replace(/\s+Part [AB]$/, '')}`;
    else if (author) s = `This was a proposed change (amendment): ${author}`;
    else s = 'This was an amendment (a proposed change) to a bill.';
    if (b) {
      if (b.title && b.summary) s += ` It was offered on the bill “${b.title}”. ${b.summary}`;
      else if (b.title) s += ` It was offered on the bill “${b.title}.”`;
    }
    return s;
  }
  if (b && b.summary) return b.summary;
  if (b && b.title) return KIND_NOTES[kind] || '';
  if (barePassageQuestion(v) && v.desc) return v.desc;
  if (KIND_NOTES[kind]) return KIND_NOTES[kind];
  return '';
}

/* ---------------- Shared UI pieces ---------------- */

function memberCardHTML(m, actions) {
  const notServing = m.serving === false ? ` <span class="note">(no longer serving - left office ${m.left || 'mid-Congress'})</span>` : '';
  return `<div class="member-card">
    <div class="avatar" aria-hidden="true">${esc(initials(m.name))}</div>
    <div class="who">
      <div class="name">${esc(m.name)}<span class="party-tag ${partyClass(m.party)}">${esc(partyLabel(m.party))}</span></div>
      <div class="desc">${esc(memberTitle(m))}${notServing}</div>
    </div>
    ${actions}
  </div>`;
}

function badgeHTML(state) {
  const map = {
    for: ['for', '✓', 'Voted FOR'],
    against: ['against', '✗', 'Voted AGAINST'],
    none: ['none', '–', 'No vote recorded'],
  };
  const [cls, glyph, label] = map[state];
  return `<span class="badge ${cls}"><span class="glyph" aria-hidden="true">${glyph}</span>${label}</span>`;
}

function tallyText(v) {
  const y = (v.yea || []).length, n = (v.nay || []).length;
  const chamber = v.chamber === 'senate' ? 'Senate' : 'House';
  return `${chamber} vote: ${y} for · ${n} against · result: ${v.result || '—'}`;
}

function voteArticleHTML(memberId, v) {
  const state = voteFor(memberId, v);
  const desc = voteDescription(v);
  const key = billKey(v);
  const bill = key ? (DB.bills || {})[key] : null;
  const url = (bill && bill.url) || (v.bill ? congressBillURL(v.bill) : null);
  const link = url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">(open on Congress.gov)</a>` : '';
  const title = voteTitle(v);
  const motion = motionLabel(v);
  const showQuestion = !!v.question && v.question !== title &&
    (motion !== null || QUESTION_KINDS.has(v.kind || 'unknown'));
  return `<article class="vote ${state}">
    <div class="vote-head">
      <span class="date">${esc(formatDate(v.date))}</span>
      <span class="title">${motion ? `<span class="motion-tag">${esc(motion)}</span>` : ''}${esc(title)}</span>
    </div>
    ${showQuestion ? `<p class="what note">${esc(v.question)}</p>` : ''}
    <p class="vote-line">${badgeHTML(state)} <span class="note" style="display:inline-block">${esc(tallyText(v))}${link}</span></p>
    ${desc ? `<div class="what">${desc.length > 260
      ? `<p class="vote-summary" style="display:none">${esc(desc)}</p>
         <p class="vote-truncated">${esc(desc.slice(0, 260))}…</p>
         <button class="vote-toggle" aria-expanded="false">Read the full description</button>`
      : `<p>${esc(desc)}</p>`}</div>` : ''}
  </article>`;
}

/* ---------------- Grouping votes on the same bill ----------------
   When a member has more than one vote on the same bill (amendments,
   procedural votes, and the final passage), only the "main" vote is shown
   in the list; the earlier ones are tucked into a collapsible group so a
   long history (e.g. a bill debated for months) does not fill the screen. */

/* Final votes on the bill matter most, then a recommitment, then recency. */
const MAIN_VOTE_RANK = { passage: 3, 'passage-suspension': 3, recommit: 2 };

function pickMainVote(list) {
  return list.slice().sort((a, b) => {
    const r = (MAIN_VOTE_RANK[b.kind || 'unknown'] || 1) - (MAIN_VOTE_RANK[a.kind || 'unknown'] || 1);
    if (r) return r;
    if (a.date !== b.date) return a.date < b.date ? 1 : -1; // later date first
    return (b.number || 0) - (a.number || 0);
  })[0];
}

function buildBillGroups(votes) {
  const byBill = new Map();
  for (const v of votes) {
    const key = billKey(v);
    if (!key) continue; // no bill (quorum calls, nominations) - never grouped
    if (!byBill.has(key)) byBill.set(key, []);
    byBill.get(key).push(v);
  }
  const mainOf = new Map(); // main vote id -> { main, rest }
  const hidden = new Set(); // vote ids that live inside a collapsible group
  for (const list of byBill.values()) {
    if (list.length < 2) continue;
    const main = pickMainVote(list);
    const rest = list.filter((v) => v !== main)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    mainOf.set(main.id, { main, rest });
    for (const v of rest) hidden.add(v.id);
  }
  return { mainOf, hidden };
}

/* Collapsible list of a bill's earlier votes, shown under its main vote. */
function voteGroupHTML(group, memberId, idx) {
  const rest = group.rest;
  const am = rest.filter((v) => v.amendment || v.kind === 'amendment').length;
  const pr = rest.length - am;
  let detail;
  if (am > 0 && pr > 0) detail = `${am} amendment${am === 1 ? '' : 's'} · ${pr} procedural vote${pr === 1 ? '' : 's'}`;
  else if (am > 0) detail = 'all amendments';
  else detail = 'procedural votes';
  const bodyId = `vg-body-${idx}`;
  return `<div class="vote-group">
    <button type="button" class="vote-group-toggle" aria-expanded="false" aria-controls="${bodyId}">
      <span class="vg-caret" aria-hidden="true">▸</span>
      <span>${rest.length} earlier vote${rest.length === 1 ? '' : 's'} on this bill (${detail})</span>
    </button>
    <div class="vote-group-body" id="${bodyId}" hidden>${rest.map((v) => voteArticleHTML(memberId, v)).join('')}</div>
  </div>`;
}

/* ---------------- View: Home ---------------- */

function viewHome() {
  document.title = 'RepWatch - My Representatives';
  const saved = savedIds.map((id) => membersById.get(id)).filter(Boolean);

  let html = `<h1>My Representatives</h1><p class="section-hint">
    These are the representatives you have saved. Open one of them to see how they have voted on each issue, in plain language.</p>`;

  if (saved.length === 0) {
    html += `<div class="empty-state">
      <div class="big-glyph" aria-hidden="true">🗳️</div>
      <h2 style="margin-top:0">You haven't saved any representatives yet</h2>
      <p>Find your senator and your representative in the next step, and tap "Save" on each one.</p>
      <a class="btn big" href="#/find">Find my representatives</a>
    </div>`;
  } else {
    for (const m of saved) {
      html += memberCardHTML(m, `
        <div class="member-actions">
          <a class="btn" href="#/member/${encodeURIComponent(m.id)}">View voting record</a>
          <button class="btn secondary" data-remove="${esc(m.id)}">Remove</button>
        </div>`);
    }
    html += `<p style="margin-top:1.4rem"><a class="btn secondary" href="#/find">Add another representative</a>
      <a class="btn" href="#/compare">Compare your representatives</a></p>`;
  }

  MAIN.innerHTML = html;
  MAIN.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      toggleSaved(btn.getAttribute('data-remove'));
    });
  });
}

/* ---------------- View: Find a representative ---------------- */

const findState = { state: '', q: '' };

function viewFind() {
  document.title = 'RepWatch - Find a Representative';
  const members = [...membersById.values()].filter((m) => m.state && m.state !== '??');
  const states = STATE_ORDER.filter((s) => members.some((m) => m.state === s));

  let html = `<h1>Find a Representative</h1>
    <div class="card">
      <label class="field-label" for="state-select">Your state</label>
      <select id="state-select">
        <option value="">- Pick your state -</option>
        ${states.map((s) => `<option value="${s}">${STATE_NAMES[s] || s}</option>`).join('')}
      </select>
      <label class="field-label" for="name-search">Or search by name</label>
      <input type="search" id="name-search" placeholder="Type a name...">
      <p class="note" style="margin-bottom:0">Tap <strong>Save</strong> on the people you want to follow. You can always change your choices later.</p>
    </div>
    <div id="find-results"></div>`;

  MAIN.innerHTML = html;

  const results = document.getElementById('find-results');
  const stateSel = document.getElementById('state-select');
  const nameSearch = document.getElementById('name-search');
  stateSel.value = findState.state || '';
  nameSearch.value = findState.q || '';

  function render() {
    const st = stateSel.value;
    const q = nameSearch.value.trim().toLowerCase();
    findState.state = st;
    findState.q = nameSearch.value.trim();
    let list = [];
    if (q) {
      list = members.filter((m) => m.name.toLowerCase().includes(q));
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    else if (st) {
      list = members.filter((m) => m.state === st);
      list.sort((a, b) => (a.name.localeCompare(b.name)));
    }
    if (!st && !q) {
      results.innerHTML = `<p class="section-hint">Pick your state above to see your U.S. Senators and Representatives.</p>`;
      return;
    }
    if (list.length === 0) {
      results.innerHTML = `<div class="empty-state"><p><strong>No match.</strong> Check the spelling, or pick your state from the list.</p></div>`;
      return;
    }
    const heading = q
      ? `Results for “${esc(q)}”`
      : `Your representatives in ${STATE_NAMES[st] || st}`;
    results.innerHTML = `<h2>${heading}</h2>` + list.map((m) => {
      const actions = isSaved(m.id)
        ? `<button class="btn secondary" data-unsave="${esc(m.id)}">✓ Saved - tap to remove</button>`
        : `<button class="btn" data-save="${esc(m.id)}">Save</button>`;
      return memberCardHTML(m, `<div class="member-actions">${actions}
        <a class="btn secondary" href="#/member/${encodeURIComponent(m.id)}">View voting record</a></div>`);
    }).join('') +
      `<p style="margin-top:1rem"><a class="back-link" href="#/home">← Back to my representatives</a></p>`;

    results.querySelectorAll('[data-save]').forEach((btn) =>
      btn.addEventListener('click', () => toggleSaved(btn.getAttribute('data-save'))));
    results.querySelectorAll('[data-unsave]').forEach((btn) =>
      btn.addEventListener('click', () => toggleSaved(btn.getAttribute('data-unsave'))));
  }

  stateSel.addEventListener('change', render);
  nameSearch.addEventListener('input', render);
  render();
}

/* ---------------- View: Member detail ---------------- */

let memberFilterIssue = null;
let memberShowAll = false;
let lastMemberId = null;

function viewMember(id) {
  const m = membersById.get(id);
  if (!m) { viewHome(); return; }
  document.title = `RepWatch - ${m.name}`;
  if (id !== lastMemberId) {
    memberFilterIssue = null;
    memberShowAll = false;
  }
  lastMemberId = id;

  const stats = memberStats(id);
  const misconduct = misconductByMember.get(id) || [];

  let html = `<a class="back-link" href="#/home">← Back to my representatives</a>
    <div class="card" style="display:flex;flex-wrap:wrap;align-items:center;gap:1rem">
      <div class="avatar" style="width:76px;height:76px;font-size:1.8rem" aria-hidden="true">${esc(initials(m.name))}</div>
      <div style="flex:1 1 auto">
        <h1 style="margin:0">${esc(m.name)}
          <span class="party-tag ${partyClass(m.party)}">${esc(partyLabel(m.party))}</span></h1>
        <p class="note" style="margin:0.2rem 0 0">${esc(memberTitle(m))}
          ${m.serving === false ? ` · no longer serving (left office ${m.left || 'mid-Congress'})` : ''}</p>
      </div>
      <div>${isSaved(id)
        ? `<button class="btn secondary" id="member-toggle">✓ Saved - tap to remove</button>`
        : `<button class="btn" id="member-toggle">Save ${esc((m.name || '').split(' ').pop())} to my list</button>`}</div>
    </div>`;

  /* --- Conduct / ethics records --- */
  html += `<h2>Conduct &amp; ethics records</h2>`;
  if (misconduct.length === 0) {
    html += `<div class="card"><p>The public misconduct database (<a href="https://www.govtrack.us/misconduct" target="_blank">maintained by GovTrack.us</a>)
      has <strong>no entries</strong> for ${esc((m.name || '').split(' ').pop())} for this Congress.
      <br>
      <span class="note">The database tracks formal allegations, investigations, censures, and related events.</span></p></div>`;
  }
  else {
    html += `<p class="section-hint">These are public records of <strong>allegations and investigations</strong> from the GovTrack.us misconduct database.
      An investigation or allegation does not prove wrongdoing, and a case may end with no finding of guilt.</p>`;
    for (const e of misconduct) {
      const tags = (e.tags || []).map((t) =>
        `<span class="tag${t === 'unresolved' ? ' unresolved' : ''}">${esc(t)}</span>`).join('');
      const cons = (e.consequences || []).map((c) => `<span class="tag">${esc(c)}</span>`).join(' ');
      html += `<div class="card conduct-entry">
        <p class="c-date">${esc(formatDate(e.first_date) + (e.last_date && e.last_date !== e.first_date ? ` - ${formatDate(e.last_date)}` : ''))}</p>
        <p class="c-allegation">${esc(e.allegation || 'Misconduct allegation')}</p>
        ${e.text ? `<p>${esc(e.text)}</p>` : ''}
        ${(tags || cons) ? `<div class="tags">${tags}${cons}</div>` : ''}
      </div>`;
    }
  }

  /* --- Voting record by issue --- */
  html += `<h2>How ${esc((m.name || '').split(' ').pop())} has voted</h2>`;
  if (stats.total === 0) {
    html += `<div class="empty-state"><p>No roll call votes are recorded for this person yet.</p></div>`;
  } else {
    const issueRows = [...stats.byIssue.entries()]
      .filter(([issue]) => issue !== NON_POLICY_LABEL)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([issue, r]) => {
        const forPct = Math.round(100 * r.for / Math.max(1, r.for + r.against));
        return `<button class="issue-row" data-issue="${esc(issue)}" aria-pressed="false">
          <span class="issue-name">${esc(issueLabels.get(issue) || issue)}</span>
          <span class="bar" aria-hidden="true">
            <span class="b-for" style="width:${forPct}%"></span>
            <span class="b-against" style="width:${100 - forPct}%"></span>
          </span>
          <span class="issue-counts">${r.for} for · ${r.against} against${r.none ? ` · ${r.none} no vote` : ''}</span>
        </button>`;
      }).join('');
    const np = stats.byIssue.get(NON_POLICY_LABEL);
    const nonPolicyRow = np ? `<button class="issue-row" data-issue="${esc(NON_POLICY_LABEL)}" aria-pressed="false">
        <span class="issue-name">${esc(NON_POLICY_LABEL)}</span>
        <span class="issue-counts">${np.total} votes (not about a bill)</span>
      </button>` : '';

    html += `<div class="card">
      <p style="margin-top:0">Choose an issue to see the votes, or show all of them.
        <br>
        <span class="note">Green means voted FOR. Red means voted AGAINST. Gray means no vote was recorded (for example, they were not yet in office).</span>
      </p>
      <button class="issue-row" id="issue-all" aria-pressed="true">
        <span class="issue-name">Show all votes (${stats.total})</span>
      </button>
      ${issueRows}${nonPolicyRow}
    </div>
    <p class="section-hint" style="margin-top:1.2rem">
      <strong>Overall this Congress:</strong> ${stats.for} FOR · ${stats.against} AGAINST · ${stats.none} with no recorded vote (out of ${stats.total} roll call votes).
    </p>
    <div id="vote-list" aria-live="polite"></div>`;
  }

  MAIN.innerHTML = html;

  const tog = document.getElementById('member-toggle');
  if (tog) tog.addEventListener('click', () => toggleSaved(id));

  const voteList = document.getElementById('vote-list');
  function renderVotes() {
    if (!voteList) return;
    let votes = stats.votes.slice();
    if (!memberShowAll && memberFilterIssue) {
      votes = memberFilterIssue === NON_POLICY_LABEL
        ? votes.filter((v) => !POLICY_KINDS.has(v.kind || 'unknown'))
        : votes.filter((v) => POLICY_KINDS.has(v.kind || 'unknown') && voteIssue(v) === memberFilterIssue);
    }
    votes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (votes.length === 0) {
      voteList.innerHTML = `<div class="empty-state"><p>No votes for this selection.</p></div>`;
      return;
    }
    const shown = memberShowAll ? '' : ` (issue: ${esc(memberFilterIssue)})`;
    const { mainOf, hidden } = buildBillGroups(votes);
    let out = `<p class="section-hint">${votes.length} vote${votes.length === 1 ? '' : 's'}${shown} - newest first</p>`;
    let groupIdx = 0;
    for (const v of votes) {
      if (hidden.has(v.id)) continue; // this vote is inside a collapsible group
      out += voteArticleHTML(id, v);
      const group = mainOf.get(v.id);
      if (group) out += voteGroupHTML(group, id, groupIdx++);
    }
    voteList.innerHTML = out;
    voteList.querySelectorAll('.vote-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        const fullText = btn.parentElement.querySelector('.vote-summary');
        const truncated = btn.previousElementSibling;
        if (fullText) fullText.style.display = expanded ? 'none' : '';
        if (truncated && truncated.classList.contains('vote-truncated')) {
          truncated.style.display = expanded ? '' : 'none';
        }
        btn.textContent = expanded ? 'Read the full description' : 'Show less';
      });
    });
    voteList.querySelectorAll('.vote-group-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        const body = document.getElementById(btn.getAttribute('aria-controls'));
        if (body) body.hidden = expanded;
      });
    });
  }
  renderVotes();

  const allBtn = document.getElementById('issue-all');
  function setIssue(issue) {
    memberShowAll = !issue;
    memberFilterIssue = issue || null;
    if (allBtn) allBtn.setAttribute('aria-pressed', String(!issue));
    MAIN.querySelectorAll('.issue-row[data-issue]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.getAttribute('data-issue') === issue)));
    renderVotes();
    voteList.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (allBtn) allBtn.addEventListener('click', () => setIssue(null));
  MAIN.querySelectorAll('.issue-row[data-issue]').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = b.getAttribute('data-issue');
      setIssue(memberFilterIssue === issue && !memberShowAll ? null : issue);
    });
  });
}

/* ---------------- View: Compare ---------------- */

function viewCompare() {
  document.title = 'RepWatch - Compare';
  const saved = savedIds.map((id) => membersById.get(id)).filter(Boolean);
  let html = `<h1>Compare Representatives</h1>`;
  if (saved.length < 2) {
    html += `<div class="empty-state">
      <p>To compare, save at least two representatives on the <a href="#/home">My Representatives</a> page.</p>
      <a class="btn" href="#/find">Find a representative</a></div>`;
    MAIN.innerHTML = html;
    return;
  }
  const issues = [...issueLabels.keys()].filter((i) => i !== 'Other').sort();
  const initial = saved.slice(0, 3).map((m) => m.id);

  html += `<div class="card">
    <p style="margin-top:0"><strong>Choose up to three people:</strong> tap a name to include or remove them.</p>
    <div id="cmp-people" style="display:flex;flex-wrap:wrap;gap:0.5rem"></div>
    <label class="field-label" for="cmp-issue">Which issue should we compare?</label>
    <select id="cmp-issue">
      ${issues.map((i) => `<option value="${esc(i)}">${esc(issueLabels.get(i) || i)}</option>`).join('')}
    </select>
    <p class="note" style="margin-bottom:0">Each row is a single vote.
      <span class="dot for">For</span> means the member voted for the bill or amendment.
      <span class="dot against">Against</span> means against.
      <span class="dot none">–</span> means no recorded vote. Remember, members only vote in their own chamber</p>
  </div>
  <div id="cmp-results"></div>`;

  MAIN.innerHTML = html;

  const chipsWrap = document.getElementById('cmp-people');
  let chosen = initial.slice();
  function renderChips() {
    chipsWrap.innerHTML = saved.map((m) => {
      const on = chosen.includes(m.id);
      return `<button class="chip" aria-pressed="${on}" data-cmp="${esc(m.id)}">
        ${esc(m.name)} · ${esc(STATE_NAMES[m.state] || m.state)}</button>`;
    }).join('');
    chipsWrap.querySelectorAll('[data-cmp]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-cmp');
        if (chosen.includes(id)) chosen = chosen.filter((x) => x !== id);
        else if (chosen.length < 3) chosen.push(id);
        renderChips();
        renderTable();
      });
    });
  }

  const results = document.getElementById('cmp-results');
  const issueSel = document.getElementById('cmp-issue');
  function renderTable() {
    if (chosen.length < 2) {
      results.innerHTML = `<p class="section-hint">Choose at least two people to compare.</p>`;
      return;
    }
    const issue = issueSel.value;
    const people = chosen.map((id) => membersById.get(id)).filter(Boolean);
    const votes = (DB.votes || [])
      .filter((v) => POLICY_KINDS.has(v.kind || 'unknown'))
      .filter((v) => voteIssue(v) === issue)
      // only show votes where at least one chosen person was in the right chamber
      .filter((v) => people.some((p) => (v.yea || []).includes(p.id) || (v.nay || []).includes(p.id)))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 40);

    if (votes.length === 0) {
      results.innerHTML = `<div class="empty-state"><p>No ${esc(issue)} votes were recorded for the people you chose
        (for example, if you chose only senators, only Senate votes are shown).</p></div>`;
      return;
    }

    let rows = '';
    const totals = people.map(() => ({ for: 0, against: 0, none: 0 }));
    for (const v of votes) {
      rows += `<tr><td class="bill-cell">
        <span class="bill-title">${esc(voteTitle(v))}</span><br>
        <span class="bill-date">${esc(formatDate(v.date))}${v.amendment ? ' · amendment' : ''}</span>
      </td>`;
      people.forEach((m, i) => {
        const st = voteFor(m.id, v);
        totals[i][st === 'for' ? 'for' : st === 'against' ? 'against' : 'none']++;
        rows += `<td><span class="dot ${st}">${st === 'for' ? 'For' : st === 'against' ? 'Against' : '–'}</span></td>`;
      });
      rows += '</tr>';
    }
    const head = `<tr><th style="min-width:16rem">Bill or amendment</th>${people.map((m) =>
      `<th><span class="rep-name">${esc(m.name)}</span><br><span style="font-weight:400;font-size:0.95rem">${esc(STATE_NAMES[m.state] || m.state)}${m.chamber === 'senate' ? ' · Senate' : ' · District ' + m.district}</span></th>`).join('')}</tr>`;
    const totalRow = `<tr class="total-row"><td class="bill-cell">Total (${votes.length} votes shown)</td>${totals.map((t) =>
      `<td>${t.for} for · ${t.against} against</td>`).join('')}</tr>`;

    results.innerHTML = `<h2>${esc(issueLabels.get(issue) || issue)} - ${votes.length} most recent votes</h2>
      <div class="compare-wrap"><table class="compare">${head}${rows}${totalRow}</table></div>`;
  }

  issueSel.addEventListener('change', renderTable);
  renderChips();
  renderTable();
}

/* ---------------- Routing & boot ---------------- */

function route() {
  setNav();
  const hash = location.hash || '#/home';
  const parts = hash.replace(/^#\//, '').split('/');
  try {
    if (parts[0] === 'find') viewFind();
    else if (parts[0] === 'compare') viewCompare();
    else if (parts[0] === 'member' && parts[1]) viewMember(decodeURIComponent(parts[1]));
    else viewHome();
  } catch (e) {
    MAIN.innerHTML = `<div class="banner"><strong>Something went wrong.</strong> ${esc(e.message)}</div>`;
  }
  MAIN.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function setNav() {
  const hash = location.hash || '#/home';
  const section = hash.replace(/^#\//, '').split('/')[0];
  const map = { find: 'find', compare: 'compare', home: 'home', member: 'home', '': 'home' };
  const active = map[section] || 'home';
  document.querySelectorAll('.main-nav button').forEach((b) => {
    b.setAttribute('aria-current', String(b.getAttribute('data-nav') === active));
  });
}

function showLoading(text) {
  if (text) document.getElementById('loading-text').textContent = text;
  LOADING.hidden = false;
  MAIN.innerHTML = '';
}
function hideLoading() { LOADING.hidden = true; }

async function boot() {
  showLoading('Loading voting records...');
  try {
    await loadData();
  } catch (e) {
    LOADING.hidden = true;
    MAIN.innerHTML = `<div class="banner"><strong>Could not load data.</strong>
      <p>The app needs its data file (<code>data/data.json</code>). See the README for how to generate it.</p></div>`;
    return;
  }
  hideLoading();
  window.addEventListener('hashchange', route);
  document.querySelectorAll('.main-nav button').forEach((b) => {
    b.addEventListener('click', () => { location.hash = '#/' + b.getAttribute('data-nav'); });
  });
  document.getElementById('brand-home').addEventListener('click', () => { location.hash = '#/home'; });
  document.getElementById('brand-home').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = '#/home'; }
  });
  route();
}

document.addEventListener('DOMContentLoaded', boot);
