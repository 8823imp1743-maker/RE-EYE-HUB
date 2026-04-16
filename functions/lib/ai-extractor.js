/**
 * AI 抽出エンジン — Gemini による「目視代行」
 *
 * 「難しさのねじ伏せ方」
 *   これまでは regex が「26.5cm」という文字列を探していた。
 *   しかし商品タイトルには「US8.5」「26(US8)」「レディース 24.5」
 *   「サイズ：26.0・27.0・28.0」のように無限の表記パターンが存在する。
 *   Gemini はこれを「読む」。人間が Chrome を見て判断するように。
 *
 * 2つの武器:
 *
 *   1. aiSizeGenderMatch(itemTitle, keyword)
 *      商品タイトルとキーワードのサイズ・性別が一致するかを Gemini が判断する。
 *      regex が false を返した後の AI フォールバックとして呼ばれる。
 *
 *   2. generateVibeQueries(keyword, maxQueries)
 *      「監督が Chrome で検索している時と全く同じ検索クエリ」を Gemini が生成。
 *      品番・色（日英両方）・サイズ・性別・在庫意図ワードを最適に組み合わせる。
 *      これを楽天/Yahoo/Google Shopping に投げることで、
 *      Rakuten API が返さない専門店の在庫まで引っ張り出す。
 *
 * コスト管理:
 *   - 結果は Redis に TTL 1日でキャッシュ（同じ商品を何度も API に聞かない）
 *   - Gemini タイムアウト: サイズ判定 3秒 / Vibe クエリ 4秒
 *   - タイムアウト時は安全側（通過 / 元キーワードをそのまま使用）
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { createHash }         from 'crypto';
import { getRedis }           from './redis.js';
import { getGeminiModel }     from './plan-config.js';

const CACHE_TTL = 60 * 60 * 24; // 1日（同一商品への重複 API コールを防ぐ）

// ── キャッシュ付き Gemini 呼び出しラッパー ────────────────────────────────────
async function cachedCall(cacheKey, fn) {
  const r = getRedis();
  try {
    const cached = await r.get(cacheKey);
    if (cached !== null) return JSON.parse(cached);
  } catch { /* キャッシュミスはサイレント */ }

  const result = await fn();

  try { await r.set(cacheKey, JSON.stringify(result), { ex: CACHE_TTL }); } catch { /* ok */ }
  return result;
}

// ─────────────────────────────────────────────────────────
//  武器1: サイズ・性別 目視代行
// ─────────────────────────────────────────────────────────

/**
 * 商品タイトルとキーワードのサイズ・性別が一致するか Gemini が判断する。
 *
 * 呼び出しタイミング:
 *   validateSizeMatch() (regex) が false を返した後のフォールバック。
 *   regex で「26.5cm」が見つからなくても、Gemini が
 *   「US8.5 = 26.5cm、これは一致」と判断できる。
 *
 * 例:
 *   itemTitle: "Nike Air Force 1 '07 LV8 レディース US6.5 Celeste/White"
 *   keyword:   "ナイキ エアフォース1 水色 24.5cm"
 *   → match: true  reason: "US6.5=24.5cm 一致"
 *
 * @param {string} itemTitle
 * @param {string} keyword
 * @returns {Promise<{ match: boolean, reason: string }>}
 */
