/*============================================================
  Dashboard Controller
  - 탭 네비게이션
  - 데이터 로딩 및 렌더링
============================================================*/

let allReports = {};
let currentShop = 'all';
let aiOptimizationResults = [];
let freshnessShopFilterValue = 'all';

/**
 * 키워드 매칭 — 전체 일치 또는 키워드의 핵심 단어가 제목에 포함되면 매칭
 */
function isKeywordMatch(title, keyword) {
  if (!title || !keyword) return false;
  const titleLower = String(title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const kwLower = String(keyword).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (titleLower.includes(kwLower)) return true;

  const stopWords = new Set([
    'de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'com', 'para',
    'the', 'and', 'or', 'for', 'of', 'in', 'on', 'with',
    'ของ', 'ที่', 'ใน', 'và', 'của', 'cho', '的', '和', '了', '是'
  ]);
  const kwWords = kwLower.split(/[\s\-\/]+/).filter(w => w.length >= 2 && !stopWords.has(w));

  if (kwWords.length === 0) return false;
  if (kwWords.length === 1) return titleLower.includes(kwWords[0]);

  const matchedWords = kwWords.filter(w => titleLower.includes(w));
  return matchedWords.length >= Math.ceil(kwWords.length * 0.5);
}

// === AI 진행 상황 실시간 수신 ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'AI_PROGRESS_UPDATE') {
    updateAIProgress(msg.data || {});
  }
});

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupNavigation();
  document.getElementById('shopSelector').addEventListener('change', () => {
    currentShop = document.getElementById('shopSelector').value;
    renderAll();
  });
  await loadData();
  initAITab();
  loadHistoryTab();
  // 초기 로딩 시 최신 샵 데이터 병렬 수집 (UI 블로킹 없이 실행)
  analyzeAllShops().catch((e) => console.warn('[analyzeAllShops] skipped:', e));
}

// ── 메시지 헬퍼 ──
function sendMessage(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, (res) => resolve(res || { success: false, error: 'No response' }));
  });
}
const sendMsg = sendMessage;

