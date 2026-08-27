// Hämtar färjetider från Trafikverkets öppna API och skriver data.json.
// Loggar även avvikelser (Deleted, DeviationId, okända Info-texter) till log/deviations.jsonl.
// Nyckeln kommer från miljövariabeln TRV_KEY (GitHub Secret) och hamnar aldrig i repot.

const { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } = require('node:fs');

const KEY = process.env.TRV_KEY;
if (!KEY) { console.error('TRV_KEY saknas'); process.exit(1); }

const DAYS = 14;
const ROUTES = { hono: 28, bjorko: 23, nordo: 33 };
const API = 'https://api.trafikinfo.trafikverket.se/v2/data.json';

const z = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;

async function query(routeId, from, to) {
  const body = `<REQUEST><LOGIN authenticationkey="${KEY}"/>` +
    `<QUERY objecttype="FerryAnnouncement" schemaversion="1.2" limit="20000" orderby="DepartureTime">` +
    `<FILTER><EQ name="Route.Id" value="${routeId}"/>` +
    `<GTE name="DepartureTime" value="${from}T00:00:00"/>` +
    `<LT name="DepartureTime" value="${to}T00:00:00"/></FILTER>` +
    `<INCLUDE>DepartureTime</INCLUDE><INCLUDE>FromHarbor.Name</INCLUDE>` +
    `<INCLUDE>ToHarbor.Name</INCLUDE><INCLUDE>Deleted</INCLUDE><INCLUDE>Info</INCLUDE>` +
    `<INCLUDE>DeviationId</INCLUDE><INCLUDE>Id</INCLUDE></QUERY></REQUEST>`;
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body });
  if (!r.ok) throw new Error(`HTTP ${r.status} för led ${routeId}`);
  const j = await r.json();
  return j.RESPONSE?.RESULT?.[0]?.FerryAnnouncement || [];
}

const harb = n => {
  n = (n || '').toLowerCase();
  if (n.includes('varholmen')) return 'V';
  if (n.includes('hönö')) return 'O';
  if (n.includes('björkö') || n.includes('grönevik')) return 'J';
  if (n.includes('burö')) return 'B';
  if (n.includes('knippla')) return 'K';
  if (n.includes('hyppeln')) return 'H';
  if (n.includes('rörö')) return 'R';
  return '?';
};

// Kända Info-texter. Okända loggas för framtida analys.
const KNOWN = [
  [/^färja\s*\d/i, 'ferry'], [/kallelsetur/i, 'X'],
  [/halva färjans lastkapacitet|plats reserveras/i, 'K'],
  [/godstur/i, 'C'], [/kort bytestid/i, 'L'], [/går om passagerare/i, 'Z'],
  [/i mån av plats/i, 'plats'], [/lastas ej/i, 'ej'],
  [/kör så nära framförvarande/i, 'generic'],
];

