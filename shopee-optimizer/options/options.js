// options/options.js
(function () {
  const DEFAULTS = {
    geminiKey: "",
    geminiModel: "gemini-2.5-flash",
    maxTitleLength: 120,
    keywordPosition: "front",
    keepBrand: "always",
    autoFreshness: true,
    dailyFreshness: 7,
    freshnessInterval: 7,
    requireApproval: true,
    autoBackup: true
  };

  const FIELDS = ["geminiKey", "geminiModel", "maxTitleLength", "keywordPosition", "keepBrand", "dailyFreshness", "freshnessInterval"];
  const TOGGLES = ["autoFreshness", "requireApproval", "autoBackup"];

  function load() {
    chrome.storage.local.get("optimizerSettings", (res) => {
      const s = Object.assign({}, DEFAULTS, res.optimizerSettings || {});
      FIELDS.forEach((f) => {
        const el = document.getElementById(f);
        if (el) el.value = s[f] || "";
      });
      TOGGLES.forEach((t) => {
        const el = document.getElementById(t);
        if (el) el.checked = !!s[t];
      });
    });
  }

  function save() {
    const s = {};
    FIELDS.forEach((f) => { s[f] = document.getElementById(f).value; });
    TOGGLES.forEach((t) => { s[t] = document.getElementById(t).checked; });
    s.maxTitleLength = parseInt(s.maxTitleLength, 10) || 120;
    s.dailyFreshness = parseInt(s.dailyFreshness, 10) || 7;
    s.freshnessInterval = parseInt(s.freshnessInterval, 10) || 7;
    chrome.storage.local.set({ optimizerSettings: s }, () => {
      showStatus("saveStatus", "✅ 설정이 저장되었습니다", "success");
    });
  }

  async function testKey() {
    const key = document.getElementById("geminiKey").value.trim();
    const model = document.getElementById("geminiModel").value;
    if (!key) {
      showStatus("keyStatus", "❌ API Key를 입력하세요", "error");
      return;
    }
    showStatus("keyStatus", "⏳ 테스트 중...", "success");
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Say OK in one word." }] }],
          generationConfig: { maxOutputTokens: 10 }
        })
      });
      const data = await res.json();
      if (data.candidates && data.candidates.length > 0) {
        showStatus("keyStatus", "✅ API Key 정상 작동! 모델: " + model, "success");
      } else if (data.error) {
        showStatus("keyStatus", "❌ 오류: " + data.error.message, "error");
      } else {
        showStatus("keyStatus", "⚠️ 알 수 없는 응답", "error");
      }
    } catch (e) {
      showStatus("keyStatus", "❌ 연결 실패: " + e.message, "error");
    }
  }

  function showStatus(id, msg, type) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.className = "status " + type;
  }

  document.addEventListener("DOMContentLoaded", () => {
    load();
    document.getElementById("btnSave").addEventListener("click", save);
    document.getElementById("btnTestKey").addEventListener("click", testKey);
    document.getElementById("btnReset").addEventListener("click", () => {
      chrome.storage.local.remove("optimizerSettings", () => {
        load();
        showStatus("saveStatus", "초기화 완료", "success");
      });
    });
  });
})();