// ============================================================
// 글로벌 진행 UI
// ============================================================
function showGlobalProgress(title, total) {
  let overlay = document.getElementById('globalProgressOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'globalProgressOverlay';
    overlay.innerHTML = `
      <div class="gp-box">
        <h3 id="gpTitle" class="gp-title"></h3>
        <div class="gp-bar-wrap">
          <div id="gpBar" class="gp-bar"></div>
        </div>
        <p id="gpPct" class="gp-pct">0%</p>
        <p id="gpMsg" class="gp-msg">준비 중...</p>
        <p id="gpDetail" class="gp-detail"></p>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  document.getElementById('gpTitle').textContent = title || '분석 중...';
  document.getElementById('gpBar').style.width = '0%';
  document.getElementById('gpPct').textContent = '0%';
  document.getElementById('gpMsg').textContent = '준비 중...';
  document.getElementById('gpDetail').textContent = '';
}

function updateGlobalProgress(completed, total, message, detail) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const bar = document.getElementById('gpBar');
  const pctEl = document.getElementById('gpPct');
  const msgEl = document.getElementById('gpMsg');
  const detailEl = document.getElementById('gpDetail');
  if (bar) bar.style.width = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
  if (msgEl) msgEl.textContent = message || '';
  if (detailEl) detailEl.textContent = detail || '';
}

function hideGlobalProgress() {
  const overlay = document.getElementById('globalProgressOverlay');
  if (overlay) overlay.style.display = 'none';
}

// ── 네비게이션 ──
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tabName = item.dataset.tab;
      if (!tabName) return;
      switchTab(tabName);
      onTabSwitch(tabName);
    });
  });

  document.getElementById('btnRefresh').addEventListener('click', async () => {
    document.getElementById('btnRefresh').textContent = '분석 중...';
    document.getElementById('btnRefresh').disabled = true;
    await sendMessage({ type: 'ANALYZE_ALL' });
    await loadData();
    document.getElementById('btnRefresh').textContent = '🔄 새로고침';
    document.getElementById('btnRefresh').disabled = false;
  });

  document.getElementById('btnConnectCookie').addEventListener('click', async () => {
    const btn = document.getElementById('btnConnectCookie');
    btn.disabled = true;
    btn.textContent = '연결 중...';
    const res = await sendMessage({ type: 'CONNECT_VIA_COOKIE' });
    if (res.success) {
      await loadData();
    }
    btn.disabled = false;
    btn.textContent = '🍪 쿠키 연결';
  });

  const btnClearHistory = document.getElementById('btnClearHistory');
  const btnAIAnalyze = document.getElementById('btnAIAnalyze');
  const btnRunAllShops = document.getElementById('btnRunAllShops');
  if (btnClearHistory) btnClearHistory.addEventListener('click', clearUpdateHistory);
  if (btnAIAnalyze) btnAIAnalyze.addEventListener('click', startAIOptimization);
  if (btnRunAllShops) btnRunAllShops.addEventListener('click', startAllShopsAI);
}

// ── 데이터 로딩 ──
async function loadData() {
  const res = await sendMessage({ type: 'GET_ALL_REPORTS' });
  if (res.success) {
    allReports = res.data;
    setupShopSelector();
    renderAll();
  }
}

function setupShopSelector() {
  const sel = document.getElementById('shopSelector');
  sel.innerHTML = '<option value="all">전체 샵</option>';
  Object.values(allReports).forEach(r => {
    if (r && r.shopId) {
      sel.innerHTML += `<option value="${r.shopId}">${r.shopName} (${r.region})</option>`;
    }
  });
}

function getActiveReports() {
  if (currentShop === 'all') return Object.values(allReports).filter(r => r && r.shopId);
  const r = allReports[currentShop];
  return r ? [r] : [];
}

// ── 전체 렌더링 ──
function renderAll() {
  renderOverview();
  renderIssues();
  renderFreshness();
}

// ── 개요 ──
function renderOverview() {
  const reports = getActiveReports();
  const totalProducts = reports.reduce((s, r) => s + (r.summary?.totalProducts || 0), 0);
  const totalViews = reports.reduce((s, r) => s + (r.summary?.totalViews || 0), 0);
  const totalSold = reports.reduce((s, r) => s + (r.summary?.totalSold || 0), 0);
  const avgScore = reports.length > 0 ? Math.round(reports.reduce((s, r) => s + (r.score || 0), 0) / reports.length) : 0;
  const totalIssues = reports.reduce((s, r) => s + (r.issues?.length || 0), 0);
  const avgKwMatch = reports.length > 0 ? Math.round(reports.reduce((s, r) => s + (r.keywordAudit?.matchRate || 0), 0) / reports.length) : 0;

  document.getElementById('overviewMetrics').innerHTML = `
    <div class="metric-card">
      <div class="metric-label">평균 점수</div>
      <div class="metric-value ${avgScore >= 70 ? 'score-good' : avgScore >= 40 ? 'score-warn' : 'score-bad'}">${avgScore}</div>
      <div class="metric-sub">100점 만점</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">총 상품 수</div>
      <div class="metric-value">${totalProducts}</div>
      <div class="metric-sub">${reports.length}개 샵</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">총 조회수</div>
      <div class="metric-value">${totalViews.toLocaleString()}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">총 판매</div>
      <div class="metric-value">${totalSold}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">키워드 매칭율</div>
      <div class="metric-value ${avgKwMatch >= 50 ? 'score-good' : avgKwMatch >= 20 ? 'score-warn' : 'score-bad'}">${avgKwMatch}%</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">발견된 문제</div>
      <div class="metric-value score-bad">${totalIssues}</div>
    </div>
  `;

  // Shop cards
  document.getElementById('shopCards').innerHTML = reports.map(r => `
    <div class="card">
      <div class="card-header">
        <span class="card-title">${r.shopName} (${r.region})</span>
        <span class="card-score ${r.score >= 70 ? 'score-good' : r.score >= 40 ? 'score-warn' : 'score-bad'}">${r.score}</span>
      </div>
      <div class="card-stats">
        <div class="stat-row"><span class="stat-label">상품</span><span class="stat-value">${r.summary?.totalProducts || 0}</span></div>
        <div class="stat-row"><span class="stat-label">조회</span><span class="stat-value">${r.summary?.totalViews || 0}</span></div>
        <div class="stat-row"><span class="stat-label">판매</span><span class="stat-value">${r.summary?.totalSold || 0}</span></div>
        <div class="stat-row"><span class="stat-label">노출</span><span class="stat-value">${r.summary?.withImpressions || 0}개</span></div>
        <div class="stat-row"><span class="stat-label">제목 현지화</span><span class="stat-value">${r.titleAudit?.localizationRate || 0}%</span></div>
        <div class="stat-row"><span class="stat-label">키워드 매칭</span><span class="stat-value">${r.keywordAudit?.matchRate || 0}%</span></div>
        <div class="stat-row"><span class="stat-label">문제</span><span class="stat-value score-bad">${r.issues?.length || 0}개</span></div>
        <div class="stat-row"><span class="stat-label">Boost중</span><span class="stat-value score-good">${r.freshnessStatus?.boosted || 0}개</span></div>
      </div>
      <div class="card-actions" style="margin-top:12px;display:flex;gap:8px;">
        <button class="btn-card-action btn-ai-opt" data-shop-id="${r.shopId}" data-region="${(r.region || '').toLowerCase()}" title="AI 최적화">🤖 AI 최적화</button>
        <button class="btn-card-action btn-analyze" data-shop-id="${r.shopId}" data-region="${(r.region || '').toLowerCase()}" title="상세 분석">📊 분석</button>
      </div>
    </div>
  `).join('');

  // 전체 개요 카드 버튼 이벤트
  document.querySelectorAll('.btn-ai-opt').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const shopId = e.currentTarget.dataset.shopId;
      switchTab('ai-optimize');
      const aiSelect = document.getElementById('aiShopSelect');
      if (aiSelect) {
        for (let i = 0; i < aiSelect.options.length; i++) {
          if (aiSelect.options[i].value === shopId) {
            aiSelect.selectedIndex = i;
            break;
          }
        }
      }
    });
  });

  document.querySelectorAll('.btn-analyze').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab('issues');
    });
  });
}

// ── 문제점 ──
function renderIssues() {
  const reports = getActiveReports();
  const allIssues = [];
  reports.forEach(r => {
    (r.issues || []).forEach(issue => {
      allIssues.push({ ...issue, shop: `${r.shopName} (${r.region})` });
    });
  });

  allIssues.sort((a, b) => {
    const sev = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
    return (sev[a.severity] || 3) - (sev[b.severity] || 3);
  });

  document.getElementById('issuesList').innerHTML = allIssues.map(issue => `
    <div class="issue-card ${issue.severity}">
      <div>
        <span class="severity-badge sev-${issue.severity}">${issue.severity}</span>
        <span style="font-size:11px;color:#888;">${issue.shop}</span>
      </div>
      <div class="issue-title">${issue.title}</div>
      <div class="issue-desc">${issue.description}</div>
      <div class="issue-impact">💥 영향: ${issue.impact}</div>
      <div class="issue-action">✅ 조치: ${issue.action}</div>
      ${issue.products ? `<div style="font-size:11px;color:#888;margin-top:4px;">관련 상품: ${issue.products.slice(0, 3).join(', ')}</div>` : ''}
    </div>
  `).join('') || '<p style="color:#888;">발견된 문제가 없습니다.</p>';
}

// ── 키워드 ──
function renderKeywords() {
  const reports = getActiveReports();
  const popular = [];
  const trending = [];

  reports.forEach(r => {
    (r.keywords?.popular || []).forEach(k => {
      popular.push({ ...k, shop: r.region });
    });
    (r.keywords?.trending || []).forEach(k => {
      trending.push({ ...k, shop: r.region });
    });
  });

  popular.sort((a, b) => (b.searchCount || 0) - (a.searchCount || 0));
  trending.sort((a, b) => (b.riseRate || 0) - (a.riseRate || 0));

  document.getElementById('popularKeywords').innerHTML = popular.slice(0, 30).map(k => `
    <div class="kw-item">
      <span class="kw-name">[${k.shop}] ${k.keyword}</span>
      <span class="kw-count">${(k.searchCount || 0).toLocaleString()}</span>
    </div>
  `).join('') || '<p style="color:#888;">키워드 데이터 없음</p>';

  document.getElementById('trendingKeywords').innerHTML = trending.slice(0, 30).map(k => `
    <div class="kw-item">
      <span class="kw-name">[${k.shop}] ${k.keyword}</span>
      <span class="kw-rise">↑${(k.riseRate || 0).toFixed(1)}x</span>
    </div>
  `).join('') || '<p style="color:#888;">트렌딩 데이터 없음</p>';
}

// ── 제목 최적화 ──
function renderTitleSuggestions() {
  const reports = getActiveReports();
  const suggestions = [];

  reports.forEach(r => {
    (r.titleSuggestions || []).forEach(s => {
      suggestions.push({ ...s, shop: `${r.shopName} (${r.region})` });
    });
  });

  // Sort by priority
  const priOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  suggestions.sort((a, b) => (priOrder[a.priority] || 3) - (priOrder[b.priority] || 3));

  document.getElementById('titleSuggestions').innerHTML = suggestions.slice(0, 50).map(s => `
    <div class="title-card">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="font-size:11px;color:#888;">${s.shop}</span>
        <span class="priority-badge pri-${s.priority}">${s.priority}</span>
      </div>
      <div class="title-current">현재: ${s.current}</div>
      <div class="title-suggested">제안: ${s.suggested}</div>
      <div class="title-keywords">
        ${s.addedKeywords.map(kw => `<span class="title-kw-badge">+${kw}</span>`).join('')}
        <span style="font-size:11px;color:#888;margin-left:8px;">예상 검색량: ${s.estimatedSearchVolume}</span>
      </div>
    </div>
  `).join('') || '<p style="color:#888;">모든 제목이 최적화되어 있습니다.</p>';
}

// ── Freshness ──
function renderFreshness() {
  const all = Object.values(allReports).filter(r => r && r.shopId);
  const filterSelect = document.getElementById('freshnessShopFilter');
  if (filterSelect) {
    const prev = freshnessShopFilterValue || 'all';
    filterSelect.innerHTML = '<option value="all">전체 샵</option>' + all.map(r => (
      `<option value="${r.shopId}">${r.shopName} (${r.region})</option>`
    )).join('');
    filterSelect.value = all.some(r => String(r.shopId) === String(prev)) ? prev : 'all';
    freshnessShopFilterValue = filterSelect.value;
    if (!filterSelect.dataset.bound) {
      filterSelect.dataset.bound = '1';
      filterSelect.addEventListener('change', () => {
        freshnessShopFilterValue = filterSelect.value;
        renderFreshness();
      });
    }
  }

  const reports = freshnessShopFilterValue === 'all'
    ? all
    : all.filter(r => String(r.shopId) === String(freshnessShopFilterValue));
  let boosted = 0, pending = 0, expired = 0;

  reports.forEach(r => {
    boosted += r.freshnessStatus?.boosted || 0;
    pending += r.freshnessStatus?.pending || 0;
    expired += r.freshnessStatus?.expired || 0;
  });

  document.getElementById('freshnessSummary').innerHTML = `
    <div class="fresh-card fresh-boosted">
      <div class="fresh-number">${boosted}</div>
      <div class="fresh-label">🚀 Boost 중 (4~7일)</div>
    </div>
    <div class="fresh-card fresh-pending">
      <div class="fresh-number">${pending}</div>
      <div class="fresh-label">⏳ 대기 중 (0~3일)</div>
    </div>
    <div class="fresh-card fresh-expired">
      <div class="fresh-number">${expired}</div>
      <div class="fresh-label">💤 만료 (7일+)</div>
    </div>
  `;

  // Product list sorted by modify time
  const allProducts = [];
  reports.forEach(r => {
    (r.products || []).forEach(p => {
      allProducts.push({ ...p, shop: r.region });
    });
  });

  allProducts.sort((a, b) => (a.daysSinceModify || 999) - (b.daysSinceModify || 999));

  document.getElementById('freshnessProducts').innerHTML = `
    <div class="product-row header">
      <div>상품명</div>
      <div class="text-right">수정일</div>
      <div class="text-right">노출</div>
      <div class="text-right">조회</div>
      <div class="text-right">판매</div>
      <div class="text-right">상태</div>
    </div>
    ${allProducts.slice(0, 100).map(p => {
      const status = p.daysSinceModify <= 3 ? '⏳ 대기' : p.daysSinceModify <= 7 ? '🚀 Boost' : '💤 만료';
      const statusClass = p.daysSinceModify <= 3 ? 'score-warn' : p.daysSinceModify <= 7 ? 'score-good' : 'score-bad';
      return `
        <div class="product-row">
          <div class="product-name">[${p.shop}] ${(p.name || '').substring(0, 45)}</div>
          <div class="text-right">${p.daysSinceModify || '?'}일전</div>
          <div class="text-right">${p.l30d_impression || 0}</div>
          <div class="text-right">${p.views || 0}</div>
          <div class="text-right">${p.sold || 0}</div>
          <div class="text-right ${statusClass}">${status}</div>
        </div>
      `;
    }).join('')}
  `;
}

// ── 상품 목록 ──
function renderProducts() {
  var reports = getActiveReports();
  var allProducts = [];

  reports.forEach(function(r) {
    (r.products || []).forEach(function(p) {
      allProducts.push(Object.assign({}, p, { shop: r.region }));
    });
  });

  // productSort가 이미 DOM에 있으면 그 값 사용, 없으면 기본값
  var sortEl = document.getElementById('productSort');
  var sortBy = sortEl ? sortEl.value : 'sold';

  var sortFn = {
    sold: function(a, b) { return (b.sold || 0) - (a.sold || 0); },
    views: function(a, b) { return (b.views || 0) - (a.views || 0); },
    impression: function(a, b) { return (b.l30d_impression || 0) - (a.l30d_impression || 0); },
    modify: function(a, b) { return (a.daysSinceModify || 999) - (b.daysSinceModify || 999); },
    keyword: function(a, b) { return (b.matchedKeywords ? b.matchedKeywords.length : 0) - (a.matchedKeywords ? a.matchedKeywords.length : 0); }
  };

  allProducts.sort(sortFn[sortBy] || sortFn.sold);

  // 출력 컨테이너: productListContent (HTML에 실제 존재) 우선, 없으면 productList
  var container = document.getElementById('productListContent') || document.getElementById('productList');
  if (!container) return;

  var html = '';

  // 정렬 드롭다운 (매번 동적으로 렌더링)
  html += '<div class="sort-bar" style="margin-bottom:16px;">';
  html += '  <select id="productSort" style="padding:8px 12px;border:1px solid #3a3a5a;border-radius:6px;font-size:13px;background:#1a1a2e;color:#e0e0e0;">';
  html += '    <option value="sold"' + (sortBy === 'sold' ? ' selected' : '') + '>판매순</option>';
  html += '    <option value="views"' + (sortBy === 'views' ? ' selected' : '') + '>조회순</option>';
  html += '    <option value="impression"' + (sortBy === 'impression' ? ' selected' : '') + '>노출순</option>';
  html += '    <option value="modify"' + (sortBy === 'modify' ? ' selected' : '') + '>최근수정순</option>';
  html += '    <option value="keyword"' + (sortBy === 'keyword' ? ' selected' : '') + '>키워드순</option>';
  html += '  </select>';
  html += '</div>';

  // 헤더
  html += '<div class="product-row header">';
  html += '  <div>상품명</div>';
  html += '  <div class="text-right">조회</div>';
  html += '  <div class="text-right">판매</div>';
  html += '  <div class="text-right">노출</div>';
  html += '  <div class="text-right">전환</div>';
  html += '  <div class="text-right">키워드</div>';
  html += '</div>';

  // 상품 행
  allProducts.forEach(function(p) {
    var kwCount = p.matchedKeywords ? p.matchedKeywords.length : 0;
    var sugCount = p.suggestedKeywords ? p.suggestedKeywords.length : 0;
    var kwClass = kwCount > 0 ? 'score-good' : 'score-bad';
    html += '<div class="product-row">';
    html += '  <div class="product-name">[' + (p.shop || '') + '] ' + (p.name || '').substring(0, 45) + '</div>';
    html += '  <div class="text-right">' + (p.views || 0) + '</div>';
    html += '  <div class="text-right">' + (p.sold || 0) + '</div>';
    html += '  <div class="text-right">' + (p.l30d_impression || 0) + '</div>';
    html += '  <div class="text-right">' + (p.l30d_conversion || 0) + '%</div>';
    html += '  <div class="text-right ' + kwClass + '">' + kwCount + '/' + sugCount + '</div>';
    html += '</div>';
  });

  container.innerHTML = html;

  // 정렬 드롭다운에 change 이벤트 바인딩 (동적으로 생성했으므로)
  var newSortEl = document.getElementById('productSort');
  if (newSortEl) {
    newSortEl.addEventListener('change', function() {
      renderProducts();
    });
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach((t) => {
    t.classList.remove('active');
    t.style.display = 'none';
  });
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const tab = document.getElementById('tab-' + tabName);
  if (tab) {
    tab.classList.add('active');
    tab.style.display = 'block';
  }
  const nav = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
  if (nav) nav.classList.add('active');
}

async function initAITab() {
  const shopSelect = document.getElementById('aiShopSelect');
  if (!shopSelect) return;

  while (shopSelect.options.length > 1) {
    shopSelect.remove(1);
  }

  try {
    const shopsResp = await sendMessage({ type: 'GET_SHOPS' });
    if (shopsResp.success && shopsResp.data) {
      const shops = shopsResp.data;
      shops.forEach(shop => {
        const shopId = shop.shop_id || shop.id || shop.cnsc_shop_id || '';
        const region = String(shop.region || 'sg').toUpperCase();
        const opt = document.createElement('option');
        opt.value = `${shopId}|${region}`;
        opt.textContent = `${shop.shop_name || shop.name} (${region})`;
        opt.dataset.shopId = shopId;
        opt.dataset.region = region.toLowerCase();
        opt.dataset.domain = shop.seller_domain || '';
        shopSelect.appendChild(opt);
      });

      if (shops.length === 1) {
        shopSelect.selectedIndex = 1;
      }
    }
  } catch (error) {
    console.error('[initAITab] 샵 목록 로드 실패:', error);
  }
}

function updateAIProgress(progress) {
  const bar = document.getElementById('aiProgressBar');
  const pct = document.getElementById('aiProgressPct');
  const text = document.getElementById('aiProgressText');
  const detail = document.getElementById('aiProgressDetail');

  const percent = progress.percent != null
    ? Number(progress.percent)
    : (progress.totalProducts ? Math.round(((progress.completedProducts || 0) / progress.totalProducts) * 100) : 0);

  if (bar) bar.style.width = percent + '%';
  if (pct) pct.textContent = percent + '%';
  if (text) text.textContent = progress.message || '';
  if (detail) {
    detail.style.color = '#a0a0c0';
    if (progress.phase === 'generating' || progress.phase === 'batch_complete') {
      detail.textContent = `처리: ${progress.completedProducts || 0}/${progress.totalProducts || 0} 상품`;
    } else if (progress.phase === 'batch_error') {
      detail.textContent = `⚠️ ${progress.message || ''}`;
      detail.style.color = '#ff6b6b';
    } else if (progress.phase === 'complete') {
      detail.textContent = `✅ 성공: ${progress.successCount || 0}개 / ❌ 실패: ${progress.failCount || 0}개`;
      detail.style.color = '#00f5c8';
    } else {
      detail.textContent = '';
    }
  }
}

function showAIProgress() {
  const el = document.getElementById('aiProgress');
  if (el) {
    el.style.display = 'block';
    const bar = document.getElementById('aiProgressBar');
    const pct = document.getElementById('aiProgressPct');
    const text = document.getElementById('aiProgressText');
    const detail = document.getElementById('aiProgressDetail');
    if (bar) bar.style.width = '0%';
    if (pct) pct.textContent = '0%';
    if (text) text.textContent = '준비 중...';
    if (detail) { detail.textContent = ''; detail.style.color = '#a0a0c0'; }
  }
}

function hideAIProgress() {
  const el = document.getElementById('aiProgress');
  if (el) el.style.display = 'none';
}

function renderAIResults(data) {
  const container = document.getElementById('aiResultsContainer');
  if (!container) return;

  const results = data?.results || [];
  const keywords = data?.keywords || {};
  const summary = data?.summary || { total: 0, success: 0, fail: 0 };

  let html = `
    <div class="ai-summary-bar">
      <div class="ai-summary-item">
        <span class="ai-summary-label">전체</span>
        <span class="ai-summary-value">${summary.total}개</span>
      </div>
      <div class="ai-summary-item success">
        <span class="ai-summary-label">성공</span>
        <span class="ai-summary-value">${summary.success}개</span>
      </div>
      <div class="ai-summary-item fail">
        <span class="ai-summary-label">실패</span>
        <span class="ai-summary-value">${summary.fail}개</span>
      </div>
    </div>

    <div class="ai-keywords-info">
      <span class="ai-kw-label">■ 수집된 인기 키워드:</span>
      <span class="ai-kw-list">${(keywords.top || []).slice(0, 7).map(k =>
        `"${escapeHtml(k.keyword || '')}" (${Number(k.search_volume || k.count || 0).toLocaleString()})`
      ).join(', ') || '없음'}</span>
      <br/>
      <span class="ai-kw-label" style="color:#ff9500;">● 트렌딩:</span>
      <span class="ai-kw-list">${(keywords.trending || []).length > 0
        ? (keywords.trending || []).slice(0, 5).map(k => `"${escapeHtml(k.keyword || '')}"`).join(', ')
        : '없음'}</span>
    </div>

    <div class="ai-actions-bar">
      <label class="ai-select-all-label">
        <input type="checkbox" id="aiSelectAll"/>
        전체 선택
      </label>
      <button id="btnApproveSelected" class="btn-approve">
        ✅ 승인된 항목 적용
      </button>
    </div>
  `;

  results.forEach((item, idx) => {
    const originalTitle = item.original_title || item.originalTitle || '';
    const newTitle = item.new_title || item.optimizedTitle || '';
    const newDescription = item.new_description || item.description || '';
    const usedKeywords = item.used_keywords || item.usedKeywords || [];

    if (!item.success) {
      html += `
        <div class="ai-result-card ai-result-error">
          <div class="ai-card-header">
            <span class="ai-card-title-text">${escapeHtml(originalTitle || '제목 없음')}</span>
            <span class="ai-card-badge badge-error">실패</span>
          </div>
          <div class="ai-card-error-msg">❌ ${escapeHtml(item.reasoning || '알 수 없는 오류')}</div>
        </div>
      `;
      return;
    }

    const kwCount = usedKeywords.length;
    const kwBadgeClass = kwCount >= 3 ? 'badge-good' : kwCount >= 2 ? 'badge-ok' : 'badge-warn';

    html += `
      <div class="ai-result-card" data-product-id="${item.product_id}">
        <div class="ai-card-header">
          <label class="ai-card-checkbox">
            <input type="checkbox" class="ai-approve-check" data-index="${idx}" checked />
          </label>
          <span class="ai-card-title-text">${escapeHtml(originalTitle)}</span>
          <span class="ai-card-badge ${kwBadgeClass}">${kwCount} keywords</span>
        </div>

        <div class="ai-card-comparison">
          <div class="ai-card-row">
            <span class="ai-card-label">현재 제목</span>
            <div class="ai-card-current">${escapeHtml(originalTitle)}</div>
          </div>
          <div class="ai-card-arrow">→</div>
          <div class="ai-card-row">
            <span class="ai-card-label">AI 추천 제목</span>
            <div class="ai-card-new">${escapeHtml(newTitle)}</div>
          </div>
        </div>

        <div class="ai-card-section">
          <span class="ai-card-label">AI 추천 설명</span>
          <div class="ai-card-description">${escapeHtml(newDescription)}</div>
        </div>

        <div class="ai-card-section">
          <span class="ai-card-label">● 사용 키워드:</span>
          <div class="ai-card-keywords">
            ${usedKeywords.map(kw =>
              `<span class="ai-kw-tag">${escapeHtml(kw)}</span>`
            ).join('')}
          </div>
        </div>

        <div class="ai-card-reasoning">
          <span class="ai-reasoning-icon">💡</span>
          <span class="ai-reasoning-text">${escapeHtml(item.reasoning || '')}</span>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  const selectAll = document.getElementById('aiSelectAll');
  if (selectAll) {
    selectAll.addEventListener('change', (e) => {
      toggleAllAIResults(e.target.checked);
    });
  }

  const approveBtn = document.getElementById('btnApproveSelected');
  if (approveBtn) {
    approveBtn.addEventListener('click', () => {
      applyApprovedOptimizations();
    });
  }
}

function toggleAllAIResults(checked) {
  document.querySelectorAll('.ai-approve-check').forEach(cb => {
    cb.checked = checked;
  });
}

async function applyApprovedOptimizations() {
  const checkboxes = document.querySelectorAll('.ai-approve-check:checked');
  if (checkboxes.length === 0) {
    alert('승인된 항목이 없습니다.');
    return;
  }

  const confirmed = confirm(`${checkboxes.length}개 상품의 제목과 설명을 실제로 변경합니다.\n계속하시겠습니까?`);
  if (!confirmed) return;

  const btn = document.getElementById('btnApproveSelected');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ 적용 중...';
  }

  const approvedIndices = [];
  checkboxes.forEach(cb => {
    approvedIndices.push(parseInt(cb.dataset.index, 10));
  });

  try {
    const last = window._lastAIResults;
    const rows = (last?.results || []);
    const approvedRows = approvedIndices.map(i => rows[i]).filter(Boolean).filter(r => r.success);
    const shopId = window._lastAIShopId;
    const region = window._lastAIRegion;
    const sellerDomain = window._lastAISellerDomain || '';

    const optimizationPlan = approvedRows.map((r) => ({
      shopId,
      region,
      productId: r.product_id,
      productName: r.original_title || r.originalTitle || '',
      originalTitle: r.original_title || r.originalTitle || '',
      newTitle: r.new_title || r.optimizedTitle || '',
      newDescription: r.new_description || r.description || '',
      approved: true,
      sellerDomain
    }));

    const response = await sendMessage({
      type: 'APPLY_OPTIMIZATIONS',
      optimizationPlan
    });

    if (response.success) {
      alert(`✅ 적용 완료!\n성공: ${response.data.success}개\n실패: ${response.data.failed}개`);
    } else {
      alert(`❌ 적용 실패: ${response.error}`);
    }
  } catch (error) {
    alert(`❌ 오류: ${error.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '✅ 승인된 항목 적용';
    }
  }
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================
// 전체 샵 병렬 데이터 수집
// ============================================================
async function analyzeAllShops() {
  let shops = [];
  try {
    const resp = await sendMessage({ type: 'GET_SHOPS' });
    if (resp.success && resp.data) shops = resp.data;
  } catch (e) {
    console.error('[analyzeAllShops]', e);
    return;
  }
  if (shops.length === 0) return;

  showGlobalProgress('🔍 전체 샵 데이터 수집 중...', shops.length);

  const CONCURRENCY = 4;
  const results = [];
  let done = 0;
  const queue = [...shops];

  const worker = async () => {
    while (queue.length > 0) {
      const shop = queue.shift();
      if (!shop) break;
      const sid = shop.shop_id || shop.id || shop.cnsc_shop_id;
      const name = shop.shop_name || shop.name || sid;
      const region = shop.region || 'sg';

      updateGlobalProgress(done, shops.length, `${name} (${String(region).toUpperCase()}) 수집 중...`, `완료: ${done}/${shops.length}`);

      try {
        const [pResp, kResp] = await Promise.all([
          sendMessage({ type: 'GET_PRODUCTS', shopId: sid, region }),
          sendMessage({ type: 'GET_KEYWORDS', shopId: sid, region })
        ]);
        results.push({
          shop, products: pResp.success ? pResp.data : [],
          keywords: kResp.success ? kResp.data : {}, success: true
        });
      } catch (err) {
        results.push({ shop, products: [], keywords: {}, success: false, error: err.message });
      }
      done++;
      updateGlobalProgress(done, shops.length, `${name} 완료`, `완료: ${done}/${shops.length}`);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, shops.length) }, () => worker())
  );

  updateGlobalProgress(shops.length, shops.length, '✅ 전체 분석 완료!');
  setTimeout(hideGlobalProgress, 1200);
  window._shopAnalysisData = results;
}

async function startAIOptimization() {
  const shopSelect = document.getElementById('aiShopSelect');
  if (!shopSelect || !shopSelect.value) {
    alert('샵을 선택하세요.');
    return;
  }

  const [shopId, regionFromValue] = String(shopSelect.value).split('|');
  const selectedOption = shopSelect.options[shopSelect.selectedIndex];
  const region = (regionFromValue || selectedOption?.dataset?.region || 'sg').toLowerCase();
  const sellerDomain = selectedOption?.dataset?.domain || '';

  const btn = document.getElementById('btnAIAnalyze');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ 분석 중...';
  }

  showAIProgress();
  updateAIProgress({ phase: 'init', percent: 0, message: `🔄 ${shopSelect.options[shopSelect.selectedIndex]?.textContent || shopId} 상품 로딩 중...` });

  try {
    const productsResp = await sendMessage({
      type: 'GET_PRODUCTS',
      shopId: shopId,
      region: region,
      sellerDomain
    });

    if (!productsResp.success || !productsResp.data?.length) {
      alert('상품 목록을 가져올 수 없습니다.');
      hideAIProgress();
      return;
    }

    updateAIProgress({ phase: 'start', percent: 5, message: `📦 ${productsResp.data.length}개 상품 AI 분석 시작...` });
    const response = await sendMessage({
      type: 'AI_OPTIMIZE_PRODUCTS',
      shopId: shopId,
      region: region,
      products: productsResp.data,
      sellerDomain
    });

    hideAIProgress();

    if (response.success) {
      window._lastAIResults = response.data || response;
      window._lastAIShopId = shopId;
      window._lastAIRegion = region;
      window._lastAISellerDomain = sellerDomain;
      renderAIResults(response.data || response);
    } else {
      const container = document.getElementById('aiResultsContainer');
      if (container) {
        container.innerHTML = `<div class="ai-card-error-msg">❌ ${escapeHtml(response.error)}</div>`;
      }
    }
  } catch (error) {
    hideAIProgress();
    alert(`오류: ${error.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '✨ AI 분석 시작';
    }
  }
}

async function startAllShopsAI() {
  const confirmed = confirm('모든 샵의 상품을 AI로 분석합니다.\n시간이 오래 걸릴 수 있습니다. 계속?');
  if (!confirmed) return;

  const btn = document.getElementById('btnRunAllShops');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ 전체 분석 중...';
  }

  const shopSelect = document.getElementById('aiShopSelect');
  const allShops = [];
  if (shopSelect) {
    for (const opt of shopSelect.options) {
      if (opt.value && opt.value.includes('|')) {
        const [shopId, region] = String(opt.value).split('|');
        allShops.push({
          id: shopId,
          region: String(region || opt.dataset?.region || 'sg').toLowerCase(),
          domain: opt.dataset?.domain || '',
          name: opt.textContent
        });
      }
    }
  }

  if (allShops.length === 0) {
    alert('등록된 샵이 없습니다.');
    hideGlobalProgress();
    if (btn) { btn.disabled = false; btn.textContent = '🌐 전체 샵 일괄 분석'; }
    return;
  }

  showGlobalProgress('🤖 전체 샵 AI 최적화', allShops.length);

  const allResults = [];
  let totalSuccess = 0;
  let totalFail = 0;

  for (let i = 0; i < allShops.length; i++) {
    const shop = allShops[i];

    updateGlobalProgress(i, allShops.length, `🏪 ${shop.name} AI 분석 중...`, `완료: ${i}/${allShops.length} | 성공: ${totalSuccess} | 실패: ${totalFail}`);

    try {
      const productsResp = await sendMessage({
        type: 'GET_PRODUCTS',
        shopId: shop.id,
        region: shop.region,
        sellerDomain: shop.domain
      });

      if (!productsResp.success || !productsResp.data?.length) {
        console.warn(`[AllShops] ${shop.name}: 상품 없음, 건너뜀`);
        continue;
      }

      const response = await sendMessage({
        type: 'AI_OPTIMIZE_PRODUCTS',
        shopId: shop.id,
        region: shop.region,
        products: productsResp.data,
        sellerDomain: shop.domain
      });

      if (response.success) {
        const payload = response.data || response;
        totalSuccess += payload.summary?.success || 0;
        totalFail += payload.summary?.fail || 0;
        allResults.push({
          shop: shop.name,
          ...payload
        });
      }
    } catch (error) {
      console.error(`[AllShops] ${shop.name} 오류:`, error);
    }

    if (i < allShops.length - 1) {
      updateGlobalProgress(i + 1, allShops.length, '⏳ Rate limit 대기 (10초)...', `완료: ${i + 1}/${allShops.length}`);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  updateGlobalProgress(allShops.length, allShops.length, `✅ 완료! 성공: ${totalSuccess} / 실패: ${totalFail}`);
  setTimeout(hideGlobalProgress, 3000);

  const container = document.getElementById('aiResultsContainer');
  if (container) {
    container.innerHTML = `
      <div class="ai-summary-bar">
        <div class="ai-summary-item">
          <span class="ai-summary-label">분석 샵</span>
          <span class="ai-summary-value">${allResults.length}개</span>
        </div>
        <div class="ai-summary-item success">
          <span class="ai-summary-label">성공</span>
          <span class="ai-summary-value">${totalSuccess}개</span>
        </div>
        <div class="ai-summary-item fail">
          <span class="ai-summary-label">실패</span>
          <span class="ai-summary-value">${totalFail}개</span>
        </div>
      </div>
      <p style="color:#a0a0c0; margin-top:12px;">
        각 샵별 상세 결과는 개별 샵 선택 후 "AI 분석 시작"으로 확인하세요.
      </p>
    `;
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = '🌐 전체 샵 일괄 분석';
  }
}

// 기존 이름 호환
async function runAIOptimization() {
  return startAIOptimization();
}

async function runAllShopsAIOptimization() {
  return startAllShopsAI();
}

async function loadHistoryTab() {
  const res = await new Promise((resolve) => {
    chrome.storage.local.get('updateHistory', (r) => resolve(r || {}));
  });
  const history = res.updateHistory || [];
  const list = document.getElementById('historyList');
  if (!list) return;
  if (history.length === 0) {
    list.innerHTML = '<p style="color:#888;">수정 이력이 없습니다.</p>';
    return;
  }
  list.innerHTML = history.map((h) => `
    <div class="result-card">
      <div class="card-header">
        <span>${new Date(h.timestamp).toLocaleString()}</span>
      </div>
      <div class="card-body">
        <span class="stat success">성공 ${h.summary?.success || 0}</span>
        <span class="stat failed">실패 ${h.summary?.failed || 0}</span>
        <span class="stat skipped">건너뜀 ${h.summary?.skipped || 0}</span>
      </div>
    </div>
  `).join('');
}

async function clearUpdateHistory() {
  if (!confirm('수정 이력을 삭제할까요?')) return;
  await new Promise((resolve) => chrome.storage.local.remove('updateHistory', resolve));
  await loadHistoryTab();
}

// 상품 목록 렌더링 (전환율 계산 + 키워드 매칭 수정)
async function renderProductList(shopFilter) {
  const container = document.getElementById('tab-product-list') || document.getElementById('productListContent');
  if (!container) return;

  const shopsRes = await sendMsg({ type: 'GET_SHOPS' });
  const shops = (shopsRes && shopsRes.success && shopsRes.data) ? shopsRes.data : [];

  let filterSelect = container.querySelector('#productShopFilter');
  if (!filterSelect) {
    const filterHtml = `<div style="margin-bottom:16px;">
      <select id="productShopFilter" class="select-control">
        <option value="all">전체 샵</option>
        ${shops.map(s => {
          const name = s.name || s.shop_name || 'Shop';
          const region = s.region || 'sg';
          const sid = s.shop_id || s.cnsc_shop_id || '';
          return `<option value="${sid}" data-region="${region}">${name} (${region.toUpperCase()})</option>`;
        }).join('')}
      </select>
    </div>`;
    container.insertAdjacentHTML('afterbegin', filterHtml);
    filterSelect = container.querySelector('#productShopFilter');
    filterSelect.addEventListener('change', () => renderProductList(filterSelect.value));
  }

  const targetShops = (shopFilter && shopFilter !== 'all')
    ? shops.filter(s => String(s.shop_id || s.cnsc_shop_id) === String(shopFilter))
    : shops;

  let allProducts = [];

  for (const shop of targetShops) {
    const sid = shop.shop_id || shop.cnsc_shop_id || '';
    const region = shop.region || 'sg';
    const shopName = shop.name || shop.shop_name || 'Shop';

    try {
      const res = await sendMsg({ type: 'GET_PRODUCTS', shopId: sid, region: region });
      if (res && res.success && res.data) {
        let shopKeywords = [];
        try {
          const kwRes = await sendMsg({ type: 'GET_KEYWORDS', shopId: sid, region: region });
          if (kwRes && kwRes.success && kwRes.data) {
            shopKeywords = (kwRes.data.topKeywords || []).map(k => (k.keyword || '')).filter(k => k);
          }
        } catch (e) {}

        res.data.forEach(p => {
          const views = p.statistics?.view_count || 0;
          const sold = p.statistics?.sold_count || 0;
          const impressions = p.statistics?.impression_count
            || p.statistics?.exposure_count
            || p.statistics?.page_impression
            || p.statistics?.total_impression
            || p.statistics?.imp_count
            || p.statistics?.impressions
            || p.statistics?.search_impression
            || 0;
          const rawConv = views > 0 ? (sold / views * 100) : 0;
          const convRate = rawConv > 100 ? '100.0' : rawConv.toFixed(1);
          const title = (p.name || '').toLowerCase();

          const matchedKw = shopKeywords.filter(kw => isKeywordMatch(title, kw));
          const totalKw = Math.min(shopKeywords.length, 20);

          allProducts.push({
            shopName,
            region: String(region).toUpperCase(),
            id: p.id,
            name: p.name || '',
            views,
            sold,
            impressions,
            convRate,
            matchedKw: matchedKw.length,
            totalKw,
            matchedKwList: matchedKw
          });
        });
      }
    } catch (e) {
      console.error('상품 로드 실패:', shopName, e);
    }
  }

  allProducts.sort((a, b) => b.sold - a.sold || b.views - a.views);

  let tableEl = container.querySelector('table');
  if (!tableEl) {
    tableEl = document.createElement('table');
    tableEl.className = 'data-table';
    container.appendChild(tableEl);
  }

  tableEl.innerHTML = `
    <thead>
      <tr>
        <th class="sortable" data-sort="name">상품명</th>
        <th class="sortable" data-sort="views" style="width:70px;text-align:right;">조회</th>
        <th class="sortable" data-sort="sold" style="width:70px;text-align:right;">판매</th>
        <th class="sortable" data-sort="impressions" style="width:70px;text-align:right;">노출</th>
        <th class="sortable" data-sort="convRate" style="width:70px;text-align:right;">전환율</th>
        <th class="sortable" data-sort="matchedKw" style="width:80px;text-align:center;">키워드</th>
      </tr>
    </thead>
    <tbody>
      ${allProducts.map(p => {
        const convClass = parseFloat(p.convRate) > 5 ? 'good' : parseFloat(p.convRate) > 0 ? 'warn' : 'bad';
        const kwClass = p.totalKw > 0 && p.matchedKw === 0 ? 'bad' : p.matchedKw > 0 ? 'good' : '';
        return `<tr>
          <td>
            <span class="shop-badge">[${p.region}]</span>
            <span class="product-name">${(p.name || '').substring(0, 60)}${(p.name || '').length > 60 ? '...' : ''}</span>
          </td>
          <td style="text-align:right;">${p.views.toLocaleString()}</td>
          <td style="text-align:right;font-weight:600;">${p.sold.toLocaleString()}</td>
          <td style="text-align:right;">${p.impressions.toLocaleString()}</td>
          <td style="text-align:right;"><span class="rate-badge ${convClass}">${p.convRate}%</span></td>
          <td style="text-align:center;"><span class="kw-badge ${kwClass}" title="${p.matchedKwList.join(', ') || '매칭 없음'}">${p.matchedKw}/${p.totalKw}</span></td>
        </tr>`;
      }).join('')}
    </tbody>`;

  tableEl.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const currentDir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
      th.dataset.dir = currentDir;
      tableEl.querySelectorAll('.sortable').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(currentDir === 'asc' ? 'sort-asc' : 'sort-desc');

      allProducts.sort((a, b) => {
        let va = a[key], vb = b[key];
        if (key === 'convRate') { va = parseFloat(va); vb = parseFloat(vb); }
        if (key === 'name') { return currentDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va)); }
        return currentDir === 'asc' ? va - vb : vb - va;
      });

      const tbody = tableEl.querySelector('tbody');
      tbody.innerHTML = allProducts.map(p => {
        const convClass = parseFloat(p.convRate) > 5 ? 'good' : parseFloat(p.convRate) > 0 ? 'warn' : 'bad';
        const kwClass = p.totalKw > 0 && p.matchedKw === 0 ? 'bad' : p.matchedKw > 0 ? 'good' : '';
        return `<tr>
          <td><span class="shop-badge">[${p.region}]</span><span class="product-name">${(p.name || '').substring(0, 60)}${(p.name || '').length > 60 ? '...' : ''}</span></td>
          <td style="text-align:right;">${p.views.toLocaleString()}</td>
          <td style="text-align:right;font-weight:600;">${p.sold.toLocaleString()}</td>
          <td style="text-align:right;">${p.impressions.toLocaleString()}</td>
          <td style="text-align:right;"><span class="rate-badge ${convClass}">${p.convRate}%</span></td>
          <td style="text-align:center;"><span class="kw-badge ${kwClass}" title="${p.matchedKwList.join(', ') || '매칭 없음'}">${p.matchedKw}/${p.totalKw}</span></td>
        </tr>`;
      }).join('');
    });
  });
}

