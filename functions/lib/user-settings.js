/**
 * ユーザー設定（マイサイズ等）の保存・取得ヘルパー
 *
 * 目的:
 * - poll.js 等が「検索のたびにサイズ入力」せずに済むようにする
 * - 監視エントリ（WATCH_TTL）とは独立した長期設定として保持する
 *
 * 利用者の隔離（A の地域・足長と B の混在なし）:
 * - 永続化は常に**サニタイズ済み userId 1 本**に紐づく単一キー `user:settings:{userId}` のみ。地理・cm・子はその JSON 内のフィールド。
 *   グローバル共有・全ユーザー共通の「デフォルト都道府県/サイズ」は**存在しない**（POST の merge 先も同じキーだけ）。
 * - 正: Redis（API POST で merge + sanitize 済み行を永続化）
 * - クライアント: `POST /api/user-settings` 成功直後、レスポンスの `settings` で `userProfile` と
 *   `localStorage.re_eye_profile` を同じ形で更新する（index.html 側。世代ロックで競合低減）
 * - search / scout / monitor は毎回 `loadUserSettings` で Redis から読み、**保存完了後の**次の API 呼び出しから
 *   新ターゲットが効く（オンメモリ永続キャッシュは user-size 側に無し）
 *
 * 巻き戻し（クライアント）:
 * - 明示保存: `saveUserSettings(true)` が **保存直前**の `userProfile` 深いコピー (snap) を唯一の正とし、
 *   `POST` 失敗・`fetch` 例外のいずれでも `applyUserSettingsSnapshot(snapP, snapPr)` へ集約。大人3行＋子3行
 *   は `setChipRowFromSnapshotValue` で、空の選択も含め `snap` 通りに復元（index.html）。
 *
 * スキーマ（1 利用者=1 キー内の 1 JSON）: shoeCm, clothing, numeric, prefecture, glovesSml, childGender, childClothSize, childShoeSize, childGlovesSml。
 * いずれも**当該 userId 専用**。**特定個人名や特定地域・cm のデフォルト固定値はコードに存在しない**（値は全て利用者入力／Redis 由来）。
 */
 
export const USER_SETTINGS_SCHEMA_VERSION = 1;
export const USER_SETTINGS_TTL_SEC = 60 * 60 * 24 * 90; // 90日（trend と同等）
 
/**
 * @param {string} userId
 */
export function userSettingsKey(userId) {
  return `user:settings:${userId}`;
}
 
/**
 * @param {any} uid
 * @returns {string|null}
 */
export function sanitizeUserId(uid) {
  if (!uid || typeof uid !== 'string') return null;
  if (!/^u_[a-z0-9]{6,32}$/i.test(uid)) return null;
  return uid;
}
 
const CLOTHING_ALLOWED = new Set([
  'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL',
]);

/** 手袋・小物（大人・子ども共通で S / M / L のみ。服の SML とは別キー） */
const GLOVES_SML_ALLOWED = new Set(['S', 'M', 'L']);

/** 子ども服（index.html チップと一致） */
const CHILD_CLOTH_ALLOWED = new Set([
  '80', '90', '100', '110', '120', '130', '140', '150', '160',
]);

const CHILD_GENDER_ALLOWED = new Set(['boy', 'girl']);

/** 子ども靴 cm: 10.0〜22.0（1桁）、UI チップと整合 */
const CHILD_SHOE_MIN = 10.0;
const CHILD_SHOE_MAX = 22.0;

/** 都道府県（保存値＝正式名称のみ） */
const JP_PREFECTURE_FORMAL = new Set([
  '北海道',
  '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
]);
 
function round1(n) {
  return Math.round(n * 10) / 10;
}
 
/**
 * 入力（POST body）から設定を正規化する。
 *
 * @param {any} body
 * @returns {{
 *   schemaVersion: number,
 *   shoeCm: number|null,
 *   clothing: string|null,
 *   numeric: number|null,
 *   prefecture: string|null,
 *   childGender: string|null,
 *   childClothSize: string|null,
 *   childShoeSize: string|null,
 *   glovesSml: string|null,
 *   childGlovesSml: string|null,
 *   updatedAt: number
 * }}
 */
function normalizeGlovesSml(raw) {
  if (raw == null || raw === '') return null;
  const c = String(raw).trim().toUpperCase();
  if (GLOVES_SML_ALLOWED.has(c)) return c;
  return null;
}

