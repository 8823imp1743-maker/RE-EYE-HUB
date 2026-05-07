/**

 * CTR 狙い撃ち用「売れ筋だけ送る」（無料のみが env で有効になる想定）。

 * score = sizeMatch*50 + stockScarcity*30 + brandPower*20

 */



function pickLeadingBrandKeyword(s) {

  const t = String(s || '').trim();

  const lat = t.match(/^([A-Za-z][\w&.+\-]{1,28})/);

  if (lat) return lat[1];

  const jp = t.match(/^[\u3000-\u9FFF々〆〤ー]{2,12}/u);

  if (jp) return jp[0];

  return '';

}



/**

 * @param {{

 *   shoeRaw?: string|number|null,

 *   title?: string,

 *   keyword?: string,

 * }} ctx

 */

export function computeCtrBoostScore(ctx) {

  const shoeRaw =

    ctx.shoeRaw != null && String(ctx.shoeRaw).trim()

      ? String(ctx.shoeRaw).trim()

      : '';

  const sizeMatch = shoeRaw ? 50 : 25;



  const hay = `${ctx.title || ''} ${ctx.keyword || ''}`;

  const scarcity =

    /(?:残り|わずか|ラスト|僅か|限定|発売|リストック|復活)/iu.test(hay)

      ? 30

      : 10;



  const b = pickLeadingBrandKeyword(ctx.title || ctx.keyword || '') || '';

  const brandPower = b.length >= 2 ? 20 : 0;



  return sizeMatch + scarcity + brandPower;

}


