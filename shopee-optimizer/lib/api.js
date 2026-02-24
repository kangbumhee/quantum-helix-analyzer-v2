/*============================================================
  Shopee API Helper
  - 셀러센터 쿠키 기반 인증
  - 모든 API 호출 중앙 관리
============================================================*/

const ShopeeAPI = {

  // ── 인증 토큰 추출 ──
  async getSPC() {
    // 1) storage에 저장된 spc_cds가 있으면 먼저 사용
    const stored = await chrome.storage.local.get(['active_spc_cds', 'active_seller_domain']);
    if (stored.active_spc_cds) {
      return { spc: stored.active_spc_cds, domain: stored.active_seller_domain || 'seller.shopee.kr' };
    }

    // 2) 없으면 모든 셀러센터 도메인에서 쿠키 탐색
    const domains = [
      'seller.shopee.kr', 'seller.shopee.sg', 'seller.shopee.com.my',
      'seller.shopee.co.th', 'seller.shopee.vn', 'seller.shopee.ph',
      'seller.shopee.tw', 'seller.shopee.co.id', 'seller.shopee.com.br',
      'seller.shopee.com.mx'
    ];
    for (const domain of domains) {
      try {
        const cookie = await chrome.cookies.get({ url: 'https://' + domain + '/', name: 'SPC_CDS' });
        if (cookie && cookie.value) {
          await chrome.storage.local.set({ active_spc_cds: cookie.value, active_seller_domain: domain });
          return { spc: cookie.value, domain: domain };
        }
      } catch (e) {}
    }
    return null;
  },

  // ── 공통 쿼리 파라미터 ──
  buildQuery(shopId, region, spc) {
    return `SPC_CDS=${spc}&SPC_CDS_VER=2&cnsc_shop_id=${shopId}&cbsc_shop_region=${region}`;
  },

  // ── GET 요청 ──
  async apiGet(path, shopId, region) {
    const result = await this.getSPC();
    if (!result) throw new Error('SPC_CDS 쿠키 없음 — Seller Center 로그인 필요');
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://${result.domain}${path}${sep}${this.buildQuery(shopId, region, result.spc)}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
    return res.json();
  },

  // ── POST 요청 ──
  async apiPost(path, shopId, region, body) {
    const result = await this.getSPC();
    if (!result) throw new Error('SPC_CDS 쿠키 없음');
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://${result.domain}${path}${sep}${this.buildQuery(shopId, region, result.spc)}`;
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${path}`);
    return res.json();
  },

  // ══════════════════════════════════════
  // 1. 샵 목록 (storage의 connectedShops 우선, 없으면 API)
  // ══════════════════════════════════════
  async getShopList() {
    const stored = await chrome.storage.local.get(['connectedShops']);
    if (stored.connectedShops && stored.connectedShops.length > 0) {
      return stored.connectedShops;
    }
    const result = await this.getSPC();
    if (!result) throw new Error('SPC_CDS 쿠키 없음');
    const url = `https://${result.domain}/api/v3/general/get_shop_list?SPC_CDS=${result.spc}&SPC_CDS_VER=2`;
    const res = await fetch(url, { credentials: 'include' });
    const data = await res.json();
    return (data.data?.shop_list || []).filter(s => s.status === 1);
  },

  // ══════════════════════════════════════
  // 2. 상품 목록 (페이지별)
  // ══════════════════════════════════════
  async getProductList(shopId, region, page = 1, pageSize = 48) {
    return this.apiGet(
      `/api/v3/opt/mpsku/list/v2/search_product_list?page_number=${page}&page_size=${pageSize}&source=seller_center&need_statistic_info=true`,
      shopId, region
    );
  },

  // ── 전체 상품 수집 (중복 제거) ──
  async getAllProducts(shopId, region) {
    const first = await this.getProductList(shopId, region, 1, 48);
    const total = first.data?.page_info?.total || 0;
    let all = first.data?.products || [];
    const totalPages = Math.min(Math.ceil(total / 48), 60);

    for (let p = 2; p <= totalPages; p++) {
      const pg = await this.getProductList(shopId, region, p, 48);
      all = all.concat(pg.data?.products || []);
      await new Promise(r => setTimeout(r, 200));
    }

    // 중복 제거
    const seen = {};
    const unique = [];
    all.forEach(p => {
      if (!seen[p.id]) {
        seen[p.id] = true;
        unique.push(p);
      }
    });
    return unique;
  },

  // ══════════════════════════════════════
  // 3. 상품 성과 데이터
  // ══════════════════════════════════════
  async getProductPerformance(shopId, region, productIds) {
    const ids = productIds.map(id => `product_ids=${id}`).join('&');
    return this.apiGet(
      `/api/v3/opt/mpsku/list/v2/get_product_performance_info?${ids}`,
      shopId, region
    );
  },

  // ══════════════════════════════════════
  // 4. 인기 키워드
  // ══════════════════════════════════════
  async getTopKeywords(shopId, region) {
    return this.apiGet(
      '/api/mydata/krsc/shop/v2/seller-coach/top-keyword/overview/',
      shopId, region
    );
  },

  // ══════════════════════════════════════
  // 5. 트렌딩 키워드
  // ══════════════════════════════════════
  async getTrendingKeywords(shopId, region) {
    return this.apiGet(
      '/api/mydata/krsc/shop/v2/seller-coach/trending-products/category/',
      shopId, region
    );
  },

  // ══════════════════════════════════════
  // 6. 트래픽 개요
  // ══════════════════════════════════════
  async getTrafficOverview(shopId, region, dt) {
    return this.apiGet(
      `/api/mydata/krsc/shop/traffic/dashboard/overview/?period=yesterday&dt=${dt}`,
      shopId, region
    );
  },

  // ══════════════════════════════════════
  // 7. 트래픽 소스
  // ══════════════════════════════════════
  async getTrafficSources(shopId, region, startTs, endTs) {
    return this.apiGet(
      `/api/mydata/krsc/shop/v1/dashboard/traffic-sources/?start_time=${startTs}&end_time=${endTs}&period=yesterday&order_type=confirmed`,
      shopId, region
    );
  },

  // ══════════════════════════════════════
  // 8. 판매 퍼널
  // ══════════════════════════════════════
  async getSalesFunnel(shopId, region, startTs, endTs) {
    return this.apiGet(
      `/api/mydata/krsc/shop/v2/sales/overview/funnel/?start_time=${startTs}&end_time=${endTs}&period=yesterday`,
      shopId, region
    );
  },

  // ══════════════════════════════════════
  // 9. 상품 랭킹 (UV/매출)
  // ══════════════════════════════════════
  async getProductRankings(shopId, region, startTs, endTs, orderBy = 'uv.desc', pageSize = 20) {
    return this.apiGet(
      `/api/mydata/krsc/shop/v3/dashboard/product-rankings/?start_time=${startTs}&end_time=${endTs}&period=yesterday&category_type=shopee&category_id=-1&page_size=${pageSize}&page_num=1&order_type=confirmed&order_by=${orderBy}`,
      shopId, region
    );
  },

  // ══════════════════════════════════════
  // 10. 핵심 지표
  // ══════════════════════════════════════
  async getKeyMetrics(shopId, region, startTs, endTs) {
    return this.apiGet(
      `/api/mydata/krsc/shop/v3/dashboard/key-metrics/?start_time=${startTs}&end_time=${endTs}&period=yesterday&fetag=fetag`,
      shopId, region
    );
  },

  // ══════════════════════════════════════
  // 11. 실시간 지표
  // ══════════════════════════════════════
  async getRealtimeMetrics(shopId, region) {
    return this.apiGet(
      '/api/mydata/krsc/shop/v2/campaign_board/realtime_metrics/?event=confirmed',
      shopId, region
    );
  }
};

// export for module usage
if (typeof module !== 'undefined') module.exports = ShopeeAPI;
