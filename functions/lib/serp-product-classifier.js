/**
 * FINAL SPEC v3.1 — serpFilter 専用
 * SERP=汚染候補 / LLM=意味（バッチ1回）/ スコア=§5のみ / PDP=在庫真実は monitor 側
 */

import { createHash } from 'crypto';
import { getCeFeedbackPromptNudge } from './ce-feedback.js';

/** v5.0 §3 ノイズ（ローカル：LLM プロンプトに列挙し意味判定を補助。スコア式 §5 には含めない） */
export const NOISE_KEYWORDS = [
  'ケース',
  'カバー',
  'ストラップ',
  'インソール',
  'ヒールプロテクター',
  '空容器',
  '詰め替え',
  'SEO',
  '互換',
  '偽物',
];

function localNoisePromptBlock() {
  return `ローカルノイズ語（タイトルに含まれる場合は本体ではない可能性が高い。参考にし、category/product_role を決める）:\n${NOISE_KEYWORDS.map((w) => `- ${w}`).join('\n')}`;
}

/** ヒューリスティック補助（バッチ失敗時・穴埋め） */
export const SERP_CATEGORY_RULES = {
  shoe: {
    include: ['エアジョーダン', 'ナイキスニーカー', 'ダンク', 'スニーカー', 'シューズ', 'ナイキ', 'NIKE'],
    exclude: ['インソール', 'ヒールプロテクター', 'プロテクター'],
  },
  clothing: {
    include: [
      'ジャケット',
      'コート',
      'ニット',
      'シャツ',
      'パンツ',
      'スカート',
      '服',
      'アウター',
      'tシャツ',
      'ワンピース',
      'トップス',
      'デニム',
      'パーカー',
      'フーディ',
      'パーカ',
      'hoodie',
      'sweat',
      'スウェット',
      'トレーナー',
      'カーディガン',
      'ベスト',
      'ジーンズ',
      'ブルゾン',
      'ダウンジャケット',
    ],
    exclude: [
      'スニーカー',
      'シューズ',
      '靴',
      'ダンク',
      'ジョーダン',
      'sneaker',
      'sneakers',
      'boot',
      'sandals',
      'サンダル',
      'ブーツ',
    ],
  },
  sticker: {
    include: ['ボンボンドロップシール', 'ボンボンドロップ', 'キャラクターシール', 'シール', 'ステッカー'],
    exclude: ['ケース', 'ファイル', '台紙のみ', '台紙だけ'],
  },
  bag: {
    include: ['バッグ', 'トート', 'リュック'],
    exclude: ['ストラップ', '保存袋', '付属ケース'],
  },
  cosmetics: {
    include: ['リップ', 'ファンデ', '化粧'],
    exclude: ['空容器', '詰め替え'],
  },
};

const GEMINI_MODEL =
  process.env.RE_EYE_SERP_CLASSIFIER_MODEL || 'gemini-2.0-flash';

function normalizeGender(g) {
  const x = String(g || '')
    .trim()
    .toLowerCase();
  if (x === 'male' || x === 'men' || x === 'mens' || x === 'boy') return 'male';
  if (x === 'female' || x === 'women' || x === 'womens' || x === 'girl') return 'female';
  if (x === 'unisex' || x === 'ユニセックス') return 'unisex';
  return 'unknown';
}

/** @param {string} userGender male|female|unknown */
/** @param {string} productGender */
export function genderScoreAdjustment(userGender, productGender) {
  const u = normalizeGender(userGender);
  const p = normalizeGender(productGender);
  if (!p || p === 'unknown' || p === 'unisex') return 0;
  if (u === 'unknown') return 0;
  if (u === p) return 0.4;
  if (u === 'male' && p === 'female') return -0.8;
  if (u === 'female' && p === 'male') return -0.8;
  return 0;
}

/** ヒューリスティックはタイトルのみ（description はノイズ扱い・§11） */
function titleForHeuristic(item) {
  return String(item?.title || '')
    .toLowerCase()
    .slice(0, 2000);
}

