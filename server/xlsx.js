'use strict';
/**
 * Minimal, dependency-free .xlsx (SpreadsheetML) writer.
 *
 * Supports what the Tracki export needs: styled header row, frozen header,
 * auto-filter, column widths, real date cells, numbers, wrapped long text and
 * clickable hyperlinks. Strings are written inline, so there is no shared
 * string table to keep in sync.
 */
const { createZip } = require('./zip');

const STYLE = { DEFAULT: 0, HEADER: 1, DATE: 2, WRAP: 3, LINK: 4, NUMBER: 5, BOLD: 6 };

function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // illegal in XML 1.0
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0 -> A, 25 -> Z, 26 -> AA */
function colName(index) {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/** Excel serial date (1900 date system, including the documented leap-year quirk). */
function toSerialDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((utc - Date.UTC(1899, 11, 30)) / 86400000);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
__SHEET_OVERRIDES__
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFBFC9D4"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function buildSheetXml(sheet) {
  const columns = sheet.columns;
  const rows = sheet.rows || [];
  const hyperlinks = [];
  const lines = [];

  // Header row
  const headerCells = columns
    .map((col, c) => `<c r="${colName(c)}1" s="${STYLE.HEADER}" t="inlineStr"><is><t>${escapeXml(col.header)}</t></is></c>`)
    .join('');
  lines.push(`<row r="1" ht="28" customHeight="1" s="${STYLE.HEADER}">${headerCells}</row>`);

  rows.forEach((row, r) => {
    const rowNumber = r + 2;
    const cells = [];
    columns.forEach((col, c) => {
      const ref = `${colName(c)}${rowNumber}`;
      const raw = row[col.key];
      if (raw === null || raw === undefined || raw === '') return;

      if (col.type === 'date') {
        const serial = toSerialDate(raw);
        if (serial === null) {
          cells.push(`<c r="${ref}" s="${STYLE.WRAP}" t="inlineStr"><is><t>${escapeXml(raw)}</t></is></c>`);
        } else {
          cells.push(`<c r="${ref}" s="${STYLE.DATE}"><v>${serial}</v></c>`);
        }
        return;
      }
      if (col.type === 'number') {
        const num = Number(String(raw).replace(/[^0-9.\-]/g, ''));
        if (Number.isFinite(num)) {
          cells.push(`<c r="${ref}" s="${STYLE.NUMBER}"><v>${num}</v></c>`);
        } else {
          cells.push(`<c r="${ref}" s="${STYLE.WRAP}" t="inlineStr"><is><t>${escapeXml(raw)}</t></is></c>`);
        }
        return;
      }
      if (col.type === 'url' && /^https?:\/\//i.test(String(raw).trim())) {
        hyperlinks.push({ ref, target: String(raw).trim() });
        cells.push(`<c r="${ref}" s="${STYLE.LINK}" t="inlineStr"><is><t>${escapeXml(raw)}</t></is></c>`);
        return;
      }
      cells.push(`<c r="${ref}" s="${STYLE.WRAP}" t="inlineStr"><is><t>${escapeXml(raw)}</t></is></c>`);
    });
    lines.push(`<row r="${rowNumber}">${cells.join('')}</row>`);
  });

  const lastCol = colName(Math.max(0, columns.length - 1));
  const lastRow = rows.length + 1;
  const cols = columns
    .map((col, c) => `<col min="${c + 1}" max="${c + 1}" width="${col.width || 18}" customWidth="1"/>`)
    .join('');

  const hyperlinkXml = hyperlinks.length
    ? `<hyperlinks>${hyperlinks
        .map((link, i) => `<hyperlink ref="${link.ref}" r:id="rId${i + 1}"/>`)
        .join('')}</hyperlinks>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"${sheet.tabSelected ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${lines.join('')}</sheetData>
${sheet.autoFilter === false ? '' : `<autoFilter ref="A1:${lastCol}${lastRow}"/>`}
${hyperlinkXml}
</worksheet>`;

  const rels = hyperlinks.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${hyperlinks
  .map(
    (link, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(
        link.target
      )}" TargetMode="External"/>`
  )
  .join('')}
</Relationships>`
    : null;

  return { xml, rels };
}

/**
 * @param {{sheets: Array<{name:string, columns:Array, rows:Array, autoFilter?:boolean}>}} workbook
 * @returns {Buffer} .xlsx file contents
 */
function buildWorkbook(workbook) {
  const sheets = workbook.sheets.filter(Boolean);
  if (!sheets.length) throw new Error('A workbook needs at least one sheet');

  const entries = [];
  const overrides = [];
  const workbookSheets = [];
  const workbookRels = [];

  sheets.forEach((sheet, i) => {
    const index = i + 1;
    const built = buildSheetXml({ ...sheet, tabSelected: i === 0 });
    entries.push({ name: `xl/worksheets/sheet${index}.xml`, data: built.xml });
    if (built.rels) {
      entries.push({ name: `xl/worksheets/_rels/sheet${index}.xml.rels`, data: built.rels });
    }
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    );
    // Excel rejects sheet names over 31 chars or containing : \ / ? * [ ]
    const safeName = String(sheet.name || `Sheet${index}`).replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
    workbookSheets.push(`<sheet name="${escapeXml(safeName)}" sheetId="${index}" r:id="rId${index}"/>`);
    workbookRels.push(
      `<Relationship Id="rId${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index}.xml"/>`
    );
  });

  const stylesRelId = sheets.length + 1;
  entries.unshift(
    { name: '[Content_Types].xml', data: CONTENT_TYPES.replace('__SHEET_OVERRIDES__', overrides.join('\n')) },
    { name: '_rels/.rels', data: ROOT_RELS },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${workbookSheets.join('')}</sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${workbookRels.join('')}
<Relationship Id="rId${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES }
  );

  return createZip(entries);
}

module.exports = { buildWorkbook, escapeXml, colName, toSerialDate, STYLE };
