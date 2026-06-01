import { google } from 'googleapis';

const SHEET_ID = '1wVYr-jf-rh2UtMbW1fvciJVZQk8dqBb-TAvpaeqJYtk';
const RANGE   = "'Visão Semanal Piscinas'!A1:AL200";

// Normaliza a private key independentemente de como foi colada no Vercel
function normalizeKey(key) {
  if (!key) return '';
  // Se já tem newlines reais (formato PEM correcto), usa directamente
  if (key.includes('\n')) return key;
  // Se tem \n literais (dois caracteres: \ e n), converte para newlines reais
  return key.replace(/\\n/g, '\n');
}

// Datas fixas das épocas para o Open-Meteo
const SEASON_2025 = { start: '2025-05-30', end: '2025-09-06' };
const SEASON_2026 = { start: '2026-05-15', end: '2026-09-07' };

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseEur(v) {
  if (v === null || v === undefined || v === '') return 0;
  let s = String(v).replace(/[€\s]/g, '');
  if (s.includes(',') && s.includes('.')) {
    // formato PT: 1.234,56
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  return parseFloat(s) || 0;
}

function parseNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = String(v).trim();
  if (s.includes(',') && s.includes('.')) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  } else if (s.includes(',')) {
    return parseFloat(s.replace(',', '.')) || 0;
  }
  return parseFloat(s) || 0;
}

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // YYYY/MM/DD
  const ymd = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  // Excel serial
  if (/^\d+$/.test(s)) {
    const n = parseInt(s);
    if (n > 40000 && n < 60000) {
      const d = new Date((n - 25569) * 86400000);
      return d.toISOString().split('T')[0];
    }
  }
  return null;
}

// ─── Open-Meteo ───────────────────────────────────────────────────────────────

async function fetchSeasonClimate(startDate, endDate) {
  try {
    const today = new Date().toISOString().split('T')[0];
    if (startDate > today) return null;
    const end = endDate > today ? today : endDate;
    const url =
      `https://archive-api.open-meteo.com/v1/archive` +
      `?latitude=38.7069&longitude=-8.9754` +
      `&start_date=${startDate}&end_date=${end}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,sunshine_duration` +
      `&timezone=Europe%2FLisbon`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.daily || null;
  } catch {
    return null;
  }
}

function aggregateClimaForWeek(daily, startDate, endDate) {
  if (!daily || !startDate || !endDate) return null;
  const start = new Date(startDate + 'T00:00:00Z');
  const end   = new Date(endDate   + 'T23:59:59Z');
  const idx = daily.time.reduce((acc, d, i) => {
    const dt = new Date(d + 'T12:00:00Z');
    if (dt >= start && dt <= end) acc.push(i);
    return acc;
  }, []);
  if (idx.length === 0) return null;
  const vals = (key) => idx.map(i => daily[key]?.[i]).filter(v => v !== null && v !== undefined);
  const tMax = vals('temperature_2m_max');
  const tMin = vals('temperature_2m_min');
  const prec = vals('precipitation_sum');
  const sun  = vals('sunshine_duration');
  return {
    tempMax: tMax.length ? Math.round(Math.max(...tMax) * 10) / 10 : null,
    tempMin: tMin.length ? Math.round(Math.min(...tMin) * 10) / 10 : null,
    precip:  prec.length ? Math.round(prec.reduce((a, b) => a + b, 0) * 10) / 10 : null,
    sol:     sun.length  ? Math.round(sun.reduce((a, b) => a + b, 0) / 3600) : null,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_EMAIL,
        private_key: normalizeKey(process.env.GOOGLE_PRIVATE_KEY),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Sheets + clima em paralelo
    const [sheetRes, climate2025, climate2026] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE }),
      fetchSeasonClimate(SEASON_2025.start, SEASON_2025.end),
      fetchSeasonClimate(SEASON_2026.start, SEASON_2026.end),
    ]);

    const rows = sheetRes.data.values || [];
    const semanal2026 = [];
    const semanal2025 = [];

    // row[0]=Semana, [1]=InvTotal, [2]=InvMeta, [3]=InvGoogle
    // [14]=#VendasMeta, [15]=#VendasGoogle, [16]=#VendasTotais
    // [17]=VendasMeta€, [18]=VendasGoogle€, [19]=VendasTotais€
    // [23]=TráfegoTotal, [24]=TráfegoHomepage, [26]=ROAS
    // [30]=TxConvTotal, [35]=Data_init, [36]=Data_fim, [37]=Year
    for (let i = 1; i < rows.length; i++) {
      const row  = rows[i];
      const year = parseInt(String(row[37] || '').trim()) || 0;
      if (year !== 2025 && year !== 2026) continue;

      const inv   = parseEur(row[1]);
      const nvT   = parseNum(row[16]);
      const vT    = parseEur(row[19]);
      const trafHP = parseNum(row[24]);

      const obj = {
        s:        parseNum(row[0]),
        inv,
        iM:       parseEur(row[2]),
        iG:       parseEur(row[3]),
        nvT,
        nvM:      parseNum(row[14]),
        nvG:      parseNum(row[15]),
        vT,
        vM:       parseEur(row[17]),
        vG:       parseEur(row[18]),
        trafHP,
        trafT:    parseNum(row[23]),
        roas:     parseNum(row[26]),
        dataInit: parseDate(row[35]),
        dataFim:  parseDate(row[36]),
        year,
        // calculados
        ticketMedio: nvT > 0 ? vT / nvT : 0,
        cpb:         nvT > 0 ? inv / nvT : 0,
        txConv:      trafHP > 0 ? (nvT / trafHP) * 100 : 0,
      };

      if (year === 2026) semanal2026.push(obj);
      else               semanal2025.push(obj);
    }

    semanal2026.sort((a, b) => a.s - b.s);
    semanal2025.sort((a, b) => a.s - b.s);

    // Mapa de clima por chave "YEAR_semana"
    const clima = {};
    for (const w of semanal2026) {
      if (w.dataInit && w.dataFim && climate2026) {
        const c = aggregateClimaForWeek(climate2026, w.dataInit, w.dataFim);
        if (c) clima[`2026_${w.s}`] = c;
      }
    }
    for (const w of semanal2025) {
      if (w.dataInit && w.dataFim && climate2025) {
        const c = aggregateClimaForWeek(climate2025, w.dataInit, w.dataFim);
        if (c) clima[`2025_${w.s}`] = c;
      }
    }

    res.json({ semanal2026, semanal2025, clima, updatedAt: new Date().toISOString() });

  } catch (err) {
    console.error('[dados.js]', err);
    res.status(500).json({ error: err.message });
  }
}
