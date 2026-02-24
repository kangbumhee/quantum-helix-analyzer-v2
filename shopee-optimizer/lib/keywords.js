class ShopeeKeywords {
  constructor(token, domain) {
    this._token = token;
    this._domain = domain;
    this._domainLangMap = {
      'seller.shopee.kr': 'ko', 'seller.shopee.co.id': 'id',
      'seller.shopee.com.my': 'ms', 'seller.shopee.sg': 'en',
      'seller.shopee.co.th': 'th', 'seller.shopee.vn': 'vi',
      'seller.shopee.ph': 'en', 'seller.shopee.tw': 'zh-TW',
      'seller.shopee.com.br': 'pt', 'seller.shopee.com.mx': 'es',
      'seller.shopee.com.co': 'es', 'seller.shopee.cl': 'es'
    };
  }

  _lang() { return this._domainLangMap[this._domain] || 'en'; }

  async _fetch(path, params = {}) {
    const url = new URL(`https://${this._domain}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      headers: { 'Content-Type': 'application/json', Cookie: `SPC_CDS=${this._token}` },
      credentials: 'include'
    });
    return res.json();
  }

  async getTopKeywords(shopId) {
    try {
      const json = await this._fetch('/api/v3/marketing/get_top_keywords', { shop_id: shopId });
      return json?.data?.keywords || json?.data?.list || [];
    } catch { return []; }
  }

  async getTrendingKeywords(shopId) {
    try {
      const json = await this._fetch('/api/v3/marketing/get_trending_keywords', { shop_id: shopId });
      return json?.data?.keywords || json?.data?.list || [];
    } catch { return []; }
  }

  async getSuggestionKeywords(shopId) {
    try {
      const json = await this._fetch('/api/v3/marketing/get_suggestion_keywords', { shop_id: shopId });
      return json?.data?.keywords || json?.data?.list || [];
    } catch { return []; }
  }

  async getProductKeywords(shopId, itemId) {
    try {
      const json = await this._fetch('/api/v3/marketing/get_product_keywords', {
        shop_id: shopId, item_id: itemId
      });
      return json?.data?.keywords || [];
    } catch { return []; }
  }

  async getBatchKeywordCounts(shopId, keywords) {
    try {
      const json = await fetch(`https://${this._domain}/api/v3/marketing/get_keyword_counts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `SPC_CDS=${this._token}` },
        credentials: 'include',
        body: JSON.stringify({ shop_id: shopId, keywords })
      });
      const data = await json.json();
      return data?.data || {};
    } catch { return {}; }
  }

  async getAggregatedKeywords(shopId) {
    const [top, trending, suggestions] = await Promise.all([
      this.getTopKeywords(shopId),
      this.getTrendingKeywords(shopId),
      this.getSuggestionKeywords(shopId)
    ]);
    return { top, trending, suggestions };
  }
}

const KeywordEngine = {
  _stopWords: new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'dan', 'atau', 'di', 'ke', 'dari', 'yang', 'ini', 'itu',
    '의', '에', '를', '을', '이', '가', '는', '은', '와', '과'
  ]),

  detectLanguage(text) {
    if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
    if (/[\u0E00-\u0E7F]/.test(text)) return 'th';
    if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
    if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text)) return 'vi';
    return 'en';
  },

  analyzeProduct(product, popularKeywords = [], trendingKeywords = []) {
    const title = product.name || product.title || '';
    const lang = this.detectLanguage(title);
    const titleWords = title.toLowerCase().split(/[\s\-\_\,\.\!\?\(\)\[\]\/\\]+/)
      .filter(w => w.length > 1 && !this._stopWords.has(w));

    const allKeywords = [
      ...popularKeywords.map(k => (typeof k === 'string' ? k : k.keyword || k.name || '').toLowerCase()),
      ...trendingKeywords.map(k => (typeof k === 'string' ? k : k.keyword || k.name || '').toLowerCase())
    ].filter(Boolean);

    let matchCount = 0;
    const matchedKeywords = [];
    for (const kw of allKeywords) {
      if (title.toLowerCase().includes(kw)) {
        matchCount++;
        matchedKeywords.push(kw);
      }
    }

    return {
      language: lang,
      isLocalized: lang !== 'en',
      titleLength: title.length,
      wordCount: titleWords.length,
      keywordMatchCount: matchCount,
      keywordMatchRate: allKeywords.length > 0 ? matchCount / allKeywords.length : 0,
      matchedKeywords,
      titleWords
    };
  },

  generateTitleSuggestion(product, analysis, topKeywords = []) {
    const title = product.name || product.title || '';
    if (!title) return null;

    const kwList = topKeywords.slice(0, 5).map(k =>
      typeof k === 'string' ? k : k.keyword || k.name || ''
    ).filter(Boolean);

    if (kwList.length === 0) return null;

    const missingKws = kwList.filter(kw => !title.toLowerCase().includes(kw.toLowerCase()));
    if (missingKws.length === 0) return { original: title, suggested: title, addedKeywords: [] };

    let suggested = title;
    const added = [];
    for (const kw of missingKws.slice(0, 2)) {
      if ((suggested + ' ' + kw).length <= 120) {
        suggested = kw + ' ' + suggested;
        added.push(kw);
      }
    }

    return { original: title, suggested, addedKeywords: added };
  }
};

export { ShopeeKeywords, KeywordEngine };
