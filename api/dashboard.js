const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1Qq0WnlqWQ2wcUcQOOOBVS5Yeu291BoTOqxJ4TZM2GgM';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';

const SUBJECTS = [
  { key: 'bm', code: 'BM', name: 'Bahasa Melayu', aliases: ['bahasa melayu', 'bm'], fallbackStart: 2 },
  { key: 'bi', code: 'BI', name: 'Bahasa Inggeris', aliases: ['bahasa inggeris', 'bi'], fallbackStart: 12 },
  { key: 'sn', code: 'SN', name: 'Sains', aliases: ['sains', 'sn'], fallbackStart: 22 },
  { key: 'mt', code: 'MT', name: 'Matematik', aliases: ['matematik', 'mt'], fallbackStart: 32 }
];

const CHECKPOINTS = [
  { key: 'tov', label: 'TOV' },
  { key: 'oti1', label: 'OTI1' },
  { key: 'oti2', label: 'OTI2' },
  { key: 'oti3', label: 'OTI3' },
  { key: 'etr', label: 'ETR' }
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  try {
    if (!GOOGLE_API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Missing GOOGLE_API_KEY in Vercel Environment Variables.'
      });
    }

    const meta = await getSheetMetadata();
    const classSheets = meta.sheets
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
        return {
          values: values.map(cell => String(cell.formattedValue || '').trim()),
          colors: values.map(cell => cellBackgroundHex(cell))
        };
      });

      students = students.concat(parseClassRows(rows, title, kelas, warnings));
    }

    students = removeDuplicates(students);
    students.sort((a, b) => classSort(a.kelas, b.kelas) || a.sourceRow - b.sourceRow || a.nama.localeCompare(b.nama));
    students.forEach((s, i) => s.bil = i + 1);

    const summary = buildSummary(students, classSheets, warnings);

    return res.status(200).json({
      success: true,
      message: `${students.length} murid dibaca daripada ${classSheets.length} tab kelas.`,
      lastUpdated: new Date().toLocaleString('ms-MY', { timeZone: 'Asia/Kuala_Lumpur' }),
      sheetNames: classSheets,
      warnings,
      students,
      summary
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
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
    .map(name => `ranges=${encodeURIComponent(`'${name.replace(/'/g, "''")}'!A1:AP140`)}`)
    .join('&');
  const fields = 'sheets.properties.title,sheets.data.rowData.values.formattedValue,sheets.data.rowData.values.effectiveFormat.backgroundColor,sheets.data.rowData.values.effectiveFormat.backgroundColorStyle.rgbColor';
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?includeGridData=true&${ranges}&fields=${encodeURIComponent(fields)}&key=${GOOGLE_API_KEY}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google Sheets grid error ${response.status}: ${await response.text()}`);
  return response.json();
}

function parseClassRows(rows, sheetName, kelas, warnings) {
  const result = [];
  const values = rows.map(row => row.values);
  const columnMap = detectColumnMap(values);

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r].values;
    const rowText = normalize(row.join(' '));
    if (!rowText || isTrashRow(rowText)) continue;

    const bilIndex = findBilIndex(row);
    if (bilIndex < 0) continue;

    let nama = '';
    const combined = splitBilAndName(row[bilIndex]);
    if (combined.name) {
      nama = cleanName(combined.name);
    } else {
      const nameIndex = findNameIndex(row, bilIndex, columnMap.firstSubjectStart);
      if (nameIndex >= 0) nama = cleanName(row[nameIndex]);
    }

    if (!nama) continue;

    const student = makeStudent(row, kelas, nama, sheetName, r + 1, columnMap, rows[r].colors, bilIndex);
    if (isValidStudent(student)) result.push(student);
  }

  if (!result.length) warnings.push(`Tiada murid dibaca pada tab ${sheetName}.`);
  return result;
}

function detectColumnMap(values) {
  const starts = {};
  SUBJECTS.forEach(sub => { starts[sub.key] = sub.fallbackStart; });

  for (let r = 0; r < Math.min(values.length, 8); r++) {
    const row = values[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = normalize(row[c]);
      if (!cell) continue;
      SUBJECTS.forEach(sub => {
        if (sub.aliases.some(alias => cell === alias || cell.includes(alias)) && c > 1) starts[sub.key] = c;
      });
    }
  }

  const subjectStarts = SUBJECTS.map(sub => starts[sub.key]).filter(isRealNumber).map(Number);
  return { starts, firstSubjectStart: subjectStarts.length ? Math.min(...subjectStarts) : 2 };
}

function makeStudent(row, kelas, nama, sheetName, sourceRow, columnMap, rowColors, bilIndex) {
  const s = {
    bil: 0,
    original_bil: parseStudentNumber(row[0]),
    sheet: sheetName,
    sourceRow,
    kelas,
    nama,
    pindah: /\bPINDAH\b/i.test(nama),
    red_focus: isRedColor(rowColors && rowColors[bilIndex]),
    missing_tp_count: 0,
    missing_tp_detail: [],
    data_points: 0
  };

  SUBJECTS.forEach(sub => {
    CHECKPOINTS.forEach(cp => {
      s[`${sub.key}_${cp.key}_markah`] = null;
      s[`${sub.key}_${cp.key}_tp`] = null;
    });
  });

  SUBJECTS.forEach(sub => fillSubject(s, row, sub, columnMap.starts[sub.key]));
  calculateStudent(s);
  return s;
}

function fillSubject(s, row, subject, start) {
  CHECKPOINTS.forEach((cp, i) => {
    const markKey = `${subject.key}_${cp.key}_markah`;
    const tpKey = `${subject.key}_${cp.key}_tp`;
    const mark = parseMarkah(row[start + (i * 2)]);
    const tpValue = parseTp(row[start + (i * 2) + 1]);

    s[markKey] = mark;
    s[tpKey] = tpValue;

    if (isRealNumber(mark)) s.data_points++;
    if (isRealNumber(tpValue)) s.data_points++;

    if (isRealNumber(mark) && !isRealNumber(tpValue)) {
      s.missing_tp_count++;
      s.missing_tp_detail.push(`${subject.code} ${cp.label}`);
    }
  });
}

function calculateStudent(s) {
  CHECKPOINTS.forEach(cp => {
    const marks = SUBJECTS.map(sub => s[`${sub.key}_${cp.key}_markah`]).filter(isRealNumber);
    const tps = SUBJECTS.map(sub => s[`${sub.key}_${cp.key}_tp`]).filter(isRealNumber);
    s[`avg_${cp.key}_markah`] = average(marks);
    s[`avg_${cp.key}_tp`] = average(tps);
    s[`grade_${cp.key}`] = gradeFromMark(s[`avg_${cp.key}_markah`]);
  });

  s.status = getStudentStatus(s);
  s.fokus_subjek = getFocusSubject(s);
  s.tp_semak = s.missing_tp_detail.length ? s.missing_tp_detail.slice(0, 4).join(', ') : '-';
}

function getStudentStatus(s) {
  if (s.pindah) return 'Pindah';
  if (s.red_focus) return 'Murid Fokus';
  if (s.data_points === 0) return 'Data Tidak Lengkap';
  return 'Stabil';
}

function getFocusSubject(s) {
  const scored = SUBJECTS.map(sub => {
    const markah = s[`${sub.key}_tov_markah`];
    const tp = s[`${sub.key}_tov_tp`];
    return {
      name: sub.name,
      markah,
      tp,
      score: (isRealNumber(tp) && tp <= 2 ? 20 : 0) + (isRealNumber(markah) && markah < 40 ? 20 : 0)
    };
  }).filter(x => isRealNumber(x.markah) || isRealNumber(x.tp));

  if (!scored.length) return '-';
  scored.sort((a, b) => b.score - a.score || safeNumber(a.markah, 999) - safeNumber(b.markah, 999));
  return scored[0].score > 0 ? scored[0].name : 'Murid Fokus';
}

function buildSummary(students, sheetNames, warnings) {
  const classes = unique(students.map(s => s.kelas)).filter(Boolean).sort(classSort);
  const subjectSummary = SUBJECTS.map(sub => buildSubjectSummary(students, sub));
  const focusStudents = students.filter(s => s.red_focus).sort((a, b) => classSort(a.kelas, b.kelas) || a.sourceRow - b.sourceRow);

  return {
    totalStudents: students.length,
    totalClasses: classes.length,
    totalSheets: sheetNames.length,
    classes,
    subjectSummary,
    classSummary: classes.map(kelas => {
      const list = students.filter(s => s.kelas === kelas);
      return {
        kelas,
        total: list.length,
        avgTovMark: average(list.map(s => s.avg_tov_markah).filter(isRealNumber)),
        focusCount: list.filter(s => s.red_focus).length
      };
    }),
    focusStudents,
    bestStudents: students.filter(s => isRealNumber(s.avg_tov_markah)).sort((a, b) => b.avg_tov_markah - a.avg_tov_markah).slice(0, 10),
    quality: {
      redFocusCount: focusStudents.length,
      missingTpCells: sum(students.map(s => s.missing_tp_count)),
      warnings
    },
    avgTovMark: average(students.map(s => s.avg_tov_markah).filter(isRealNumber)),
    avgOti1Mark: average(students.map(s => s.avg_oti1_markah).filter(isRealNumber)),
    avgOti2Mark: average(students.map(s => s.avg_oti2_markah).filter(isRealNumber)),
    avgOti3Mark: average(students.map(s => s.avg_oti3_markah).filter(isRealNumber)),
    avgEtrMark: average(students.map(s => s.avg_etr_markah).filter(isRealNumber))
  };
}

function buildSubjectSummary(students, sub) {
  return {
    key: sub.key,
    code: sub.code,
    name: sub.name,
    avgTovMark: average(students.map(s => s[`${sub.key}_tov_markah`]).filter(isRealNumber)),
    avgOti1Mark: average(students.map(s => s[`${sub.key}_oti1_markah`]).filter(isRealNumber)),
    avgEtrMark: average(students.map(s => s[`${sub.key}_etr_markah`]).filter(isRealNumber)),
    focusCount: students.filter(s => s.red_focus).length,
    redFocusCount: students.filter(s => s.red_focus).length
  };
}

function cellBackgroundHex(cell) {
  const style = (((cell || {}).effectiveFormat || {}).backgroundColorStyle || {}).rgbColor;
  const bg = style || (((cell || {}).effectiveFormat || {}).backgroundColor);
  if (!bg) return '#ffffff';
  const toHex = value => Math.round((value === undefined ? 1 : value) * 255).toString(16).padStart(2, '0');
  return `#${toHex(bg.red)}${toHex(bg.green)}${toHex(bg.blue)}`;
}

