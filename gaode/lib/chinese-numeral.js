/**
 * 中文数字 → 整数（章标题排序等场景共用）。
 * 将「九百八十八」「两千零二」「一」等转为整数；无法解析则 NaN。
 */

const CN_DIGIT = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function chineseNumeralToInt(str) {
  const s = String(str || '')
    .replace(/\s+/g, '')
    .replace(/廿/g, '二十')
    .replace(/卅/g, '三十');
  if (!s) return NaN;
  let total = 0;
  const wanParts = s.split('万');
  const high = wanParts.length > 1 ? wanParts[0] : '';
  const low = wanParts.length > 1 ? wanParts.slice(1).join('万') : s;
  const parseSection = (sec) => {
    if (!sec) return 0;
    let n = 0;
    let tmp = 0;
    for (let i = 0; i < sec.length; i++) {
      const c = sec[i];
      if (CN_DIGIT[c] !== undefined) {
        tmp = CN_DIGIT[c];
        continue;
      }
      if (c === '十') {
        n += (tmp || 1) * 10;
        tmp = 0;
      } else if (c === '百') {
        n += (tmp || 1) * 100;
        tmp = 0;
      } else if (c === '千') {
        n += (tmp || 1) * 1000;
        tmp = 0;
      } else {
        return NaN;
      }
    }
    return n + tmp;
  };
  if (high) {
    const w = parseSection(high);
    if (Number.isNaN(w)) return NaN;
    total = w * 10000;
  }
  const lowVal = parseSection(low);
  if (Number.isNaN(lowVal)) return NaN;
  return total + lowVal;
}

module.exports = { chineseNumeralToInt };
