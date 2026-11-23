// 极简 RFC 4180 风格 CSV 解析：支持引号包裹、引号转义与 CRLF。
// 来源文件是不可信数据，这里只做解析，不执行任何内容。
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n') {
      pushRow();
    } else if (char === '\r') {
      // 吞掉 CR，由随后的 LF 收尾
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  const nonEmpty = rows.filter(cells => cells.some(cell => cell.trim() !== ''));
  if (nonEmpty.length === 0) return { fields: [], records: [] };
  const fields = nonEmpty[0];
  const records = nonEmpty.slice(1).map(cells => {
    const record = {};
    fields.forEach((name, index) => {
      record[name] = cells[index] ?? '';
    });
    return record;
  });
  return { fields, records };
}

// split 列：空字符串表示整行；否则形如 "18-20:230|20-22:220"。
export function parseSplit(splitText) {
  const text = (splitText ?? '').trim();
  if (text === '') return null;
  return text.split('|').map(piece => {
    const match = piece.match(/^(\d+)-(\d+):(\d+)$/);
    if (!match) throw new Error(`无法识别的分段表达：${piece}`);
    const [, start, end, amount] = match;
    return { start: Number(start), end: Number(end), amount: Number(amount) };
  });
}
