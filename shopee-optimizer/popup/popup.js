/*============================================================
  Popup Controller
  - 로그인 상태 확인
  - 샵 목록 표시
  - 분석 실행/결과 표시
============================================================*/

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // 진행상황 리스너
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ANALYSIS_PROGRESS') {
      showProgress(msg.message, msg.percent);
    }
  });

  // 로그인 확인
  try {
    var res = await sendMessage({ type: 'GET_SHOPS' });
    if (res && res.success && res.data && res.data.length > 0) {
      showLoginSuccess(res.data.length);
      renderShops(res.data);
      loadRecentResults();
    } else {
      showLoginError();
    }
  } catch (e) {
    showLoginError();
  }

  // 버튼 이벤트
  document.getElementById('btnAnalyzeAll').addEventListener('click', analyzeAll);
  document.getElementById('btnDashboard').addEventListener('click', openDashboard);
  document.getElementById('btnConnectCookie').addEventListener('click', async function () {
    var btn = document.getElementById('btnConnectCookie');
    btn.disabled = true;
    btn.textContent = '연결 중...';
    try {
      var res = await sendMessage({ type: 'CONNECT_VIA_COOKIE' });
      if (res && res.success) {
        showLoginSuccess(res.totalShops || 0);
        var shopRes = await sendMessage({ type: 'GET_SHOPS' });
        if (shopRes && shopRes.success && shopRes.data) {
          renderShops(shopRes.data);
        }
      } else {
        alert(res && res.error ? res.error : '연결 실패');
      }
    } catch (e) {
      alert('연결 실패: ' + (e && e.message ? e.message : e));
    }
    btn.disabled = false;
    btn.textContent = '🍪 쿠키 연결';
  });
}

// ── 메시지 헬퍼 (응답 없을 때 undefined 방지) ──
function sendMessage(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (response) {
      resolve(response != null ? response : { success: false, error: 'No response' });
    });
  });
}

// ── 로그인 상태 ──
function showLoginSuccess(shopCount) {
  const bar = document.getElementById('loginStatus');
  bar.className = 'status-bar success';
  document.getElementById('statusIcon').textContent = '✅';
  document.getElementById('statusText').textContent = `로그인됨 — ${shopCount}개 샵 감지`;
  document.getElementById('shopList').style.display = 'block';
  document.getElementById('actions').style.display = 'block';
}

function showLoginError() {
  const bar = document.getElementById('loginStatus');
  bar.className = 'status-bar error';
  document.getElementById('statusIcon').textContent = '❌';
  document.getElementById('statusText').textContent = 'Shopee Seller Center에 먼저 로그인하세요';
}

// ── 샵 목록 렌더링 (name/shop_name null 방어) ──
function renderShops(shops) {
  if (!shops || !shops.length) return;
  var container = document.getElementById('shops');
  var name, region;
  container.innerHTML = shops.map(function (shop) {
    name = (shop.name != null ? shop.name : shop.shop_name) || '';
    region = (shop.region != null ? String(shop.region) : '') || 'sg';
    return '<div class="shop-card" data-shop-id="' + shop.shop_id + '" data-region="' + region.toLowerCase() + '" data-name="' + String(name).replace(/"/g, '&quot;') + '">' +
      '<div><span class="shop-name">' + name + '</span></div>' +
      '<div style="display:flex;gap:6px;align-items:center;">' +
      '<span class="shop-region">' + region.toUpperCase() + '</span>' +
      '<span class="shop-score" id="score-' + shop.shop_id + '">—</span></div></div>';
  }).join('');

  // 개별 샵 클릭 → 분석
  container.querySelectorAll('.shop-card').forEach(card => {
    card.addEventListener('click', () => {
      analyzeSingleShop(
        card.dataset.shopId,
        card.dataset.region,
        card.dataset.name
      );
    });
  });
}

// ── 개별 샵 분석 ──
async function analyzeSingleShop(shopId, region, name) {
  document.getElementById('progress').style.display = 'block';
  document.getElementById('btnAnalyzeAll').disabled = true;

  const res = await sendMessage({
    type: 'ANALYZE_SHOP',
    shopId,
    region,
    shopName: name
  });

  document.getElementById('btnAnalyzeAll').disabled = false;

  if (res.success) {
    updateShopScore(shopId, res.data.score);
    loadRecentResults();
  } else {
    showProgress('❌ 분석 실패: ' + res.error, 0);
  }
}

// ── 전체 분석 ──
async function analyzeAll() {
  document.getElementById('progress').style.display = 'block';
  document.getElementById('btnAnalyzeAll').disabled = true;

  const res = await sendMessage({ type: 'ANALYZE_ALL' });

  document.getElementById('btnAnalyzeAll').disabled = false;

  if (res.success) {
    res.data.forEach(report => {
      if (report.shopId) {
        updateShopScore(report.shopId, report.score);
      }
    });
    loadRecentResults();
  }
}

// ── 진행상황 ──
function showProgress(message, percent) {
  document.getElementById('progress').style.display = 'block';
  document.getElementById('progressFill').style.width = percent + '%';
  document.getElementById('progressText').textContent = message;
}

// ── 점수 업데이트 ──
function updateShopScore(shopId, score) {
  const el = document.getElementById(`score-${shopId}`);
  if (!el) return;
  el.textContent = score;
  el.className = 'shop-score ' + (score >= 70 ? 'score-good' : score >= 40 ? 'score-warn' : 'score-bad');
}

// ── 최근 결과 로드 ──
async function loadRecentResults() {
  const res = await sendMessage({ type: 'GET_ALL_REPORTS' });
  if (!res.success || !res.data) return;

  const container = document.getElementById('resultCards');
  const reports = Object.values(res.data).filter(r => r && r.shopName);

  if (reports.length === 0) return;

  document.getElementById('recentResults').style.display = 'block';

  reports.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  container.innerHTML = reports.slice(0, 5).map(r => {
    const critCount = r.issues ? r.issues.filter(i => i.severity === 'CRITICAL').length : 0;
    const highCount = r.issues ? r.issues.filter(i => i.severity === 'HIGH').length : 0;
    const medCount = r.issues ? r.issues.filter(i => i.severity === 'MEDIUM').length : 0;

    return `
      <div class="result-card">
        <div class="result-header">
          <span class="result-name">${r.shopName} (${r.region})</span>
          <span class="shop-score ${r.score >= 70 ? 'score-good' : r.score >= 40 ? 'score-warn' : 'score-bad'}">${r.score}점</span>
        </div>
        <div class="result-issues">
          ${critCount > 0 ? `<span class="issue-badge issue-critical">심각 ${critCount}</span>` : ''}
          ${highCount > 0 ? `<span class="issue-badge issue-high">높음 ${highCount}</span>` : ''}
          ${medCount > 0 ? `<span class="issue-badge issue-medium">보통 ${medCount}</span>` : ''}
        </div>
        <div class="result-stats">
          <span>상품 ${r.summary?.totalProducts || 0}</span>
          <span>조회 ${r.summary?.totalViews || 0}</span>
          <span>판매 ${r.summary?.totalSold || 0}</span>
          <span>키워드 ${r.keywordAudit?.matchRate || 0}%</span>
        </div>
      </div>
    `;
  }).join('');
}

// ── 대시보드 열기 ──
function openDashboard() {
  sendMessage({ type: 'OPEN_DASHBOARD' });
}
