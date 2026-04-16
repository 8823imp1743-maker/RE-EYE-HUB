/**
 * ShopAdapter 基底クラス
 * 全ショップアダプターはこのインターフェースに準拠する。
 * 新しいショップ（ヨドバシ等）を追加する場合はこのクラスを継承し、
 * search() メソッドを実装してから index.js のレジストリに追加するだけでよい。
 *
 * 正規化アイテム形式（NormalizedItem）:
 * {
 *   sourceId:   string,  // ショップ識別子 ('rakuten' | 'amazon' | 'yahoo' | ...)
 *   itemId:     string,  // ショップ固有のアイテムID（seen キー生成に使用）
 *   title:      string,  // 商品名
 *   price:      number,  // 価格（円）。不明な場合は 0
 *   available:  boolean, // 在庫あり = true
 *   url:        string,  // 商品URL
 *   imageUrl:   string,  // サムネイルURL（任意）
 *   shopName:   string,  // 表示用ショップ名（'楽天市場' 等）
 *   checkedAt:  number,  // チェック時刻（Date.now()）
 * }
 */
export class ShopAdapter {
  /** @returns {string} ショップ識別子（小文字英数字） */
  get id() { throw new Error('id must be implemented'); }

  /** @returns {string} 表示用ショップ名 */
  get name() { throw new Error('name must be implemented'); }

  /** @returns {'api' | 'scraper'} アダプター種別（将来のスクレイパー拡張用） */
  get type() { return 'api'; }

  /**
   * 必要な環境変数が揃っているか確認する
   * @returns {boolean}
   */
  isConfigured() { throw new Error('isConfigured must be implemented'); }

  /**
   * キーワードで商品を検索し NormalizedItem[] を返す
   * @param {string} keyword
   * @param {{ maxResults?: number, inStockOnly?: boolean }} options
   * @returns {Promise<NormalizedItem[]>}
   */
  async search(keyword, options = {}) {
    throw new Error('search must be implemented');
  }
}
