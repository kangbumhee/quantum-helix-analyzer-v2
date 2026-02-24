let allReports = {};
let currentShop = null;
let aiOptimizationResults = null;
let lastAIShopId = null;

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function sendMessage(msg) {
  return chrome.runtime.sendMessage(msg);
}

function showGlobalProgress(text) {
  let overlay = document.querySelector('.global-progress-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'global-progress-overlay';
    overlay.innerHTML = `
      <div class="global-progress-box">
        <p id="globalProgressText" style="color:#fff;font-size:15px;">${escapeHtml(text)}</p>
        <div class="progress-bar"><div id="globalProgressFill" class="progress-fill" style="width:0%"></div></div>
        <span id="globalProgressPct" style="color:#7c4dff;font-size:13px;">0%</span>
      </div>`;
    document.body.appendChild(overlay);
  } else {
    overlay.style.display = 'flex';
    document.getElementById('globalProgressText').textContent = text;
  }
}

function updateGlobalProgress(pct, text) {
  const fill = document.getElementById('globalProgressFill');
  const pctEl = document.getElementById('globalProgressPct');
  const textEl = document.getElementById('globalProgressText');
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  if (textEl && text) textEl.textContent = text;
}

function hideGlobalProgress() {
  const overlay = document.querySelector('.global-progress-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function init() {
  setupNavigation();
  setupSidebarControls();
  await loadData();
  initAITab();
  loadHistoryTab();
}

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.tab-section').forEach(t => t.classList.remove('active'));
      item.classList.add('active');
      const tab = item.dataset.tab;
      document.getElementById(`tab-${tab}`).classList.add('active');
      onTabSwitch(tab);
    });
  });
}

function onTabSwitch(tabName) {
  switch (tabName) {
    case 'overview': renderOverview(); break;
    case 'issues': renderIssues(); break;
    case 'keywords': renderKeywords(); break;
    case 'titles': renderTitleOptimization(); break;
    case 'freshness': renderFreshness(); break;
    case 'products': renderProducts(); break;
    case 'ai': break;
    case 'history': loadHistoryTab(); break;
  }
}

function setupSidebarControls() {
  document.getElementById('btnRefresh').addEventListener('click', async () => {
    showGlobalProgress('데이터 새로고침 중...');
    await loadData();
    hideGlobalProgress();
  });

  document.getElementById('btnConnectDash').addEventListener('click', async () => {
    showGlobalProgress('쿠키 연결 중...');
    const res = await sendMessage({ type: 'CONNECT_VIA_COOKIE' });
    hideGlobalProgress();
    if (res.success) {
      await loadData();
    } else {
      alert(res.error || '연결 실패');
    }
  });

  document.getElementById('shopSelector').addEventListener('change', (e) => {
    currentShop = e.target.value || null;
    renderOverview();
  });
}

async function loadData() {
  const res = await sendMessage({ type: 'GET_ALL_REPORTS' });
  if (res.success) {
    allReports = res.reports || {};
  }

  const shopRes = await sendMessage({ type: 'GET_SHOPS' });
  if (shopRes.success && shopRes.shops) {
    populateShopSelectors(shopRes.shops);
  }

  renderOverview();
}

function populateShopSelectors(shops) {
  const selectors = ['shopSelector', 'titleShopSelect', 'freshnessShopFilter', 'aiShopSelect'];
  for (const id of selectors) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    sel.innerHTML = '<option value="">전체</option>' +
      shops.map(s => `<option value="${s.shopId}">${escapeHtml(s.name)} (${s.region})</option>`).join('');
  }
}