/**
 * @param {object} item SERP 行
 * @returns {{ category: string, product_role: string, gender: string, confidence: number }}
 */
export function classifySerpItemHeuristic(item) {
  const tl = titleForHeuristic(item);
  let category = 'other';
  let product_role = 'unknown';
  let confidence = 0.45;

  const hit = (arr) => arr.some((w) => tl.includes(String(w).toLowerCase()));

  if (hit(SERP_CATEGORY_RULES.shoe.exclude)) {
    product_role = 'accessory';
    category = 'shoe';
    confidence = 0.55;
  } else if (hit(SERP_CATEGORY_RULES.sticker.exclude)) {
    product_role = 'packaging';
    category = 'sticker';
    confidence = 0.55;
  } else if (hit(SERP_CATEGORY_RULES.bag.exclude)) {
    product_role = 'accessory';
    category = 'bag';
    confidence = 0.52;
  } else if (hit(SERP_CATEGORY_RULES.cosmetics.exclude)) {
    product_role = 'packaging';
    category = 'cosmetics';
    confidence = 0.55;
  }

  if (product_role === 'unknown') {
    if (hit(SERP_CATEGORY_RULES.shoe.include)) {
      category = 'shoe';
      product_role = 'main';
      confidence = 0.58;
    } else if (
      hit(SERP_CATEGORY_RULES.clothing.include) &&
      !hit(SERP_CATEGORY_RULES.clothing.exclude)
    ) {
      category = 'clothing';
      product_role = 'main';
      confidence = 0.55;
    } else if (hit(SERP_CATEGORY_RULES.sticker.include)) {
      category = 'sticker';
      product_role = 'main';
      confidence = 0.55;
    } else if (hit(SERP_CATEGORY_RULES.bag.include)) {
      category = 'bag';
      product_role = 'main';
      confidence = 0.52;
    } else if (hit(SERP_CATEGORY_RULES.cosmetics.include)) {
      category = 'cosmetics';
      product_role = 'main';
      confidence = 0.52;
    }
  }

  let gender = 'unisex';
  if (/\b(men|mens|male|メンズ|男性)\b/i.test(tl)) gender = 'male';
  else if (/\b(women|womens|female|レディース|女性)\b/i.test(tl)) gender = 'female';

  return { category, product_role, gender, confidence };
}

/**
 * v3.1 §5 のみ（main/confidence/gender ± / accessory/packaging/fake）。tool・unknown は加点なし。
 * 第3引数は後方互換のため残す（未使用）。
 * @param {object} row LLM or heuristic
 * @param {string} userGender
 */
export function scoreSerpClassification(row, userGender, _titleLower) {
  let score = 0;
  const role = String(row.product_role || 'unknown');
  if (role === 'main') score += 0.4;
  else if (role === 'accessory') score -= 0.6;
  else if (role === 'packaging') score -= 0.7;
  else if (role === 'fake') score -= 1.0;

  score += genderScoreAdjustment(userGender, row.gender);
  const c = Number(row.confidence);
  if (Number.isFinite(c)) score += Math.max(0, Math.min(1, c));
  return Math.round(score * 1000) / 1000;
}

