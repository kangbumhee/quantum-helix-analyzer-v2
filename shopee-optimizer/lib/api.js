const ShopeeAPI = {
  _token: null,
  _domain: null,
  _region: null,

  async init() {
    const data = await chrome.storage.local.get(['spcToken', 'sellerDomain', 'region']);
    this._token = data.spcToken;
    this._domain = data.sellerDomain;
    this._region = data.region || '';
  },

  _headers() {
    return {
      'Content-Type': 'application/json',
      Cookie: `SPC_CDS=${this._token}`
    };
  },

  _baseUrl() {
    return `https://${this._domain}`;
  },

  async _get(path, params = {}) {
    if (!this._token) await this.init();
    const url = new URL(`${this._baseUrl()}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const res = await fetch(url.toString(), {
      headers: this._headers(),
      credentials: 'include'
    });
    if (!res.ok) throw new Error(`API GET ${path} → ${res.status}`);
    return res.json();
  },

  async _post(path, body = {}) {
    if (!this._token) await this.init();
    const res = await fetch(`${this._baseUrl()}${path}`, {
      method: 'POST',
      headers: this._headers(),
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`API POST ${path} → ${res.status}`);
    return res.json();
  },

  async getShopList() {
    const endpoints = [
      '/api/v3/merchant/get_shop_list',
      '/api/v3/general/get_shop_list',
      '/api/v3/merchant/get_all_shop_info_list'
    ];
    for (const ep of endpoints) {
      try {
        const json = await this._get(ep);
        const list = json?.data?.list || json?.data?.shop_list || [];
        if (list.length > 0) {
          return list.map(s => ({
            shop_id: s.shop_id,
            name: s.user_name || s.shop_name || s.name || `Shop ${s.shop_id}`,
            region: s.region || '',
            status: s.status
          }));
        }
      } catch (e) { continue; }
    }
    return [];
  },

  async getProducts(shopId, page = 1, size = 48) {
    if (!this._token) await this.init();
    const path = '/api/v3/opt/mpsku/list/v2/search_product_list';
    const url = `${this._baseUrl()}${path}?page_number=${page}&page_size=${size}&source=seller_center&need_statistic_info=true&SPC_CDS=${encodeURIComponent(this._token)}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${this._region || ''}`;
    const res = await fetch(url, {
      headers: this._headers(),
      credentials: 'include'
    });
    if (!res.ok) throw new Error(`API GET products → ${res.status}`);
    const json = await res.json();
    const list = json?.data?.products || json?.data?.list || json?.data?.items || [];
    const total = json?.data?.page_info?.total || json?.data?.total || 0;
    return { list, total };
  },

  async getAllProducts(shopId) {
    const first = await this.getProducts(shopId, 1, 48);
    const all = [...first.list];
    const totalPages = Math.min(Math.ceil(first.total / 48), 120);
    for (let p = 2; p <= totalPages; p++) {
      const page = await this.getProducts(shopId, p, 48);
      all.push(...page.list);
      await new Promise(r => setTimeout(r, 200));
    }
    const seen = new Set();
    return all.filter(p => {
      const id = p.item_id || p.product_id || p.id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  },

  async getProductPerformance(shopId, itemId) {
    return this._get('/api/v3/product/get_product_performance', {
      shop_id: shopId, item_id: itemId
    });
  },

  async getTopKeywords(shopId) {
    return this._get('/api/v3/marketing/get_top_keywords', { shop_id: shopId });
  },

  async getTrendingKeywords(shopId) {
    return this._get('/api/v3/marketing/get_trending_keywords', { shop_id: shopId });
  },

  async getTrafficOverview(shopId, days = 1) {
    return this._get('/api/v3/dashboard/get_traffic_overview', {
      shop_id: shopId, days
    });
  },

  async getTrafficSources(shopId, days = 1) {
    return this._get('/api/v3/dashboard/get_traffic_sources', {
      shop_id: shopId, days
    });
  },

  async getSalesFunnel(shopId, days = 1) {
    return this._get('/api/v3/dashboard/get_sales_funnel', {
      shop_id: shopId, days
    });
  },

  async getProductRankings(shopId) {
    return this._get('/api/v3/product/get_product_ranking', { shop_id: shopId });
  },

  async getKeyMetrics(shopId) {
    return this._get('/api/v3/dashboard/get_key_metrics', { shop_id: shopId });
  },

  async getRealtimeMetrics(shopId) {
    return this._get('/api/v3/dashboard/get_realtime_metrics', { shop_id: shopId });
  }
};

export { ShopeeAPI };