function renderOverview() {
  const entries = Object.entries(allReports);
  const filtered = currentShop
    ? entries.filter(([id]) => String(id) === String(currentShop))
    : entries;

  let totalProducts = 0, totalViews = 0, totalSold = 0, totalIssues = 0;
  let scoreSum = 0, scoreCount = 0;
  for (const [, r] of filtered) {
    totalProducts += r.summary?.totalProducts || 0;
    totalViews += r.summary?.totalViews || 0;
    totalSold += r.summary?.totalSold || 0;
    totalIssues += (r.issues || []).length;
    if (r.score != null) { scoreSum += r.score; scoreCount++; }
  }
  const avgScore = scoreCount > 0 ? Math.round(scoreSum / scoreCount) : 0;

  document.getElementById('metricsGrid').innerHTML = [
    { label: '평균 점수', value: avgScore, sub: `${scoreCount}개 샵` },
    { label: '총 상품 수', value: totalProducts.toLocaleString() },
    { label: '총 조회수', value: totalViews.toLocaleString() },
    { label: '총 판매수', value: totalSold.toLocaleString() },
    { label: '이슈', value: totalIssues, sub: '건' }
  ].map(m => `
    <div class="metric-card">
      <div class="label">${m.label}</div>
      <div class="value">${m.value}</div>
      ${m.sub ? `<div class="sub">${m.sub}</div>` : ''}
    </div>
  `).join('');

  document.getElementById('shopCards').innerHTML = filtered.map(([id, r]) => `
    <div class="shop-card-dash" data-shop-id="${id}">
      <span class="score">${r.score ?? '—'}</span>
      <div class="name">${escapeHtml(r.shopName || id)}</div>
      <div class="region">${r.region || ''}</div>
    </div>
  `).join('') || '<p style="color:#888;">분석 데이터 없음</p>';
}

function renderIssues() {
  const entries = Object.entries(allReports);
  const all = [];
  for (const [id, r] of entries) {
    for (const issue of (r.issues || [])) {
      all.push({ ...issue, shopName: r.shopName || id });
    }
  }

  const order = { critical: 0, high: 1, medium: 2 };
  all.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));

  document.getElementById('issuesList').innerHTML = all.length > 0
    ? all.map(i => `
      <div class="issue-card">
        <div class="level-dot ${i.level}"></div>
        <span class="message">${escapeHtml(i.message)}</span>
        <span class="shop-label">${escapeHtml(i.shopName)}</span>
      </div>
    `).join('')
    : '<p style="color:#888;">감지된 이슈 없음</p>';
}

function renderKeywords() {
  const entries = Object.entries(allReports);
  let popular = [], trending = [];
  for (const [, r] of entries) {
    if (r.keywords?.popular) popular.push(...r.keywords.popular);
    if (r.keywords?.trending) trending.push(...r.keywords.trending);
  }

  const renderList = (list, containerId) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    const items = list.slice(0, 30);
    el.innerHTML = items.length > 0
      ? items.map(k => {
          const name = typeof k === 'string' ? k : k.keyword || k.name || '';
          const count = typeof k === 'object' ? (k.count || k.search_volume || '') : '';
          return `<div class="keyword-item"><span>${escapeHtml(name)}</span><span class="count">${count}</span></div>`;
        }).join('')
      : '<p style="color:#888;">키워드 없음</p>';
  };

  renderList(popular, 'popularKeywords');
  renderList(trending, 'trendingKeywords');
}

function renderTitleOptimization() {
  const container = document.getElementById('titleResults');
  if (!container) return;
  const entries = Object.entries(allReports);
  const suggestions = [];
  for (const [, r] of entries) {
    if (r.titleSuggestions) suggestions.push(...r.titleSuggestions);
  }

  container.innerHTML = suggestions.length > 0
    ? suggestions.map(s => `
      <div class="title-card">
        <div class="original">현재: ${escapeHtml(s.original)}</div>
        <div class="suggested">제안: ${escapeHtml(s.suggested)}</div>
        <div class="added-kw">추가 키워드: ${(s.addedKeywords || []).join(', ')}</div>
      </div>
    `).join('')
    : '<p style="color:#888;">제목 제안 없음</p>';
}

function renderFreshness() {
  const entries = Object.entries(allReports);
  let pending = 0, boosted = 0, expired = 0;
  const products = [];
  for (const [, r] of entries) {
    pending += r.freshness?.pending || 0;
    boosted += r.freshness?.boosted || 0;
    expired += r.freshness?.expired || 0;
    if (r.products) {
      for (const p of r.products) {
        products.push(p);
      }
    }
  }

  document.getElementById('freshnessSummary').innerHTML = `
    <div class="fresh-summary">
      <div class="fresh-card pending"><div class="count">${pending}</div><div class="label">Pending (≤3일)</div></div>
      <div class="fresh-card boosted"><div class="count">${boosted}</div><div class="label">Boosted (≤7일)</div></div>
      <div class="fresh-card expired"><div class="count">${expired}</div><div class="label">Expired (7일+)</div></div>
    </div>
  `;

  const expiredProducts = products.filter(p => p._freshnessStatus === 'expired').slice(0, 50);
  document.getElementById('freshnessProductList').innerHTML = expiredProducts.length > 0
    ? expiredProducts.map(p => `
      <div class="product-row">
        <span class="product-name">${escapeHtml(p.name || p.title || '')}</span>
        <div class="product-stats">
          <span>${p._daysSinceModify || '?'}일 전 수정</span>
        </div>
      </div>
    `).join('')
    : '<p style="color:#888;">만료 상품 없음</p>';
}

