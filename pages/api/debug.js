import { google } from 'googleapis';

const SHEET_ID = '1wVYr-jf-rh2UtMbW1fvciJVZQk8dqBb-TAvpaeqJYtk';
const RANGE    = "'Visão Semanal Piscinas'!A1:AL200";
const SEASON_2025 = { start: '2025-05-30', end: '2025-09-06' };
const SEASON_2026 = { start: '2026-05-15', end: '2026-09-07' };

function normalizeKey(key) {
  if (!key) return '';
  if (key.includes('\n')) return key;
  return key.replace(/\\n/g, '\n');
}

async function fetchClimate(startDate, endDate) {
  try {
    const today = new Date().toISOString().split('T')[0];
    if (startDate > today) return null;
    const end = endDate > today ? today : endDate;
    const url =
      `https://archive-api.open-meteo.com/v1/archive` +
      `?latitude=38.7069&longitude=-8.9754` +
      `&start_date=${startDate}&end_date=${end}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
      `&timezone=Europe%2FLisbon`;
    const res = await fetch(url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return data.daily || null;
  } catch (e) {
    return { error: e.message };
  }
}

export default async function handler(req, res) {
  const report = {
    env: {
      hasServiceEmail: !!process.env.GOOGLE_SERVICE_EMAIL,
      hasPrivateKey:   !!process.env.GOOGLE_PRIVATE_KEY,
      keyStarts:       process.env.GOOGLE_PRIVATE_KEY?.slice(0, 27) || '—',
    },
    sheet: null,
    climate2025: null,
    climate2026: null,
  };

  // ── Sheets ────────────────────────────────────────────────────────────────
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_SERVICE_EMAIL,
        private_key:  normalizeKey(process.env.GOOGLE_PRIVATE_KEY),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const resp   = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: RANGE });
    const rows   = resp.data.values || [];

    let count2025 = 0, count2026 = 0, noYear = 0;
    const sample2025 = [], sample2026 = [];

    for (let i = 1; i < rows.length; i++) {
      const row  = rows[i];
      const year = parseInt(String(row[37] || '').trim()) || 0;
      const semana = row[0];
      const dataInit = row[35];
      const dataFim  = row[36];
      if (year === 2025) {
        count2025++;
        if (sample2025.length < 3) sample2025.push({ semana, dataInit, dataFim, year });
      } else if (year === 2026) {
        count2026++;
        if (sample2026.length < 3) sample2026.push({ semana, dataInit, dataFim, year });
      } else {
        noYear++;
      }
    }

    report.sheet = { totalRows: rows.length - 1, count2025, count2026, noYear, sample2025, sample2026 };
  } catch (e) {
    report.sheet = { error: e.message };
  }

  // ── Climate 2025 ──────────────────────────────────────────────────────────
  const c25 = await fetchClimate(SEASON_2025.start, SEASON_2025.end);
  if (c25?.error) {
    report.climate2025 = { error: c25.error };
  } else if (c25) {
    report.climate2025 = {
      days:      c25.time?.length || 0,
      firstDate: c25.time?.[0]   || '—',
      lastDate:  c25.time?.[c25.time.length - 1] || '—',
      sampleDay: c25.time?.[0] ? {
        date:    c25.time[0],
        tempMax: c25.temperature_2m_max?.[0],
        tempMin: c25.temperature_2m_min?.[0],
        precip:  c25.precipitation_sum?.[0],
      } : null,
    };
  } else {
    report.climate2025 = null;
  }

  // ── Climate 2026 ──────────────────────────────────────────────────────────
  const c26 = await fetchClimate(SEASON_2026.start, SEASON_2026.end);
  if (c26?.error) {
    report.climate2026 = { error: c26.error };
  } else if (c26) {
    report.climate2026 = {
      days:      c26.time?.length || 0,
      firstDate: c26.time?.[0]   || '—',
      lastDate:  c26.time?.[c26.time.length - 1] || '—',
    };
  } else {
    report.climate2026 = null;
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json(report);
}
