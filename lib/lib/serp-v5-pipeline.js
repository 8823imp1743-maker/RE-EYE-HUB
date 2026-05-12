export function userGenderForSerpV5() {
    return 'men';
  }
  
  export async function classifyAndScoreSerpItemsV5(items = []) {
  
    return items.map(item => ({
      item,
      row: {
        category: 'shoe',
        confidence: 50
      }
    }));
  }
  
  export function resolveSerpV5PdpTask() {
    return {
      mode: 'default'
    };
  }
  
  export async function runSerpV5PdpVerify() {
  
    return {
      stock: 'OFF'
    };
  }
  
  export function isSerpV5PdpDomStructuralOn() {
    return false;
  }
  
  export function isSerpV5FinalStockOn() {
    return false;
  }
  
  export function serpV5AnchorProgramMatch() {
    return false;
  }
  
  export default {
    userGenderForSerpV5,
    classifyAndScoreSerpItemsV5,
    resolveSerpV5PdpTask,
    runSerpV5PdpVerify,
    isSerpV5PdpDomStructuralOn,
    isSerpV5FinalStockOn,
    serpV5AnchorProgramMatch
  };