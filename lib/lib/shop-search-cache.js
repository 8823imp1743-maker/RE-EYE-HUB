export async function searchAllCached(keyword = '', options = {}) {

    console.log('[searchAllCached]', {
      keyword,
      options
    });
  
    return {
      items: []
    };
  }
  
  export default {
    searchAllCached
  };