export async function aiSizeGenderMatch(itemTitle, keyword) {
  if (!process.env.GEMINI_API_KEY || !itemTitle || !keyword) {
    return { match: true, reason: 'AI未設定→通過' };
  }

  const cacheKey = `ai:size:${createHash('sha256')
    .update(`${keyword}:${itemTitle.slice(0, 80)}`)
    .digest('hex')
    .slice(0, 16)}`;

  return cachedCall(cacheKey, async () => {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: getGeminiModel(),
        generationConfig: { maxOutputTokens: 60, temperature: 0 },
      });

      const prompt =
        `ユーザーキーワード: "${keyword}"\n` +
        `商品タイトル: "${itemTitle.slice(0, 150)}"\n\n` +
        `このタイトルの商品はユーザーが探しているサイズ・性別と一致しますか？\n` +
        `判定ルール:\n` +
        `- US サイズは cm に変換して比較（US6.5=24.5cm, US8=26cm, US8.5=26.5cm, US9=27cm 等）\n` +
        `- mm 表記も変換（265mm=26.5cm）\n` +
        `- 性別: レディース/Women/W が片方にだけあれば不一致。両方ある、または片方にしかなければ一致\n` +
        `- サイズ・性別の指定がキーワードにない場合は match:true\n` +
        `JSON のみで回答: {"match": true/false, "reason": "理由15字以内"}`;

      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      const text   = result.response.text().trim().replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(text);
      const out    = { match: Boolean(parsed.match), reason: parsed.reason || '' };

      console.log(
        `[ai-extractor] サイズ性別判定: match=${out.match} reason="${out.reason}"` +
        ` title="${itemTitle.slice(0, 40)}"`
      );
      return out;
    } catch(e) {
      console.warn('[ai-extractor] サイズ判定失敗:', e.message);
      return { match: true, reason: 'AI失敗→通過' }; // タイムアウト時は通過（見逃しより誤検知回避）
    }
  });
}

// ─────────────────────────────────────────────────────────
//  武器1.5: 4軸完全目視代行（品番 + 色 + サイズ + 性別）
// ─────────────────────────────────────────────────────────

/**
 * 新着商品を「品番・色・サイズ・性別」の4軸で完全検証する。
 *
 * 「どれ一つ欠けてもゴミ」の哲学を実装する関数。
 * checkAndNotifySerp() で新着URL検知後の最終確認に使用。
 *
 * @param {string} itemTitle
 * @param {string} keyword
 * @param {{ modelNumbers?: string[], colorKeywords?: string[] }} registeredInfo
 * @returns {Promise<{ pass: boolean, reason: string }>}
 */
export async function aiItemVerify(itemTitle, keyword, registeredInfo = {}) {
  if (!process.env.GEMINI_API_KEY || !itemTitle || !keyword) {
    return { pass: true, reason: 'AI未設定→通過' };
  }

  const { modelNumbers = [], colorKeywords = [] } = registeredInfo;

  const cacheKey = `ai:verify:${createHash('sha256')
    .update(`${keyword}:${itemTitle.slice(0, 80)}`)
    .digest('hex')
    .slice(0, 16)}`;

  return cachedCall(cacheKey, async () => {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: getGeminiModel(),
        generationConfig: { maxOutputTokens: 80, temperature: 0 },
      });

      const modelStr = modelNumbers.length > 0 ? `品番: ${modelNumbers.join(', ')}` : '品番: 指定なし（スキップ）';
      const colorStr = colorKeywords.length > 0 ? `色: ${colorKeywords.join(', ')}` : '色: 指定なし（スキップ）';

      const prompt =
        `ユーザーが探している商品:\n` +
        `  キーワード: "${keyword}"\n` +
        `  ${modelStr}\n` +
        `  ${colorStr}\n\n` +
        `ヒットした商品タイトル: "${itemTitle.slice(0, 150)}"\n\n` +
        `以下の4軸を確認し、指定のある全軸が一致する場合のみ pass:true:\n` +
        `  軸1 品番: タイトルに品番（ハイフン以下含む完全一致）が含まれるか\n` +
        `  軸2 色:   水色=celeste=light blue=ライトブルー等を同一視して判定\n` +
        `  軸3 サイズ: US/cm/mm の表記ゆれ吸収（US8=26cm=260mm、±0.5cm許容）\n` +
        `  軸4 性別: Women's/レディース/Men's/メンズ等を文脈で判定\n` +
        `指定なし軸は自動で一致扱い。\n` +
        `JSON のみ: {"pass": true/false, "reason": "不一致軸の理由20字以内"}`;

      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500)),
      ]);
      const text   = result.response.text().trim().replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(text);
      const out    = { pass: Boolean(parsed.pass), reason: parsed.reason || '' };

      console.log(
        `[ai-extractor] 4軸検証: pass=${out.pass}` +
        (out.reason ? ` reason="${out.reason}"` : ' (全軸一致)') +
        ` title="${itemTitle.slice(0, 40)}"`
      );
      return out;
    } catch(e) {
      console.warn('[ai-extractor] 4軸検証失敗:', e.message);
      return { pass: true, reason: 'AI失敗→通過' };
    }
  });
}