function renderProducts() {
  const container = document.getElementById('productListContent');
  if (!container) return;

  const entries = Object.entries(allReports);
  let allProducts = [];
  for (const [, r] of entries) {
    if (r.products) allProducts.push(...r.products);
  }

  const existingSort = container.querySelector('#productSort');
  const sortBy = existingSort ? existingSort.value : 'sold';

  const sortFn = {
    sold: (a, b) => (b._sold || 0) - (a._sold || 0),
    views: (a, b) => (b._views || 0) - (a._views || 0),
    impression: (a, b) => (b._impressions || 0) - (a._impressions || 0),
    modify: (a, b) => (a._daysSinceModify || 999) - (b._daysSinceModify || 999),
    keyword: (a, b) => (b._analysis?.keywordMatchCount || 0) - (a._analysis?.keywordMatchCount || 0)
  };

  allProducts.sort(sortFn[sortBy] || sortFn.sold);

  let html = `
    <div class="sort-bar">
      <span>정렬:</span>
      <select id="productSort">
        <option value="sold" ${sortBy === 'sold' ? 'selected' : ''}>판매순</option>
        <option value="views" ${sortBy === 'views' ? 'selected' : ''}>조회순</option>
        <option value="impression" ${sortBy === 'impression' ? 'selected' : ''}>노출순</option>
        <option value="modify" ${sortBy === 'modify' ? 'selected' : ''}>최근 수정</option>
        <option value="keyword" ${sortBy === 'keyword' ? 'selected' : ''}>키워드 매칭</option>
      </select>
      <span style="margin-left:auto;color:#666;">${allProducts.length}개 상품</span>
    </div>
  `;

  html += allProducts.slice(0, 100).map(p => `
    <div class="product-row">
      <span class="product-name">${escapeHtml(p.name || p.title || '')}</span>
      <div class="product-stats">
        <span>판매 <span class="val">${p._sold || 0}</span></span>
        <span>조회 <span class="val">${p._views || 0}</span></span>
        <span>노출 <span class="val">${p._impressions || 0}</span></span>
        <span>수정 <span class="val">${p._daysSinceModify ?? '?'}일</span></span>
      </div>
    </div>
  `).join('');

  container.innerHTML = html;

  const sortSelect = container.querySelector('#productSort');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => renderProducts());
  }
}

function initAITab() {
  const btnAI = document.getElementById('btnAIAnalyze');
  const btnAIAll = document.getElementById('btnAIAll');

  if (btnAI) {
    btnAI.addEventListener('click', () => {
      const shopId = document.getElementById('aiShopSelect').value;
      if (!shopId) { alert('샵을 선택하세요.'); return; }
      startAIOptimization(shopId);
    });
  }

  if (btnAIAll) {
    btnAIAll.addEventListener('click', startAllShopsAI);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'AI_PROGRESS') {
      showAIProgress(msg.percentage, msg.text);
    }
  });
}

function showAIProgress(pct, text) {
  const el = document.getElementById('aiProgress');
  if (el) el.style.display = 'block';
  const fill = document.getElementById('aiProgressFill');
  const pctEl = document.getElementById('aiProgressPct');
  const textEl = document.getElementById('aiProgressText');
  if (fill) fill.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  if (textEl) textEl.textContent = text || '';
}

async function startAIOptimization(shopId) {
  lastAIShopId = shopId;
  showAIProgress(0, 'AI 최적화 시작...');
  const res = await sendMessage({ type: 'AI_OPTIMIZE_PRODUCTS', shopId });
  document.getElementById('aiProgress').style.display = 'none';

  if (res.success) {
    aiOptimizationResults = res;
    renderAIResults(res);
  } else {
    document.getElementById('aiResults').innerHTML =
      `<p style="color:#f44336;">오류: ${escapeHtml(res.error)}</p>`;
  }
}