// === 제목 최적화 제안 탭 ===
async function initTitleOptTab() {
  const sel = document.getElementById('titleOptShopSelect');
  if (!sel) return;
  while (sel.options.length > 0) sel.remove(0);
  try {
    const resp = await sendMessage({ type: 'GET_SHOPS' });
    if (resp.success && resp.data) {
      resp.data.forEach(shop => {
        const o = document.createElement('option');
        o.value = shop.shop_id || shop.id || shop.cnsc_shop_id || '';
        o.textContent = `${shop.shop_name || shop.name} (${String(shop.region || '').toUpperCase()})`;
        o.dataset.region = shop.region || 'sg';
        sel.appendChild(o);
      });
      if (resp.data.length > 0) {
        const first = resp.data[0];
        loadTitleOptForShop(first.shop_id || first.id || first.cnsc_shop_id, first.region || 'sg');
      }
      sel.onchange = () => {
        const opt = sel.options[sel.selectedIndex];
        if (opt) loadTitleOptForShop(opt.value, opt.dataset?.region || 'sg');
      };
      const refreshBtn = document.getElementById('btnRefreshTitleOpt');
      if (refreshBtn) {
        refreshBtn.onclick = () => {
          const opt = sel.options[sel.selectedIndex];
          if (opt) loadTitleOptForShop(opt.value, opt.dataset?.region || 'sg');
        };
      }
    }
  } catch (e) { console.error('[initTitleOptTab]', e); }
}

