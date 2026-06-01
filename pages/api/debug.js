import { google } from 'googleapis';

const SHEET_ID = '1wVYr-jf-rh2UtMbW1fvciJVZQk8dqBb-TAvpaeqJYtk';
const RANGE    = "'Visão Semanal Piscinas'!A1:AL200";

function normalizeKey(key) {
  if (!key) return '';
  if (key.includes('\n')) return key;
  return key.replace(/\\n/g, '\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
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

    // Mostrar header (linha 0) para identificar colunas
    const header = rows[0] || [];

    // Mostrar colunas críticas para linhas de 2026 com semana >= 20
    const roasRows = [];
    for (let i = 1; i < rows.length; i++) {
      const row  = rows[i];
      const year = parseInt(String(row[37] || '').trim()) || 0;
      const semana = parseInt(String(row[0] || '').trim()) || 0;
      if (year === 2026 && semana >= 20 && semana <= 36) {
        roasRows.push({
          semana,
          col25_raw: row[25],  // coluna antes do ROAS
          col26_raw: row[26],  // ROAS (index 26)
          col27_raw: row[27],  // coluna depois do ROAS
          inv:   row[1],
          nvT:   row[16],
          vT:    row[19],
          year:  row[37],
        });
      }
    }

    res.json({
      headerCol25: header[25],
      headerCol26: header[26],
      headerCol27: header[27],
      roasRows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