async function main(){
const today = new Date();
const end = new Date(today); end.setDate(end.getDate() + DAYS);
const unknownInfo = new Set();
const deviations = [];
const days = {};
const rawLegs = {};

for (const [name, id] of Object.entries(ROUTES)) {
  const rows = await query(id, iso(today), iso(end));
  console.log(`${name} (led ${id}): ${rows.length} avgångar`);
  for (const a of rows) {
    const day = a.DepartureTime.slice(0, 10);
    const hhmm = a.DepartureTime.slice(11, 16);
    const info = (a.Info || []);
    const txt = info.join(' ').toLowerCase();
    const kall = /kallelsetur/.test(txt);

    for (const t of info) if (!KNOWN.some(([re]) => re.test(t))) unknownInfo.add(t.trim());
    if (a.Deleted || a.DeviationId) {
      deviations.push({ seen: new Date().toISOString(), route: name, id: a.Id,
        departure: a.DepartureTime, deleted: !!a.Deleted, deviationId: a.DeviationId || null,
        from: a.FromHarbor?.Name, to: a.ToHarbor?.Name, info });
    }
    if (a.Deleted) continue;

    days[day] = days[day] || {};
    const d = (days[day][name] = days[day][name] || {});
    const c = harb(a.FromHarbor?.Name);
    (d[c] = d[c] || []).push(hhmm);
    if (kall) (d[c + 'X'] = d[c + 'X'] || []).push(hhmm);

    if (name === 'nordo') {
      const ferry = (info.find(t => /^färja\s*\d/i.test(t)) || '').replace(/\D/g, '') || '?';
      const codes = [];
      if (kall) codes.push('X');
      if (/halva färjans lastkapacitet|plats reserveras/i.test(txt)) codes.push('K');
      if (/godstur/i.test(txt)) codes.push('C');
      if (/kort bytestid/i.test(txt)) codes.push('L');
      if (/går om passagerare/i.test(txt)) codes.push('Z');
      if (/fordon från rörö lastas i mån/i.test(txt)) codes.push('H');
      if (/fordon till rörö lastas i mån/i.test(txt)) codes.push('R');
      if (/fordon (till|från) hyppeln lastas i mån/i.test(txt)) codes.push('H');
      if (/källo-knippla lastas i mån|källö-knippla lastas i mån/i.test(txt)) codes.push('A');
      if (/källö-knippla lastas ej/i.test(txt)) codes.push('G');
      if (/burö lastas ej/i.test(txt)) codes.push('E');
      (rawLegs[day] = rawLegs[day] || []).push({
        t: hhmm, min: +hhmm.slice(0,2)*60 + +hhmm.slice(3),
        from: harb(a.FromHarbor?.Name), to: harb(a.ToHarbor?.Name), ferry, codes
      });
    }
  }
}

// --- Nordöleden: kedja ihop ben till turer och härled ankomsttider ---
// Regel: ankomst = min(samma färjas nästa avgång från destinationen,
//                      avgång + maximal överfartstid)
const MAXDUR = { BK:10, KB:10, BH:15, HB:15, BR:20, RB:20,
                 KH:17, HK:17, HR:15, RH:13, KR:30, RK:20 };
const HH = m => String(Math.floor(((m%1440)+1440)%1440/60)).padStart(2,'0') + ':' +
                String(((m%1440)+1440)%1440%60).padStart(2,'0');
const nordo = {};
for (const [day, legs] of Object.entries(rawLegs)) {
  legs.sort((a,b) => a.min - b.min);
  const arrOf = i => {
    const L = legs[i];
    const cap = MAXDUR[L.from+L.to];
    let next = null;
    for (let j=i+1; j<legs.length; j++)
      if (legs[j].ferry === L.ferry && legs[j].from === L.to) { next = legs[j].min; break; }
    if (next === null) return cap !== undefined ? L.min + cap : null;
    if (cap === undefined) return next;
    return Math.min(next, L.min + cap);
  };
  const pairs = {};
  legs.forEach((L, i) => {
    // följ färjan framåt och notera varje hamn den når innan den återvänder till starten
    let cur = i, seen = new Set([L.from]), codes = [...L.codes];
    while (cur !== null && cur < legs.length) {
      const C = legs[cur], a = arrOf(cur);
      if (a === null) break;
      if (!seen.has(C.to)) {
        const key = L.from + C.to;
        (pairs[key] = pairs[key] || []).push([L.t, HH(a), [...new Set(codes)].join('')]);
        seen.add(C.to);
      }
      if (C.to === L.from) break;                 // tillbaka där vi började
      let nx = null;
      for (let j=cur+1; j<legs.length; j++)
        if (legs[j].ferry === C.ferry && legs[j].from === C.to && legs[j].min <= a + 25) { nx = j; break; }
      if (nx === null) break;
      codes = codes.concat(legs[nx].codes);
      cur = nx;
    }
  });
  for (const k of Object.keys(pairs))
    pairs[k].sort((x,y) => x[0] < y[0] ? -1 : 1);
  nordo[day] = pairs;
}
for (const [day, pairs] of Object.entries(nordo)) {
  days[day] = days[day] || {};
  days[day].nordoPairs = pairs;
}
const nd = Object.keys(nordo)[0];
if (nd) console.log(`Nordöleden ${nd}: ` +
  Object.keys(nordo[nd]).map(k => k+'='+nordo[nd][k].length).join(' '));

for (const day of Object.values(days))
  for (const route of Object.values(day))
    for (const k of Object.keys(route)) route[k] = [...new Set(route[k])].sort();

writeFileSync('data.json', JSON.stringify({
  generated: new Date().toISOString(),
  source: 'Trafikverket öppna API (FerryAnnouncement 1.2)',
  note: 'Avgångstider per hamn och datum. Ankomsttider för Nordöleden finns ej i API:et.',
  days
}, null, 1));
console.log(`data.json: ${Object.keys(days).length} dagar`);

// --- logg för framtida analys ---
mkdirSync('log', { recursive: true });
if (deviations.length) {
  appendFileSync('log/deviations.jsonl', deviations.map(d => JSON.stringify(d)).join('\n') + '\n');
  console.log(`loggade ${deviations.length} avvikelser`);
}
if (unknownInfo.size) {
  const f = 'log/unknown-info.txt';
  const old = existsSync(f) ? readFileSync(f, 'utf8') : '';
  const add = [...unknownInfo].filter(t => !old.includes(t));
  if (add.length) {
    appendFileSync(f, add.map(t => `${new Date().toISOString()}\t${t.replace(/\n/g, ' ')}`).join('\n') + '\n');
    console.log(`nya okända Info-texter: ${add.length}`);
  }
}
}
main().catch(e=>{ console.error(e); process.exit(1); });