async function loadTitleOptForShop(shopId, region) {
  const container = document.getElementById('titleOptResults');
  if (!container) return;
  container.innerHTML = '<p style="color:#a0a0c0;">로딩 중...</p>';

  try {
    const [pResp, kResp] = await Promise.all([
      sendMessage({ type: 'GET_PRODUCTS', shopId, region }),
      sendMessage({ type: 'GET_KEYWORDS', shopId, region })
    ]);

    if (!pResp.success || !pResp.data?.length) {
      container.innerHTML = '<p style="color:#ff6b6b;">상품 데이터 없음</p>';
      return;
    }

    const products = pResp.data;
    const topKw = kResp.success ? (kResp.data?.topKeywords || []) : [];
    const trendKw = kResp.success ? (kResp.data?.trendingKeywords || []) : [];

    let html = `
      <div class="title-opt-kw-info">
        <strong>📊 ${_esc(shopId)} (${String(region || '').toUpperCase()}) — 키워드 ${topKw.length}개 수집됨</strong><br/>
        <span style="color:#c0c0d0;">상위 키워드: ${topKw.slice(0, 5).map(k =>
          `"${_esc(k.keyword || '')}" (${(k.search_volume || k.count || 0).toLocaleString()})`
        ).join(', ')}</span><br/>
        <span style="color:#ff9500;">🔥 트렌딩: ${trendKw.length > 0
          ? trendKw.slice(0, 5).map(k => `"${_esc(k.keyword || '')}"`).join(', ')
          : '데이터 없음'}</span>
      </div>
    `;

    let cardsHtml = '';

    products.forEach(product => {
      const title = (product.name || product.title || '');
      const titleLower = title.toLowerCase();
      const alreadyHasKw = topKw.some(kw => _isKwInTitle(titleLower, (kw.keyword || '').toLowerCase()));
      if (alreadyHasKw) return;

      const productType = _detectProductType(titleLower);
      const relevant = _findMatchingKeywords(productType, topKw, titleLower);
      if (relevant.length === 0) return;

      const totalVol = relevant.reduce((s, k) => s + (k.search_volume || k.count || 0), 0);
      const suggested = _buildTitle(title, relevant[0].keyword || '');

      cardsHtml += `
        <div class="title-opt-card">
          <div class="title-opt-header">
            <span class="title-opt-shop">${_esc(shopId)} /${String(region || '').toUpperCase()}</span>
            <span class="title-opt-priority priority-high">HIGH</span>
          </div>
          <div class="title-opt-current">
            <span class="title-opt-label">현재:</span> ${_esc(title)}
          </div>
          <div class="title-opt-suggested">
            <span class="title-opt-label">제안:</span> ${_esc(suggested)}
          </div>
          <div class="title-opt-keywords">
            ${relevant.map(k => `<span class="title-opt-kw-tag">+${_esc(k.keyword || '')}</span>`)
            .join(' ')}
            <span class="title-opt-search-vol">예상 검색량 ${totalVol.toLocaleString()}+</span>
          </div>
          <div class="title-opt-category-info">
            📂 감지된 유형: ${productType || '미분류'} | 카테고리: ${_esc(product.category_path || product.category || '미분류')}
          </div>
        </div>
      `;
    });

    if (!cardsHtml) {
      html += '<p style="color:#00f5c8; margin-top:16px;">✅ 모든 상품이 관련 키워드를 포함하고 있거나, 매칭 가능한 키워드가 없습니다.</p>';
    } else {
      html += cardsHtml;
    }

    container.innerHTML = html;
  } catch (error) {
    console.error('[loadTitleOptForShop] 오류:', error);
    container.innerHTML = `<p style="color:#ff6b6b;">오류: ${_esc(error.message)}</p>`;
  }
}

