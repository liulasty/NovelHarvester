'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeQuery,
  foldTradToSimp,
  canonicalName,
  isHitText,
} = require('../gaode/lib/site-search-util.js');

test('normalizeQuery: 全角转半角/去全角空格/小写/去空白', () => {
  assert.strictEqual(normalizeQuery('　ＡＢＣ　d　'), 'abc d');
});

test('foldTradToSimp: 标题常见繁体转简体', () => {
  assert.strictEqual(foldTradToSimp('神女逍遙錄'), '神女逍遥录');
});

test('canonicalName: 组合归一（含繁体书名词条）', () => {
  assert.strictEqual(canonicalName('　神女逍遙錄　'), '神女逍遥录');
});

test('isHitText: 繁体标题可命中简体关键词', () => {
  assert.ok(isHitText('神女逍遙錄', '神女逍遥录'));
});

test('isHitText: 括号/副标后缀不影响命中', () => {
  assert.ok(isHitText('神女逍遥录（绿）', '神女逍遥录'));
});

test('isHitText: 空值安全', () => {
  assert.strictEqual(isHitText('', '神女逍遥录'), false);
  assert.strictEqual(isHitText('神女逍遥录', ''), false);
});

test('isHitText: 不相干书名不误报', () => {
  assert.strictEqual(isHitText('大漠谣', '神女逍遥录'), false);
});