function normalizeChildShoeString(raw) {
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/cm$/i, '').trim());
  if (!Number.isFinite(n)) return null;
  const r = round1(n);
  if (r < CHILD_SHOE_MIN || r > CHILD_SHOE_MAX) return null;
  return r.toFixed(1);
}

export function normalizeUserSettings(body) {
  const src = (body && typeof body === 'object') ? body : {};
 
  // shoeCm: 20.0〜35.0（小数1桁まで）
  let shoeCm = null;
  if (src.shoeCm != null && src.shoeCm !== '') {
    const n = Number(src.shoeCm);
    if (Number.isFinite(n)) {
      const r = round1(n);
      if (r >= 20.0 && r <= 35.0) shoeCm = r;
    }
  }
 
  // clothing: 許可リスト（大文字正規化）
  let clothing = null;
  if (src.clothing != null && src.clothing !== '') {
    const c = String(src.clothing).trim().toUpperCase().replace(/\s+/g, '');
    if (CLOTHING_ALLOWED.has(c)) clothing = c;
  }
 
  // numeric: 20〜60（整数）
  let numeric = null;
  if (src.numeric != null && src.numeric !== '') {
    const n = Number(src.numeric);
    if (Number.isFinite(n)) {
      const i = Math.round(n);
      if (i >= 20 && i <= 60) numeric = i;
    }
  }

  // prefecture: 正式名のみ
  let prefecture = null;
  if (src.prefecture != null && src.prefecture !== '') {
    const p = String(src.prefecture).trim();
    if (JP_PREFECTURE_FORMAL.has(p)) prefecture = p;
  }

  let childGender = null;
  if (src.childGender != null && src.childGender !== '') {
    const g = String(src.childGender).toLowerCase().trim();
    if (CHILD_GENDER_ALLOWED.has(g)) childGender = g;
  }

  let childClothSize = null;
  if (src.childClothSize != null && src.childClothSize !== '') {
    const c = String(src.childClothSize).trim();
    if (CHILD_CLOTH_ALLOWED.has(c)) childClothSize = c;
  }

  const childShoeSize = normalizeChildShoeString(src.childShoeSize);
  const glovesSml = normalizeGlovesSml(src.glovesSml);
  const childGlovesSml = normalizeGlovesSml(src.childGlovesSml);
 
  return {
    schemaVersion: USER_SETTINGS_SCHEMA_VERSION,
    shoeCm,
    clothing,
    numeric,
    prefecture,
    glovesSml,
    childGender,
    childClothSize,
    childShoeSize,
    childGlovesSml,
    updatedAt: Date.now(),
  };
}
 
/**
 * Redis から読んだ値を安全に整形する（欠損・型崩れに耐える）。
 * @param {any} raw
 */
export function sanitizeStoredUserSettings(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return null;
 
  const shoeCm =
    typeof obj.shoeCm === 'number' && Number.isFinite(obj.shoeCm)
      ? round1(obj.shoeCm)
      : null;
 
  const clothing =
    typeof obj.clothing === 'string' && CLOTHING_ALLOWED.has(obj.clothing.toUpperCase())
      ? obj.clothing.toUpperCase()
      : null;
 
  const numeric =
    typeof obj.numeric === 'number' && Number.isFinite(obj.numeric)
      ? Math.round(obj.numeric)
      : null;
 
  const updatedAt =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt)
      ? Math.round(obj.updatedAt)
      : 0;

  const prefectureRaw = typeof obj.prefecture === 'string' ? obj.prefecture.trim() : '';
  const prefecture = JP_PREFECTURE_FORMAL.has(prefectureRaw) ? prefectureRaw : null;

  let childGender = null;
  if (obj.childGender != null && obj.childGender !== '') {
    const g = String(obj.childGender).toLowerCase().trim();
    if (CHILD_GENDER_ALLOWED.has(g)) childGender = g;
  }

  let childClothSize = null;
  if (obj.childClothSize != null && obj.childClothSize !== '') {
    const c = String(obj.childClothSize).trim();
    if (CHILD_CLOTH_ALLOWED.has(c)) childClothSize = c;
  }

  const childShoeSize = normalizeChildShoeString(obj.childShoeSize);
 
  const glovesSml = normalizeGlovesSml(obj.glovesSml);
  const childGlovesSml = normalizeGlovesSml(obj.childGlovesSml);
 
  return {
    schemaVersion: USER_SETTINGS_SCHEMA_VERSION,
    shoeCm,
    clothing,
    numeric,
    prefecture,
    glovesSml,
    childGender,
    childClothSize,
    childShoeSize,
    childGlovesSml,
    updatedAt,
  };
}