function _detectProductType(titleLower) {
  const TYPES = {
    drinkware: [
      'tumbler', 'bottle', 'cup', 'mug', 'caneca', 'garrafa', 'copo', 'bình', 'chai',
      'cốc', 'แก้ว', 'ขวด', 'กระติก', 'thermos', 'vacuum', 'vácuo', '보온', 'giữ nhiệt',
      'เก็บความเย็น', 'térmica', 'water bottle', 'botol'
    ],
    kitchenware: [
      'plate', 'bowl', 'spoon', 'fork', 'chopstick', 'cutlery', 'lunch box', 'bento',
      'lancheira', 'prato', 'tigela', 'colher', 'garfo', 'talheres', 'noodle bowl',
      'tableware', 'dinner plate', 'đĩa', 'bát', 'thìa', 'nĩa', 'hộp cơm',
      'จาน', 'ชาม', 'ช้อน', 'ส้อม', 'กล่องข้าว', 'esponja', 'cozinha', 'sponge',
      'kitchen', 'rice', 'mold', 'tong', 'kotak makan', 'sendok', 'sumpit', 'garpu'
    ],
    bag_pouch: [
      'bag', 'pouch', 'purse', 'wallet', 'tote', 'sling', 'backpack', 'bolsa', 'carteira',
      'mochila', 'túi', 'ví', 'balo', 'กระเป๋า', 'sac', 'clutch', 'coin purse',
      'drawstring', 'string pouch', 'bagcharm', 'coin holder', 'dây', 'tas'
    ],
    stationery: [
      'pen', 'pencil', 'highlighter', 'marker', 'notebook', 'memo', 'sticker', 'note',
      'scissors', 'eraser', 'ruler', 'stapler', 'tape', 'bút', 'sổ', 'nhãn dán', 'kéo',
      'giấy', 'ปากกา', 'ดินสอ', 'สมุด', 'สติ๊กเกอร์', 'กรรไกร', 'caneta', 'lápis',
      'caderno', 'adesivo', 'tesoura', 'marcador', 'papel', 'letter set', 'sticky',
      'calculator', 'calculadora'
    ],
    beauty: [
      'makeup', 'puff', 'foundation', 'cushion', 'lipstick', 'lip tint', 'mascara',
      'eyeliner', 'blush', 'powder', 'serum', 'toner', 'cleanser', 'sunscreen', 'cream',
      'mask', 'moistur', 'skincare', 'beauty', 'lotion', 'concealer', 'primer', 'balm',
      'son', 'phấn', 'sữa rửa mặt', 'kem', 'nước tẩy trang', 'bông tẩy',
      'ลิป', 'แป้ง', 'ครีม', 'มาสก์', 'ครีมกันแดด', 'maquiagem', 'batom', 'protetor',
      'shampoo', 'conditioner', 'dầu gội', 'แชมพู', 'wash', 'sabonete', 'hair wax',
      'pomade', 'dashu', 'styling', 'brush', 'puff', 'sponge makeup'
    ],
    plush_doll: [
      'doll', 'plush', 'cushion', 'pillow', 'stuffed', 'búp bê', 'gối', 'đệm',
      'ตุ๊กตา', 'หมอน', 'เบาะ', 'boneca', 'pelúcia', 'almofada', 'figurine',
      'figure stamp', 'mascot'
    ],
    keyring_accessory: [
      'keyring', 'keychain', 'charm', 'key chain', 'key ring', 'móc khóa',
      'พวงกุญแจ', 'chaveiro', 'pingente', 'llavero', 'hair band', 'scrunchie',
      'hair pin', 'hair clip', 'kẹp tóc', 'dây buộc', 'ยางรัดผม', 'ปิ่นปักผม',
      'กิ๊บ', 'tiara', 'headband', 'ribbon'
    ],
    clock_electronic: [
      'clock', 'watch', 'alarm', 'digital', 'timer', 'đồng hồ', 'นาฬิกา', 'relógio',
      'cronómetro', 'charger', 'cable', 'wireless', 'mouse', 'pad', 'keyboard',
      'carregador', 'mini fan'
    ],
    home_decor: [
      'decor', 'decoration', 'lamp', 'light', 'mirror', 'shelf', 'rack', 'frame',
      'mat', 'carpet', 'rug', 'gương', 'đèn', 'kệ', 'trang trí', 'ชั้นวาง',
      'กระจก', 'โคม', 'espelho', 'luminária', 'prateleira', 'wallpaper', 'quadro',
      'trivet', 'coaster', 'tapete'
    ],
    toy: [
      'toy', 'mainan', 'baby bus', 'tayo', 'pinkfong', 'game', 'puzzle',
      'transformasi', 'robot', 'car', 'bus', 'building block'
    ]
  };

  for (const [type, words] of Object.entries(TYPES)) {
    for (const w of words) {
      if (titleLower.includes(w)) return type;
    }
  }
  return '';
}

