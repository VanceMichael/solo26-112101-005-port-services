// 演练日内全部为整数小时，所有区间含起不含止（[start, end)）。
export function segmentLabel(start, end) {
  return `${start}-${end}`;
}

export function parseSegmentLabel(label) {
  const match = /^(\d+)-(\d+)$/.exec(label);
  if (!match) throw new Error(`无法识别的半开时间段：${label}`);
  return { start: Number(match[1]), end: Number(match[2]) };
}

// 内层区间 [start,end) 是否完全落在授权窗 [from,until) 内。
export function contained(start, end, auth) {
  return auth.from <= start && end <= auth.until;
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}
