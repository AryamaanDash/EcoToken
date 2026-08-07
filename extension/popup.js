(() => {
  const ENABLED_KEY = "ecotokenEnabled";
  const ANALYTICS_KEY = "ecotokenAnalytics";

  const toggle = document.querySelector("#extension-toggle");
  const statusRow = document.querySelector(".status-row");
  const statusText = document.querySelector("#status-text");
  const costSaved = document.querySelector("#cost-saved");
  const co2Saved = document.querySelector("#co2-saved");
  const promptCount = document.querySelector("#prompt-count");
  const emptyNote = document.querySelector("#empty-note");
  const dashboardButton = document.querySelector("#dashboard-button");

  const extensionApi = globalThis.chrome;
  const storage = extensionApi?.storage?.local;

  function renderEnabled(enabled) {
    toggle.checked = enabled;
    statusRow.classList.toggle("disabled", !enabled);
    statusText.textContent = enabled ? "Protection active on Gemini" : "EcoToken is paused";
  }

  function formatCost(value) {
    if (value > 0 && value < 0.000001) {
      return "<$0.000001";
    }

    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: value < 0.01 ? 6 : 2,
      maximumFractionDigits: value < 0.01 ? 6 : 4
    }).format(value);
  }

  function formatCo2(grams) {
    if (grams >= 1000) {
      return `${(grams / 1000).toFixed(2)} kg`;
    }
    if (grams > 0 && grams < 0.001) {
      return "<0.001 g";
    }
    return `${grams < 1 ? grams.toFixed(3) : grams.toFixed(2)} g`;
  }

  function renderAnalytics(analytics = {}) {
    const prompts = Number(analytics.promptsOptimized ?? 0);
    costSaved.textContent = formatCost(Number(analytics.inferenceCostSaved ?? 0));
    co2Saved.textContent = formatCo2(Number(analytics.estimatedCo2SavedG ?? 0));
    promptCount.textContent = `${prompts.toLocaleString()} ${prompts === 1 ? "prompt" : "prompts"}`;
    emptyNote.classList.toggle("hidden", prompts > 0);
  }

  async function initialize() {
    if (!storage) {
      renderEnabled(true);
      renderAnalytics();
      return;
    }

    const stored = await storage.get([ENABLED_KEY, ANALYTICS_KEY]);
    renderEnabled(stored[ENABLED_KEY] !== false);
    renderAnalytics(stored[ANALYTICS_KEY]);
  }

  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked;
    renderEnabled(enabled);
    if (storage) {
      await storage.set({ [ENABLED_KEY]: enabled });
    }
  });

  dashboardButton.addEventListener("click", () => {
    const analyticsUrl = extensionApi?.runtime?.getURL
      ? extensionApi.runtime.getURL("analytics/index.html")
      : "analytics/index.html";

    if (extensionApi?.tabs?.create) {
      extensionApi.tabs.create({ url: analyticsUrl });
    } else {
      window.open(analyticsUrl, "_blank", "noopener");
    }
  });

  extensionApi?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && changes[ANALYTICS_KEY]) {
      renderAnalytics(changes[ANALYTICS_KEY].newValue);
    }
  });

  initialize().catch(() => {
    renderEnabled(true);
    renderAnalytics();
  });
})();
