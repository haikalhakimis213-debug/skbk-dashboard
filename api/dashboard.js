const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1Qq0WnlqWQ2wcUcQOOOBVS5Yeu291BoTOqxJ4TZM2GgM';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const PARSER_VERSION = 'TP12_DIRECT_COLUMNS_V2';
const ALLOWED_CLASS_YEARS = new Set(['1', '2', '3']);

// Arahan mama: Tahun 1-3, OTI1 + TP sahaja.
// Lajur Google Sheet: BM E:F, Sains O:P, M3 Y:Z, BI AI:AJ.
// Index JS adalah 0-based: E=4, F=5, O=14, P=15, Y=24, Z=25, AI=34, AJ=35.
const SUBJECTS = [
  { key: 'bm', code: 'BM', name: 'Bahasa Melayu', markCol: 4, tpCol: 5 },
  { key: 'sn', code: 'SN', name: 'Sains', markCol: 14, tpCol: 15 },
  { key: 'mt', code: 'M3', name: 'Matematik', markCol: 24, tpCol: 25 },
  { key: 'bi', code: 'BI', name: 'Bahasa Inggeris', markCol: 34, tpCol: 35 }
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (!GOOGLE_API_KEY) {
      return res.status(500).json({
        success: false,
        parserVersion: PARSER_VERSION,
        message: 'Missing GOOGLE_API_KEY in Vercel Environment Variables.'
      });
    }

    const meta = await getSheetMetadata();
    const classSheets = (meta.sheets || [])
      .map(sheet => sheet.properties.title)
      .filter(title => cleanClassName(title));

    const grid = await getGridData(classSheets);
    let students = [];
    const warnings = [];

    for (const sheet of grid.sheets || []) {
      const title = sheet.properties.title;
      const kelas = cleanClassName(title);
      if (!kelas) continue;

      const rows = (((sheet.data || [])[0] || {}).rowData || []).map(row => {
        const values = row.values || [];
        return values.map(cell => String(cell.formattedValue || '').trim());
      });

      students = students.concat(parseClassRows(rows, title, kelas, warnings));
    }

    students = removeDuplicates(students);
    students.sort((a, b) => classSort(a.kelas, b.kelas) || a.sourceRow - b.sourceRow || a.nama.localeCompare(b.nama));
    students.forEach((s, i) => s.bil = i + 1);

    const summary = buildSummary(students, classSheets, warnings);

    return res.status(200).json({
      success: true,
      parserVersion: PARSER_VERSION,
      message: `${students.length} murid dibaca daripada ${classSheets.length} tab kelas.`,
      lastUpdated: new Date().toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' }),
      sheetNames: classSheets,
      columns: SUBJECTS.map(s => ({ code: s.code, markCol: columnLetter(s.markCol), tpCol: columnLetter(s.tpCol) })),
      warnings,
      students,
      summary
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      parserVersion: PARSER_VERSION,
      message: 'Gagal baca Google Sheet.',
      error: String(err && err.stack ? err.stack : err),
      students: [],
      summary: emptySummary()
    });
  }
};

async function getSheetMetadata() {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties.title&key=${GOOGLE_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Sheets metadata error ${response.status}: ${await response.text()}`);
  return response.json();
}

async function getGridData(sheetNames) {
  if (!sheetNames.length) return { sheets: [] };
  const ranges = sheetNames
    .map(name => `ranges=${encodeURIComponent(`'${name.replace(/'/g, "''")}'!A1:AJ160`)}`)
    .join('&');
  const fields = 'sheets.properties.title,sheets.data.rowData.values.formattedValue';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?includeGridData=true&${ranges}&fields=${encodeURIComponent(fields)}&key=${GOOGLE_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Sheets grid error ${response.status}: ${await response.text()}`);
  return response.json();
}

function parseClassRows(rows, sheetName, kelas, warnings) {
  const result = [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const rowText = normalize(row.join(' '));
    if (!rowText || isTrashRow(rowText)) continue;

    const bilIndex = findBilIndex(row);
    if (bilIndex < 0) continue;

    let nama = '';
    const combined = splitBilAndName(row[bilIndex]);
    if (combined.name) {
      nama = cleanName(combined.name);
    } else {
      const nameIndex = findNameIndex(row, bilIndex);
      if (nameIndex >= 0) nama = cleanName(row[nameIndex]);
    }

    if (!nama) continue;

    const student = makeStudent(row, kelas, nama, sheetName, r + 1);
    if (isValidStudent(student)) result.push(student);
  }

  if (!result.length) warnings.push(`Tiada murid dibaca pada tab ${sheetName}.`);
  return result;
}