// ─────────────────────────────────────────────────────────
//  武器2: Vibe クエリ生成（Chrome と同じ検索）
// ─────────────────────────────────────────────────────────

/**
 * 「監督が Chrome で打つような検索クエリ」を Gemini が生成する。
 *
 * 単純な regex 展開では生まれない「知恵のあるクエリ」を生成：
 *   - 品番（型番）を軸にした検索
 *   - 色の日英両表記を混在（水色→Celeste/light blue）
 *   - サイズの表記ゆれを吸収（26.5cm → US8.5）
 *   - 性別・カテゴリ文脈の付加
 *   - 中古・転売排除語の自動挿入
 *
 * 例:
 *   keyword: "ナイキ エアフォース1 水色 26.5cm"
 *   → [
 *       "Nike Air Force 1 Celeste 26.5cm US8.5 在庫 新品 -メルカリ",
 *       "ナイキ エアフォース1 ライトブルー 26.5 in stock -ヤフオク",
 *     ]
 *
 * @param {string} keyword
 * @param {number} maxQueries  生成クエリ数（デフォルト2 — API コスト考慮）
 * @returns {Promise<string[]>}
 */
export async function generateVibeQueries(keyword, maxQueries = 2) {
  if (!process.env.GEMINI_API_KEY || !keyword) return [keyword];

  const cacheKey = `ai:vibe:${createHash('sha256').update(keyword).digest('hex').slice(0, 16)}`;

  return cachedCall(cacheKey, async () => {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: getGeminiModel(),
        generationConfig: { maxOutputTokens: 250, temperature: 0.3 },
      });

      const prompt =
        `あなたは日本のスニーカー・ファッション通販に精通したバイヤーです。\n` +
        `以下のキーワードで在庫を探すとき、Google に入力する最も効果的な検索クエリを ` +
        `${maxQueries} 種類生成してください。\n\n` +
        `ルール:\n` +
        `- 品番・型番（例: CW2288-111）があれば必ず含める\n` +
        `- 色は日本語と英語の両方を試す（水色→Celeste/light blue 等）\n` +
        `- サイズは cm と US サイズ両方を書く（26.5cm → US8.5）\n` +
        `- 性別があれば日英で書く（レディース → Women's）\n` +
        `- 「在庫 新品 購入」等の購買意図ワードを含める\n` +
        `- 中古・転売排除: -メルカリ -ヤフオク -中古 -USED を末尾に付ける\n` +
        `- クエリはシンプルに（50字以内）\n\n` +
        `キーワード: "${keyword}"\n\n` +
        `JSON 配列のみで回答（説明不要）: ["クエリ1", "クエリ2"]`;

      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
      const text    = result.response.text().trim().replace(/```json|```/g, '').trim();
      const queries = JSON.parse(text);

      if (Array.isArray(queries) && queries.length > 0) {
        const out = queries.filter(q => typeof q === 'string' && q.length > 0).slice(0, maxQueries);
        console.log(
          `[ai-extractor] Vibe クエリ生成 ${out.length}件:` +
          ` "${out[0]?.slice(0, 60)}"`
        );
        return out;
      }
      return [keyword];
    } catch(e) {
      console.warn('[ai-extractor] Vibe クエリ生成失敗:', e.message);
      return [keyword];
    }
  });
}
