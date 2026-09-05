/**
 * 跨站书名搜索 —— 纯文本归一 / 命中判定（无网络依赖，可用 node --test 单测）。
 * 只用于“判断命中”，不改变站点原文输出。
 */

/** 书名标题中最常见的繁体字 → 简体（命中判定用；遇生字补此表即可，勿动输出） */
const TRAD_TO_SIMP = {
  '遙': '遥', '錄': '录', '遊': '游', '傳': '传', '劍': '剑', '龍': '龙', '鳳': '凤',
  '陽': '阳', '陰': '阴', '塵': '尘', '靈': '灵', '緣': '缘', '夢': '梦', '戀': '恋',
  '戰': '战', '華': '华', '萬': '万', '門': '门', '書': '书', '長': '长', '東': '东',
  '後': '后', '裡': '里', '為': '为', '與': '与', '無': '无', '時': '时', '個': '个',
  '們': '们', '麼': '么', '師': '师', '軍': '军', '見': '见', '來': '来', '風': '风',
  '雲': '云', '節': '节', '變': '变', '說': '说', '還': '还', '這': '这', '樣': '样',
  '點': '点', '實': '实', '當': '当', '條': '条', '體': '体', '會': '会', '間': '间',
  '雙': '双', '將': '将', '兒': '儿', '種': '种', '總': '总', '聖': '圣', '歷': '历',
  '歸': '归', '曉': '晓', '鄉': '乡', '發': '发', '國': '国', '愛': '爱', '強': '强',
};

/** 全角→半角、全角空格→半角、压缩空白、去首尾、小写（字母部分） */
function normalizeQuery(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 逐字繁体→简体（未收录字原样返回） */
function foldTradToSimp(s) {
  return String(s == null ? '' : s)
    .split('')
    .map((ch) => TRAD_TO_SIMP[ch] || ch)
    .join('');
}

/** 命中用规范形：先规范化再折简体（结果仅用于比较） */
function canonicalName(s) {
  return normalizeQuery(foldTradToSimp(normalizeQuery(s)));
}

/** title 是否命中书名 keyword（繁/简、全/半角、括号后缀均算命中） */
function isHitText(title, keyword) {
  const t = canonicalName(title);
  const kw = canonicalName(keyword);
  if (!t || !kw) return false;
  return t.includes(kw);
}

module.exports = { normalizeQuery, foldTradToSimp, canonicalName, isHitText };