async function startAllShopsAI() {
  const shopRes = await sendMessage({ type: 'GET_SHOPS' });
  if (!shopRes.success || !shopRes.shops) return;

  showGlobalProgress('전체 샵 AI 최적화...');
  for (let i = 0; i < shopRes.shops.length; i++) {
    const shop = shopRes.shops[i];
    updateGlobalProgress(
      (i / shopRes.shops.length) * 100,
      `${shop.name} AI 분석 중... (${i + 1}/${shopRes.shops.length})`
    );
    try {
      await sendMessage({ type: 'AI_OPTIMIZE_PRODUCTS', shopId: shop.shopId });
    } catch (e) {
      console.warn('AI optimization failed for', shop.name, e);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  hideGlobalProgress();
}

function renderAIResults(data) {
  const container = document.getElementById('aiResults');
  if (!container) return;

  const results = data.results || [];
  const summary = data.summary || {};

  let html = `
    <div class="metric-card" style="margin-bottom:16px;">
      <div class="label">AI 최적화 요약</div>
      <div class="value">${summary.optimized || 0} / ${summary.totalProducts || 0}</div>
      <div class="sub">상품 최적화 완료</div>
    </div>
    <div style="margin-bottom:12px;">
      <button id="btnToggleAll" class="btn-small">전체 선택/해제</button>
      <button id="btnApplyApproved" class="btn-primary" style="margin-left:8px;">승인된 항목 적용</button>
    </div>
  `;

  html += results.map((r, idx) => `
    <div class="ai-result-card">
      <label>
        <input type="checkbox" class="approve-checkbox" data-index="${idx}" checked>
        <span class="current-title">현재: ${escapeHtml(r.currentTitle || '')}</span>
      </label>
      <div class="new-title">제안: ${escapeHtml(r.optimizedTitle || '')}</div>
      <div class="keywords">키워드: ${(r.usedKeywords || []).join(', ')}</div>
    </div>
  `).join('');

  container.innerHTML = html;

  document.getElementById('btnToggleAll')?.addEventListener('click', toggleAllAIResults);
  document.getElementById('btnApplyApproved')?.addEventListener('click', applyApprovedOptimizations);
}

function toggleAllAIResults() {
  const checkboxes = document.querySelectorAll('.approve-checkbox');
  const allChecked = Array.from(checkboxes).every(c => c.checked);
  checkboxes.forEach(c => c.checked = !allChecked);
}

async function applyApprovedOptimizations() {
  if (!aiOptimizationResults) return;
  const checkboxes = document.querySelectorAll('.approve-checkbox:checked');
  const indices = Array.from(checkboxes).map(c => parseInt(c.dataset.index, 10));
  const results = aiOptimizationResults.results || [];
  const shopId = lastAIShopId || document.getElementById('aiShopSelect')?.value;

  const plan = indices.map(idx => {
    const r = results[idx];
    return {
      id: r.id,
      shopId: shopId,
      title: r.optimizedTitle,
      description: r.optimizedDescription,
      originalData: { name: r.currentTitle }
    };
  });

  if (plan.length === 0) { alert('선택된 항목이 없습니다.'); return; }
  if (!confirm(`${plan.length}개 항목을 적용하시겠습니까?`)) return;

  showGlobalProgress(`${plan.length}개 항목 적용 중...`);
  const res = await sendMessage({ type: 'APPLY_OPTIMIZATIONS', plan });
  hideGlobalProgress();

  const applyContainer = document.getElementById('applyResults');
  if (res.success && applyContainer) {
    const r = res.result;
    applyContainer.innerHTML = `
      <div class="metric-card">
        <div class="label">적용 결과</div>
        <div class="value" style="color:#4caf50;">${r.success}건 성공</div>
        <div class="sub">${r.failed}건 실패 / ${r.skipped}건 스킵</div>
      </div>
    `;
  }
}

async function loadHistoryTab() {
  const data = await chrome.storage.local.get('updateHistory');
  const history = data.updateHistory || [];
  const container = document.getElementById('historyList');
  if (!container) return;

  container.innerHTML = history.length > 0
    ? history.map(h => `
      <div class="history-item">
        <span class="date">${new Date(h.date).toLocaleString('ko-KR')}</span>
        <span class="stats">
          <span class="success">성공 ${h.success}</span>
          <span class="failed">실패 ${h.failed}</span>
          <span>스킵 ${h.skipped || 0}</span>
        </span>
      </div>
    `).join('')
    : '<p style="color:#888;">수정 이력 없음</p>';

  document.getElementById('btnClearHistory')?.addEventListener('click', async () => {
    if (!confirm('이력을 모두 삭제하시겠습니까?')) return;
    await chrome.storage.local.remove('updateHistory');
    container.innerHTML = '<p style="color:#888;">수정 이력 없음</p>';
  });
}

document.addEventListener('DOMContentLoaded', init);