function _findMatchingKeywords(productType, topKeywords, titleLower) {
  if (!productType) return [];

  const results = [];
  for (const kw of topKeywords) {
    const kwLower = (kw.keyword || '').toLowerCase();
    if (_isKwInTitle(titleLower, kwLower)) continue;
    const kwType = _detectProductType(kwLower);
    if (kwType === productType) {
      results.push(kw);
      if (results.length >= 3) break;
    }
  }
  return results;
}

function _isKwInTitle(titleLower, kwLower) {
  if (!titleLower || !kwLower) return false;

  const t = _norm(titleLower);
  const k = _norm(kwLower);
  if (t.includes(k)) return true;

  const words = k.split(/\s+/).filter(w => w.length > 1);
  if (words.length > 1 && words.every(w => t.includes(w))) return true;

  return false;
}

function _norm(text) {
  if (!text) return '';
  return String(text).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').trim();
}

function _buildTitle(originalTitle, keyword) {
  const brandMatch = originalTitle.match(/^(\[[^\]]+\])\s*/);
  if (brandMatch) {
    const brand = brandMatch[1];
    const rest = originalTitle.slice(brandMatch[0].length);
    return `${brand} ${keyword.charAt(0).toUpperCase() + keyword.slice(1)} ${rest}`;
  }
  return `${keyword.charAt(0).toUpperCase() + keyword.slice(1)} - ${originalTitle}`;
}