function makeStudent(row, kelas, nama, sheetName, sourceRow) {
  const s = {
    bil: 0,
    original_bil: parseStudentNumber(row[0]),
    sheet: sheetName,
    sourceRow,
    kelas,
    nama,
    pindah: /\bPINDAH\b/i.test(nama),
    data_points: 0,
    red_focus: false,
    status: 'Stabil',
    fokus_subjek: '-',
    tp12_subjects: []
  };

  SUBJECTS.forEach(sub => {
    const mark = parseMarkah(row[sub.markCol]);
    const tp = parseTp(row[sub.tpCol]);
    s[`${sub.key}_oti1_markah`] = mark;
    s[`${sub.key}_oti1_tp`] = tp;
    if (isRealNumber(mark)) s.data_points++;
    if (isRealNumber(tp)) s.data_points++;
    if (isTp12(tp)) s.tp12_subjects.push(`${sub.code} TP${tp}`);
  });

  const marks = SUBJECTS.map(sub => s[`${sub.key}_oti1_markah`]).filter(isRealNumber);
  s.avg_oti1_markah = average(marks);
  s.has_oti1_data = SUBJECTS.some(sub => isRealNumber(s[`${sub.key}_oti1_markah`]) || isRealNumber(s[`${sub.key}_oti1_tp`]));
  s.red_focus = s.tp12_subjects.length > 0;
  s.fokus_subjek = s.tp12_subjects.length ? s.tp12_subjects.join(', ') : '-';

  if (s.pindah) s.status = 'Pindah';
  else if (s.red_focus) s.status = 'TP 1-2';
  else if (!s.has_oti1_data) s.status = 'Data OTI1 Kosong';
  else s.status = 'Stabil';

  return s;
}

function buildSummary(students, sheetNames, warnings) {
  const classes = unique(students.map(s => s.kelas)).filter(Boolean).sort(classSort);
  const focusStudents = students.filter(s => s.red_focus).sort((a, b) => classSort(a.kelas, b.kelas) || a.sourceRow - b.sourceRow);

  return {
    totalStudents: students.length,
    totalClasses: classes.length,
    totalSheets: sheetNames.length,
    classes,
    subjectSummary: SUBJECTS.map(sub => ({
      key: sub.key,
      code: sub.code,
      name: sub.name,
      avgOti1Mark: average(students.map(s => s[`${sub.key}_oti1_markah`]).filter(isRealNumber)),
      tp12Count: students.filter(s => isTp12(s[`${sub.key}_oti1_tp`])).length,
      focusCount: students.filter(s => isTp12(s[`${sub.key}_oti1_tp`])).length
    })),
    classSummary: classes.map(kelas => {
      const list = students.filter(s => s.kelas === kelas);
      return {
        kelas,
        total: list.length,
        avgOti1Mark: average(list.map(s => s.avg_oti1_markah).filter(isRealNumber)),
        tp12Count: list.filter(s => s.red_focus).length,
        focusCount: list.filter(s => s.red_focus).length
      };
    }),
    focusStudents,
    quality: {
      tp12Count: focusStudents.length,
      emptyOti1Count: students.filter(s => !s.has_oti1_data).length,
      warnings
    },
    avgOti1Mark: average(students.map(s => s.avg_oti1_markah).filter(isRealNumber))
  };
}

