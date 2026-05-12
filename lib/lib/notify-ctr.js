export function ctrVariant() {
    return 'default';
  }
  
  export function buildStockMonitorCtr({
    itemTitle = '',
    keywordLabel = '',
    price = 0
  } = {}) {
  
    return {
      title: `在庫検知: ${keywordLabel}`,
      message: `${itemTitle} / ¥${price}`
    };
  }
  
  export default {
    ctrVariant,
    buildStockMonitorCtr
  };