function isRedColor(color) {
  const text = String(color || '').trim().toLowerCase();
  const match = text.match(/^#([0-9a-f]{6})$/);
  if (!match) return false;

  const r = parseInt(match[1].slice(0, 2), 16);
  const g = parseInt(match[1].slice(2, 4), 16);
  const b = parseInt(match[1].slice(4, 6), 16);
  return r >= 190 && r > g + 20 && r > b + 20;
}

function isValidStudent(s) {
  if (!s.nama || !s.kelas) return false;
  if (isTrashName(s.nama)) return false;
  return s.data_points > 0;
}

function findBilIndex(row) {
  for (let c = 0; c < Math.min(row.length, 3); c++) {
    if (isStudentNumber(row[c])) return c;
  }
  return -1;
}

function findNameIndex(row, bilIndex, firstSubjectStart) {
  const from = bilIndex + 1;
  const to = Math.max(from, Math.min(row.length - 1, firstSubjectStart - 1));
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

function isTrashName(value) {
  const text = normalize(value);
  return ['nama', 'nama murid', 'murid', 'kelas', 'bil', 'gred', 'markah', 'tov', 'oti', 'etr', 'tp', 'jumlah', 'purata', 'rumusan', 'analisis'].includes(text);
}

function isTrashRow(text) {
  return ['jumlah tahap', 'jumlah tp', 'jumlah murid', 'jumlah keseluruhan', 'tahap penguasaan', 'mata pelajaran', 'analisis kelas', 'senarai murid'].some(x => text.includes(x));
}

function cleanClassName(value) {
  const text = String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!text || /^(DATA|ANALISIS|RUMUSAN|SENARAI)\b/.test(text)) return '';
  const exact = text.match(/\b([1-6])\s*(CERDIK|BIJAK|PINTAR|ARIF|BESTARI|GIGIH|JUJUR|AMANAH|RAJIN|IKHLAS|DINAMIK|KREATIF|CEKAP|GEMILANG|MAJU|SUKSES|INOVATIF)\b/);
  if (exact) return `${exact[1]} ${exact[2]}`;
  const flexible = text.match(/^([1-6])\s+([A-Z]{3,20})$/);
  if (flexible && !['DATA', 'ANALISIS', 'RUMUSAN', 'MARKAH', 'MURID', 'KELAS'].includes(flexible[2])) return `${flexible[1]} ${flexible[2]}`;
  return '';
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

function gradeFromMark(mark) {
  if (!isRealNumber(mark)) return '-';
  const n = Number(mark);
  if (n >= 90) return 'A';
  if (n >= 75) return 'B';
  if (n >= 60) return 'C';
  if (n >= 45) return 'D';
  if (n >= 31) return 'E';
  return 'G';
}

function average(arr) {
  const clean = arr.filter(isRealNumber).map(Number);
  if (!clean.length) return null;
  return Math.round((sum(clean) / clean.length) * 100) / 100;
}

function sum(arr) {
  return arr.reduce((a, b) => a + Number(b || 0), 0);
}

function isRealNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function safeNumber(value, fallback) {
  return isRealNumber(value) ? Number(value) : fallback;
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

function emptySummary() {
  return {
    totalStudents: 0,
    totalClasses: 0,
    classes: [],
    subjectSummary: [],
    classSummary: [],
    focusStudents: [],
    bestStudents: [],
    quality: { redFocusCount: 0, missingTpCells: 0, warnings: [] }
  };
}