function cleanClassName(value) {
  const text = String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!text || /^(DATA|ANALISIS|RUMUSAN|SENARAI|DASHBOARD)\b/.test(text)) return '';
  const classNames = 'CERDIK|BIJAK|PINTAR|ARIF|BESTARI|GIGIH|JUJUR|AMANAH|RAJIN|IKHLAS|DINAMIK|KREATIF|CEKAP|GEMILANG|MAJU|SUKSES|INOVATIF';
  const exact = text.match(new RegExp(`\b([1-6])\s*(${classNames})\b`));
  if (exact && ALLOWED_CLASS_YEARS.has(exact[1])) return `${exact[1]} ${exact[2]}`;
  const flexible = text.match(/^([1-6])\s+([A-Z]{3,20})$/);
  if (flexible && ALLOWED_CLASS_YEARS.has(flexible[1]) && !['DATA', 'ANALISIS', 'RUMUSAN', 'MARKAH', 'MURID', 'KELAS'].includes(flexible[2])) {
    return `${flexible[1]} ${flexible[2]}`;
  }
  return '';
}

function findBilIndex(row) {
  for (let c = 0; c < Math.min(row.length, 3); c++) {
    if (isStudentNumber(row[c])) return c;
  }
  return -1;
}

function findNameIndex(row, bilIndex) {
  const from = bilIndex + 1;
  const to = Math.min(row.length - 1, 3);
  for (let c = from; c <= to; c++) if (cleanName(row[c])) return c;
  return -1;
}

function splitBilAndName(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})\s+(.+)$/);
  return match ? { bil: Number(match[1]), name: match[2] } : { bil: parseStudentNumber(value), name: '' };
}

function parseStudentNumber(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})(?:\s|$|[.)-])/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 && n < 100 ? n : null;
}

function isStudentNumber(value) {
  return isRealNumber(parseStudentNumber(value));
}

function cleanName(value) {
  let text = String(value || '').trim().replace(/^\d+\s*[.)\-:]*\s*/, '').replace(/\s+/g, ' ');
  if (!text || text.length < 3 || /^\d+$/.test(text) || !/[A-Za-z]/.test(text) || isTrashName(text)) return '';
  return text.toUpperCase();
}

function isValidStudent(s) {
  if (!s.nama || !s.kelas) return false;
  if (isTrashName(s.nama)) return false;
  return s.data_points > 0;
}

function isTrashName(value) {
  const text = normalize(value);
  return ['nama', 'nama murid', 'murid', 'kelas', 'bil', 'gred', 'markah', 'tov', 'oti', 'oti1', 'etr', 'tp', 'jumlah', 'purata', 'rumusan', 'analisis'].includes(text);
}

function isTrashRow(text) {
  return ['jumlah tahap', 'jumlah tp', 'jumlah murid', 'jumlah keseluruhan', 'tahap penguasaan', 'mata pelajaran', 'analisis kelas', 'senarai murid'].some(x => text.includes(x));
}

function parseMarkah(value) {
  const text = String(value ?? '').trim().replace('%', '').replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

function parseTp(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/\b(?:TP|TAHAP)\s*[:\-]?\s*([1-6])\b/i);
  if (match) return Number(match[1]);
  return /^[1-6](\.0+)?$/.test(text) ? Number(text) : null;
}

function isTp12(value) {
  return isRealNumber(value) && Number(value) >= 1 && Number(value) <= 2;
}

function average(arr) {
  const clean = arr.filter(isRealNumber).map(Number);
  if (!clean.length) return null;
  return Math.round((clean.reduce((a, b) => a + b, 0) / clean.length) * 100) / 100;
}

function isRealNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[()_\-\/\\:|.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function removeDuplicates(students) {
  const byKey = {};
  students.forEach(s => {
    const key = normalize(`${s.kelas} ${s.nama.replace(/\bPINDAH\b/g, '')}`);
    if (!byKey[key] || s.data_points > byKey[key].data_points) byKey[key] = s;
  });
  return Object.values(byKey);
}

function classSort(a, b) {
  const pa = parseClass(a);
  const pb = parseClass(b);
  if (pa.year !== pb.year) return pa.year - pb.year;
  return pa.name.localeCompare(pb.name);
}

function parseClass(kelas) {
  const match = String(kelas || '').match(/^(\d+)\s+(.+)$/);
  return match ? { year: Number(match[1]), name: match[2] } : { year: 99, name: String(kelas || '') };
}

function columnLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

function emptySummary() {
  return {
    totalStudents: 0,
    totalClasses: 0,
    classes: [],
    subjectSummary: [],
    classSummary: [],
    focusStudents: [],
    quality: { tp12Count: 0, warnings: [] },
    avgOti1Mark: null
  };
}
