document.addEventListener('DOMContentLoaded', () => {
  const btnConnect = document.getElementById('btnConnectCookie');
  const btnAnalyzeAll = document.getElementById('btnAnalyzeAll');
  const btnDashboard = document.getElementById('btnDashboard');
  const loginStatus = document.getElementById('loginStatus');
  const shopSection = document.getElementById('shopSection');
  const shopList = document.getElementById('shopList');
  const progressSection = document.getElementById('progressSection');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const recentResults = document.getElementById('recentResults');

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ANALYSIS_PROGRESS') {
      showProgress(`${msg.shopName || ''} 분석 중... (${msg.current}/${msg.total})`);
      progressFill.style.width = `${(msg.current / msg.total) * 100}%`;
    }
  });

  sendMessage({ type: 'GET_SHOPS' }).then(res => {
    if (res.success && res.shops) {
      showLoginSuccess(`${res.shops.length}개 샵 연결됨`);
      renderShops(res.shops);
      loadRecentResults();
    } else {
      showLoginError('로그인이 필요합니다.');
    }
  });

  btnConnect.addEventListener('click', async () => {
    btnConnect.disabled = true;
    btnConnect.textContent = '연결 중...';
    const res = await sendMessage({ type: 'CONNECT_VIA_COOKIE' });
    btnConnect.disabled = false;
    btnConnect.textContent = '쿠키로 연결';
    if (res.success) {
      showLoginSuccess(`${res.shops.length}개 샵 연결됨`);
      renderShops(res.shops);
      loadRecentResults();
    } else {
      showLoginError(res.error || '연결 실패');
    }
  });

  btnAnalyzeAll.addEventListener('click', async () => {
    btnAnalyzeAll.disabled = true;
    progressSection.style.display = 'block';
    showProgress('전체 분석 시작...');

    const res = await sendMessage({ type: 'ANALYZE_ALL' });
    btnAnalyzeAll.disabled = false;
    progressSection.style.display = 'none';

    if (res.success) {
      const allReports = await sendMessage({ type: 'GET_ALL_REPORTS' });
      if (allReports.success) {
        for (const [shopId, report] of Object.entries(allReports.reports)) {
          updateShopScore(shopId, report.score);
        }
      }
      loadRecentResults();
    }
  });

  btnDashboard.addEventListener('click', () => {
    sendMessage({ type: 'OPEN_DASHBOARD' });
  });

  function sendMessage(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  function showLoginSuccess(text) {
    loginStatus.textContent = text;
    loginStatus.className = 'status-bar success';
    shopSection.style.display = 'block';
    btnConnect.style.display = 'none';
  }

  function showLoginError(text) {
    loginStatus.textContent = text;
    loginStatus.className = 'status-bar error';
    shopSection.style.display = 'none';
    btnConnect.style.display = 'block';
  }

  function showProgress(text) {
    progressSection.style.display = 'block';
    progressText.textContent = text;
  }

  function renderShops(shops) {
    shopList.innerHTML = shops.map(s => `
      <div class="shop-card" data-shop-id="${s.shopId}">
        <span class="score" id="score-${s.shopId}">—</span>
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="region">${s.region}</div>
      </div>
    `).join('');

    shopList.querySelectorAll('.shop-card').forEach(card => {
      card.addEventListener('click', () => {
        const shopId = card.dataset.shopId;
        const shop = shops.find(s => String(s.shopId) === shopId);
        if (shop) analyzeSingleShop(shop);
      });
    });
  }

  async function analyzeSingleShop(shop) {
    showProgress(`${shop.name} 분석 중...`);
    progressFill.style.width = '0%';
    progressSection.style.display = 'block';

    const res = await sendMessage({
      type: 'ANALYZE_SHOP',
      shopId: shop.shopId,
      region: shop.region,
      shopName: shop.name
    });

    progressSection.style.display = 'none';
    if (res.success) {
      updateShopScore(shop.shopId, res.report.score);
      loadRecentResults();
    }
  }

  function updateShopScore(shopId, score) {
    const el = document.getElementById(`score-${shopId}`);
    if (el) el.textContent = score ?? '—';
  }

  async function loadRecentResults() {
    const res = await sendMessage({ type: 'GET_ALL_REPORTS' });
    if (!res.success || !res.reports) { recentResults.style.display = 'none'; return; }

    recentResults.style.display = 'block';
    const entries = Object.entries(res.reports);
    if (entries.length === 0) { recentResults.innerHTML = '<p style="color:#888;">분석 결과 없음</p>'; return; }

    recentResults.innerHTML = '<h3 style="color:#fff;margin-bottom:8px;">최근 분석 결과</h3>' +
      entries.map(([shopId, r]) => {
        const issues = r.issues || [];
        const criticals = issues.filter(i => i.level === 'critical').length;
        const highs = issues.filter(i => i.level === 'high').length;
        return `
        <div class="result-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="shop-name">${escapeHtml(r.shopName || shopId)}</span>
            <span class="result-score">${r.score ?? '—'}</span>
          </div>
          <div class="stats">
            <span>상품 ${r.summary?.totalProducts || 0}</span>
            <span>조회 ${r.summary?.totalViews || 0}</span>
            <span>판매 ${r.summary?.totalSold || 0}</span>
          </div>
          <div style="margin-top:6px;">
            ${criticals > 0 ? `<span class="badge critical">심각 ${criticals}</span> ` : ''}
            ${highs > 0 ? `<span class="badge high">높음 ${highs}</span>` : ''}
          </div>
        </div>`;
      }).join('');
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }
});
