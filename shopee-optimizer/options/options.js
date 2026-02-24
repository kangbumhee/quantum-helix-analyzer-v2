(function () {
  const DEFAULTS = {
    geminiKey: '',
    geminiModel: 'gemini-2.0-flash',
    maxTitleLength: 120,
    keywordPosition: 'front',
    keepBrand: 'always',
    freshnessRotationEnabled: false,
    productsPerDay: 7,
    rotationInterval: 7,
    approvalRequired: true,
    autoBackup: true,
    autoAnalyzeInterval: 24,
    notificationsEnabled: true
  };

  const FIELDS = {
    text: ['geminiKey', 'maxTitleLength', 'productsPerDay', 'rotationInterval', 'autoAnalyzeInterval'],
    select: ['geminiModel', 'keywordPosition', 'keepBrand'],
    checkbox: ['freshnessRotationEnabled', 'approvalRequired', 'autoBackup', 'notificationsEnabled']
  };

  async function loadSettings() {
    const data = await chrome.storage.local.get(['optimizer_settings', 'optimizerSettings']);
    const settings = data.optimizer_settings || data.optimizerSettings || {};
    const merged = { ...DEFAULTS, ...settings };

    for (const id of FIELDS.text) {
      const el = document.getElementById(id);
      if (el) el.value = merged[id] ?? DEFAULTS[id];
    }
    for (const id of FIELDS.select) {
      const el = document.getElementById(id);
      if (el) el.value = merged[id] ?? DEFAULTS[id];
    }
    for (const id of FIELDS.checkbox) {
      const el = document.getElementById(id);
      if (el) el.checked = merged[id] ?? DEFAULTS[id];
    }
  }

  function collectSettings() {
    const settings = {};
    for (const id of FIELDS.text) {
      const el = document.getElementById(id);
      if (el) {
        settings[id] = el.type === 'number' ? parseInt(el.value, 10) || DEFAULTS[id] : el.value;
      }
    }
    for (const id of FIELDS.select) {
      const el = document.getElementById(id);
      if (el) settings[id] = el.value;
    }
    for (const id of FIELDS.checkbox) {
      const el = document.getElementById(id);
      if (el) settings[id] = el.checked;
    }
    return settings;
  }

  async function saveSettings() {
    const settings = collectSettings();
    await chrome.storage.local.set({
      optimizer_settings: settings,
      optimizerSettings: settings
    });

    try {
      chrome.alarms.clear('auto_analyze');
      chrome.alarms.create('auto_analyze', {
        periodInMinutes: (settings.autoAnalyzeInterval || 24) * 60
      });
    } catch (e) {
      console.warn('Alarm update failed', e);
    }

    showToast('설정이 저장되었습니다.');
  }

  function resetSettings() {
    if (!confirm('설정을 초기값으로 되돌리시겠습니까?')) return;
    for (const id of FIELDS.text) {
      const el = document.getElementById(id);
      if (el) el.value = DEFAULTS[id];
    }
    for (const id of FIELDS.select) {
      const el = document.getElementById(id);
      if (el) el.value = DEFAULTS[id];
    }
    for (const id of FIELDS.checkbox) {
      const el = document.getElementById(id);
      if (el) el.checked = DEFAULTS[id];
    }
    showToast('기본값으로 초기화되었습니다. 저장을 눌러주세요.');
  }

  async function testApi() {
    const key = document.getElementById('geminiKey').value.trim();
    const model = document.getElementById('geminiModel').value;
    const resultEl = document.getElementById('testResult');

    if (!key) {
      resultEl.textContent = 'API 키를 입력하세요.';
      resultEl.className = 'fail';
      return;
    }

    resultEl.textContent = '테스트 중...';
    resultEl.className = '';

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Say "OK" in one word.' }] }],
          generationConfig: { maxOutputTokens: 10 }
        })
      });

      if (res.ok) {
        const json = await res.json();
        const reply = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        resultEl.textContent = `연결 성공! 응답: ${reply.trim()}`;
        resultEl.className = 'ok';
      } else {
        const err = await res.json().catch(() => ({}));
        resultEl.textContent = `오류 ${res.status}: ${err?.error?.message || '알 수 없는 오류'}`;
        resultEl.className = 'fail';
      }
    } catch (e) {
      resultEl.textContent = `네트워크 오류: ${e.message}`;
      resultEl.className = 'fail';
    }
  }

  function showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#7c4dff;color:#fff;padding:10px 24px;border-radius:8px;font-size:14px;z-index:999;opacity:0;transition:opacity 0.3s;';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  }

  document.getElementById('btnSave').addEventListener('click', saveSettings);
  document.getElementById('btnReset').addEventListener('click', resetSettings);
  document.getElementById('btnTestApi').addEventListener('click', testApi);

  loadSettings();
})();