function _esc(text) {
  if (!text) return '';
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// === 키워드 분석 탭: 매칭 현황 포함 렌더링 ===
async function renderKeywordAnalysis() {
  const container = document.getElementById('tab-keyword-analysis') || document.getElementById('keywordContent');
  if (!container) return;

  const shopsRes = await sendMsg({ type: 'GET_SHOPS' });
  const shops = (shopsRes && shopsRes.success && shopsRes.data) ? shopsRes.data : [];

  let allTopKw = [];
  let allTrendKw = [];
  let allProducts = [];

  for (const shop of shops) {
    const sid = shop.shop_id || shop.cnsc_shop_id || '';
    const region = shop.region || 'sg';
    const shopName = shop.name || shop.shop_name || 'Shop';

    try {
      const [kwRes, prodRes] = await Promise.all([
        sendMsg({ type: 'GET_KEYWORDS', shopId: sid, region }),
        sendMsg({ type: 'GET_PRODUCTS', shopId: sid, region })
      ]);

      if (kwRes?.success && kwRes.data) {
        (kwRes.data.topKeywords || []).forEach(k => {
          allTopKw.push({ ...k, shopName, region: region.toUpperCase(), shopId: sid });
        });
        (kwRes.data.trendingKeywords || []).forEach(k => {
          allTrendKw.push({ ...k, shopName, region: region.toUpperCase(), shopId: sid });
        });
      }

      if (prodRes?.success && prodRes.data) {
        prodRes.data.forEach(p => {
          allProducts.push({ ...p, shopId: sid, region: region.toUpperCase() });
        });
      }
    } catch (e) {}
  }

  allTopKw.sort((a, b) => (b.search_volume || 0) - (a.search_volume || 0));
  allTrendKw.sort((a, b) => (b.growth || 0) - (a.growth || 0));

  const topKwWithMatch = allTopKw.slice(0, 30).map(k => {
    const shopProducts = allProducts.filter(p => p.shopId === k.shopId);
    const matched = shopProducts.filter(p => isKeywordMatch(p.name || '', k.keyword || ''));
    return {
      ...k,
      matchCount: matched.length,
      totalProducts: shopProducts.length,
      matchedProducts: matched.slice(0, 3).map(p => (p.name || '').substring(0, 30))
    };
  });

  const topKwHtml = topKwWithMatch.map(k => {
    const vol = Number(k.search_volume || 0).toLocaleString();
    const matchClass = k.matchCount === 0 ? 'kw-match-zero' : k.matchCount < 3 ? 'kw-match-low' : 'kw-match-ok';
    const matchTooltip = k.matchedProducts.length > 0
      ? `매칭 상품: ${k.matchedProducts.join(', ')}`
      : '매칭 상품 없음 — 제목에 이 키워드를 추가하세요!';

    return `<div class="kw-row">
      <div class="kw-info">
        <span class="shop-badge">[${k.region}]</span>
        <span class="kw-name">${k.keyword}</span>
      </div>
      <span class="kw-vol">${vol}</span>
      <span class="kw-match ${matchClass}" title="${matchTooltip}">${k.matchCount}/${k.totalProducts}개 매칭 ${k.matchCount === 0 ? '⚠️' : '✅'}</span>
    </div>`;
  }).join('');

  const trendKwHtml = allTrendKw.slice(0, 20).map(k => {
    return `<div class="kw-row">
      <div class="kw-info">
        <span class="shop-badge">[${k.region}]</span>
        <span class="kw-name">${k.keyword}</span>
      </div>
      <span class="kw-trend">↑${k.growth || '?'}x</span>
    </div>`;
  }).join('');

  container.innerHTML = `
    <div class="keyword-columns">
      <div class="keyword-col">
        <h3 class="keyword-col-title">🔥 인기 키워드 <span style="color:#888;font-size:12px;">(검색량 순)</span></h3>
        ${topKwHtml || '<p style="color:#888;">데이터 없음</p>'}
      </div>
      <div class="keyword-col">
        <h3 class="keyword-col-title">🚀 트렌딩 키워드 <span style="color:#888;font-size:12px;">(급상승 순)</span></h3>
        ${trendKwHtml || '<p style="color:#888;">데이터 없음</p>'}
      </div>
    </div>`;
}


function onTabSwitch(tabName) {
  switch (tabName) {
    case 'products':
      renderProducts();
      break;
    case 'product-list':
      renderProductList('all');
      break;
    case 'title-optimization':
    case 'title-opt':
    case 'title':
      initTitleOptTab();
      break;
    case 'keyword-analysis':
      renderKeywordAnalysis();
      break;
    case 'ai-optimize':
    case 'ai':
      initAITab();
      break;
    case 'freshness':
      renderFreshness();
      break;
    default:
      break;
  }
}