function extractJsonObject(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** LLM 出力を v5 の6値に正規化（未対応トークンのみ other） */
const SERP_V5_CATEGORIES = new Set(['shoe', 'clothing', 'sticker', 'bag', 'cosmetics', 'other']);

function coerceSerpV5CategoryFromLlm(raw) {
  const c = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (SERP_V5_CATEGORIES.has(c)) return c;
  if (/^(apparel|tops|bottoms)$/.test(c)) return 'clothing';
  if (c === 'アパレル' || c === 'ウェア' || c === 'ウェアー') return 'clothing';
  if (c === 'sneaker' || c === 'sneakers' || c === 'kicks') return 'shoe';
  return 'other';
}

function normalizeRow(obj) {
  return {
    category: coerceSerpV5CategoryFromLlm(obj?.category),
    product_role: String(obj?.product_role || 'unknown'),
    gender: String(obj?.gender || 'unknown'),
    confidence: Number.isFinite(Number(obj?.confidence))
      ? Math.max(0, Math.min(1, Number(obj.confidence)))
      : 0.5,
  };
}

/**
 * v3.1 §4: SERP 最大10件を **1 回の LLM** で分類。キー無しはヒューリスティックを行単位で適用。
 * @param {object[]} items
 * @returns {Promise<Array<{ category: string, product_role: string, gender: string, confidence: number }>>}
 */
export async function classifySerpItemsBatch(items) {
  const list = [];
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length && i < 10; i++) list.push(items[i]);
  }
  if (list.length === 0) return [];

  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) {
    return list.map((item) => classifySerpItemHeuristic(item));
  }

  const payload = list.map((item, index) => ({
    index,
    title: String(item?.title || '').slice(0, 400),
    price: Number(item?.price) || 0,
    shop: String(item?.shopName || item?.seller || item?.sourceId || '').slice(0, 120),
  }));

  let ceOpsNudge = '';
  try {
    ceOpsNudge = await getCeFeedbackPromptNudge();
  } catch {
    ceOpsNudge = '';
  }
  const ceBlock =
    ceOpsNudge && ceOpsNudge.trim()
      ? `\n\n【運用蓄積・CE却下からのフィードバック（参考。SERP本文の断定は禁止）】\n${ceOpsNudge.trim()}\n`
      : '';

  const prompt = `あなたは商品実体判定エンジン。

SERPから本体商品のみ抽出する。

禁止：
- パーツ
- ケース
- 偽物
- SEO商品

必須：
- category
- product_role
- gender
- confidence

ルール：
- SERPは信用しない
- descriptionはノイズ
- 実体のみ評価

${localNoisePromptBlock()}${ceBlock}

入力（JSON配列・title のみ主に評価）:
${JSON.stringify(payload)}

出力は JSON のみ。形は厳守:
{"items":[{"index":0,"category":"shoe|clothing|sticker|bag|cosmetics|other","product_role":"main|accessory|packaging|tool|fake|unknown","gender":"male|female|unisex|unknown","confidence":0から1の数値}, ...]}
category は必ず上記6語のいずれかのみ。衣類は clothing を用い、other への逃げをしないこと。
index は入力と同じ順で ${list.length} 件すべて含めること。`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) {
      console.warn('[serp-classifier] batch Gemini HTTP', res.status, raw.slice(0, 200));
      return list.map((item) => classifySerpItemHeuristic(item));
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return list.map((item) => classifySerpItemHeuristic(item));
    }
    const text =
      parsed?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    const obj = extractJsonObject(text);
    const arr = obj && Array.isArray(obj.items) ? obj.items : null;
    if (!arr || arr.length === 0) {
      return list.map((item) => classifySerpItemHeuristic(item));
    }
    const byIndex = new Map();
    for (const it of arr) {
      const ix = Number(it?.index);
      if (Number.isFinite(ix) && ix >= 0 && ix < list.length) {
        byIndex.set(ix, normalizeRow(it));
      }
    }
    return list.map((item, i) => byIndex.get(i) || classifySerpItemHeuristic(item));
  } catch (e) {
    console.warn('[serp-classifier] batch', e.message);
    return list.map((item) => classifySerpItemHeuristic(item));
  }
}

/**
 * 単体（後方互換・テスト用）
 * @param {object} item
 */
export async function classifySerpItemWithGemini(item) {
  const rows = await classifySerpItemsBatch([item]);
  return rows[0] || classifySerpItemHeuristic(item);
}

/** v3.1 キャッシュ（keyword + gender + パイプライン世代） */
export function browseCacheKey(userId, keyword, userGender = 'unknown') {
  const h = createHash('sha256')
    .update(`${String(keyword)}\0${String(userGender)}\0v5.1-cefb`)
    .digest('hex')
    .slice(0, 40);
  return `monbrowse:v3:${userId}:${h}`;
}
