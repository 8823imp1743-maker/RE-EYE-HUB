/**
 * CONTRADICTION ENGINE（vFINAL）
 * SERP・LLM は仮説、PDP は物理真値。矛盾のみ検出し accept / reject / retry を返す。
 */

function normalizeGenderToken(g) {
  const x = String(g || '')
    .trim()
    .toLowerCase();
  if (x === 'male' || x === 'men' || x === 'mens' || x === 'boy') return 'male';
  if (x === 'female' || x === 'women' || x === 'womens' || x === 'girl') return 'female';
  if (x === 'unisex' || x === 'ユニセックス') return 'unisex';
  return 'unknown';
}

/**
 * @param {string} userGender male|female|unknown
 * @param {string} productGender LLM 行の gender
 */
export function computeGenderMatch(userGender, productGender) {
  const ug = normalizeGenderToken(userGender);
  const pg = normalizeGenderToken(productGender);
  if (ug !== 'male' && ug !== 'female') return true;
  if (pg === 'unisex' || pg === 'unknown') return true;
  if (pg === 'male' || pg === 'female') return ug === pg;
  return true;
}

/**
 * @param {object} input
 * @param {string} [input.llmCategory]
 * @param {number} [input.llmConfidence]
 * @param {boolean} [input.serpStrongMatch] SERP 錨・強一致（SERP汚染検出用）
 * @param {'on'|'off'} input.pdpResult PDP dom_structural 相当の on/off
 * @param {boolean} [input.pdpRetryable]
 * @param {string} [input.pdpReason]
 * @param {string} [input.userGender]
 * @param {string} [input.productGender]
 * @param {string} [input.productRole]
 */
export function evaluateContradictionEngine(input) {
  const flags = [];
  let confidencePenalty = 0;

  const cat = String(input.llmCategory || 'other');
  const conf = Number(input.llmConfidence);
  const c = Number.isFinite(conf) ? conf : 0;
  const pdpOn = input.pdpResult === 'on';
  const serpStrong = !!input.serpStrongMatch;
  const retryable = !!input.pdpRetryable;
  const pdpReason = String(input.pdpReason || '');

  const userGender = String(input.userGender || 'unknown');
  const productGender = String(input.productGender || 'unknown');
  const genderMatch = computeGenderMatch(userGender, productGender);

  if (!pdpOn && retryable && pdpReason === 'fetch_fail_strict') {
    return {
      status: 'retry',
      reason: 'pdp_fetch_retryable',
      confidencePenalty: 0,
      flags: ['pdp_fetch_retryable'],
      genderMatch,
    };
  }

  if (!pdpOn) {
    if (c > 0.85) {
      flags.push('LLM過信エラー');
      confidencePenalty += 0.15;
    }
    if (cat === 'shoe') {
      flags.push('構造矛盾');
      confidencePenalty += 0.15;
    }
    if (serpStrong) {
      flags.push('SERP汚染検出');
      confidencePenalty += 0.15;
    }
    if (flags.length > 0) {
      return {
        status: 'reject',
        reason: flags.join(' · '),
        confidencePenalty: Math.min(0.9, confidencePenalty),
        flags,
        genderMatch,
      };
    }
    return { status: 'accept', reason: '', confidencePenalty: 0, flags: [], genderMatch };
  }

  const role = String(input.productRole || 'unknown');
  /** FINAL LOCK: accessory と購入構造 PDP 真は両立しない（本体以外） */
  if (role === 'accessory' && pdpOn) {
    return {
      status: 'reject',
      reason: 'アクセサリ分類×PDP購入構造成立（本体不一致）',
      confidencePenalty: 0.2,
      flags: ['accessory_pdp_true'],
      genderMatch,
    };
  }
  /** FINAL LOCK: packaging と購入構造 PDP 真は両立しない */
  if (role === 'packaging' && pdpOn) {
    return {
      status: 'reject',
      reason: '梱包分類×PDP購入構造成立（本体不一致）',
      confidencePenalty: 0.2,
      flags: ['packaging_pdp_true'],
      genderMatch,
    };
  }

  if (!genderMatch && c > 0.7) {
    flags.push('gender_conflict');
    return {
      status: 'reject',
      reason: '属性破綻（性別ミスマッチ）',
      confidencePenalty: 0.2,
      flags,
      genderMatch,
    };
  }

  if (role === 'fake' && c > 0.75) {
    flags.push('role_vs_pdp');
    return {
      status: 'reject',
      reason: 'ロールとDOM真値の矛盾',
      confidencePenalty: 0.25,
      flags,
      genderMatch,
    };
  }

  return { status: 'accept', reason: '', confidencePenalty: 0, flags: [], genderMatch };
}
