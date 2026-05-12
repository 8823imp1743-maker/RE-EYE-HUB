export function extractSizeFromKeyword(keyword = '') {

    const text =
      String(keyword)
        .toLowerCase()
        .trim();
  
    // 26.5
    const decimalMatch =
      text.match(/\b(\d{2}\.\d)\b/);
  
    if (decimalMatch) {
      return decimalMatch[1];
    }
  
    // 27
    const intMatch =
      text.match(/\b(\d{2})\b/);
  
    if (intMatch) {
      return intMatch[1];
    }
  
    return null;
  }
  
  export default {
    extractSizeFromKeyword
  };