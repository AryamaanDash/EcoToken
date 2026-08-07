(() => {
  const BACKEND_URL = "http://localhost:8000/api/optimize-gemini";
  const BADGE_ID = "everos-gemini-badge";
  const ENABLED_KEY = "ecotokenEnabled";
  const ANALYTICS_KEY = "ecotokenAnalytics";
  const PREPEND_MEMORY_CONTEXT = false;

  const MODEL_TIER_SYNONYMS = {
    lite: ["3.5 flash-lite", "flash-lite"],
    flash: ["3.6 flash", "flash"],
    pro: ["3.1 pro", "pro", "thinking"]
  };

  const MODEL_TIER_TO_EXACT_MODEL = {
    lite: "3.5 Flash-Lite",
    flash: "3.6 Flash",
    pro: "3.1 Pro"
  };

  const MODEL_TIER_BY_MODEL = {
    "llama3-8b": "lite",
    "llama3-70b": "pro",
    "claude-3-5-sonnet": "pro",
    "gemini-3.5-flash-lite": "lite",
    "gemini-3.6-flash": "flash",
    "gemini-3.1-pro": "pro",
    "3.5 flash-lite": "lite",
    "3.6 flash": "flash",
    "3.1 pro": "pro",
    "gemini-2.5-flash": "flash",
    "gemini-2.5-pro": "pro"
  };

  let lastPrompt = "";
  let activeRequestId = 0;
  let bypassInterception = false;
  let submissionInFlight = false;
  let cachedModelPickerButton = null;
  let modelPickerObserver = null;
  let isEnabled = false;

  function normalizeModelName(modelName) {
    return (modelName || "").toLowerCase().replace(/[^a-z0-9.-]/g, "");
  }

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && element.offsetParent !== null;
  }

  function getTextLabel(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    return [element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .trim();
  }

  function getTierKeywords(targetTier) {
    return MODEL_TIER_SYNONYMS[targetTier] || MODEL_TIER_SYNONYMS.lite;
  }

  function getExactModelLabel(targetTier) {
    return MODEL_TIER_TO_EXACT_MODEL[targetTier] || MODEL_TIER_TO_EXACT_MODEL.lite;
  }

  function resolveTargetTier(modelUsed, prompt) {
    const normalizedModel = normalizeModelName(modelUsed);
    if (normalizedModel in MODEL_TIER_BY_MODEL) {
      return MODEL_TIER_BY_MODEL[normalizedModel];
    }

    const promptWordCount = (prompt || "").trim().split(/\s+/).filter(Boolean).length;
    if (promptWordCount < 15) {
      return "lite";
    }

    if (promptWordCount <= 50) {
      return "flash";
    }

    return "pro";
  }

  function matchesRequestedModel(label, targetTier) {
    const exactLabel = getExactModelLabel(targetTier).toLowerCase();
    const keywords = getTierKeywords(targetTier);
    return label === exactLabel || label.includes(exactLabel) || keywords.some((keyword) => label.includes(keyword));
  }

  function ensureBadge() {
    if (!isEnabled) {
      return null;
    }

    let badge = document.getElementById(BADGE_ID);
    if (badge) {
      return badge;
    }

    badge = document.createElement("div");
    badge.id = BADGE_ID;
    badge.innerHTML = `
      <span class="everos-label">EcoToken Live Metrics</span>
      <div class="everos-metric">Ready</div>
      <div class="everos-subtext">Waiting for a Gemini prompt.</div>
    `;
    document.documentElement.appendChild(badge);
    return badge;
  }

  function setBadgeState({ metric, subtext, loading = false, error = false }) {
    const badge = ensureBadge();
    if (!badge) {
      return;
    }

    badge.classList.toggle("everos-loading", loading);
    badge.classList.toggle("everos-error", error);

    const metricNode = badge.querySelector(".everos-metric");
    const subtextNode = badge.querySelector(".everos-subtext");
    if (metricNode && metric) {
      metricNode.textContent = metric;
    }
    if (subtextNode && subtext) {
      subtextNode.textContent = subtext;
    }
  }

  function getPromptInput() {
    return document.querySelector('rich-textarea div[contenteditable="true"]');
  }

  function getPromptText(input) {
    if (!input) {
      return "";
    }

    return (input.innerText || input.textContent || "").trim();
  }

  function setPromptText(input, value) {
    if (!input) {
      return;
    }

    input.focus();
    input.textContent = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, composed: true }));
  }

  function maybePrependMemoryContext(input, memoryContext, originalPrompt) {
    if (!PREPEND_MEMORY_CONTEXT || !memoryContext || !input) {
      return;
    }

    const combined = `${memoryContext}\n\nUser prompt:\n${originalPrompt}`;
    setPromptText(input, combined);
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function waitForElement(predicate, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const immediate = predicate();
      if (immediate) {
        resolve(immediate);
        return;
      }

      let observer;
      const timerId = window.setTimeout(() => {
        if (observer) {
          observer.disconnect();
        }
        resolve(null);
      }, timeoutMs);

      observer = new MutationObserver(() => {
        const found = predicate();
        if (found) {
          observer.disconnect();
          window.clearTimeout(timerId);
          resolve(found);
        }
      });

      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  function findModelSwitcher() {
    const selectors = [
      ".model-picker-container button",
      'button[aria-haspopup="menu"]',
      'button[data-test-id="model-selector"]',
      'button[aria-label*="model"]',
      'button[title*="model"]',
      'button[aria-label*="gemini"]',
      'button[title*="gemini"]'
    ];

    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      for (const element of elements) {
        if (element instanceof HTMLElement && isElementVisible(element)) {
          return element;
        }
      }
    }

    const fallbackButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const element of fallbackButtons) {
      if (!(element instanceof HTMLElement) || !isElementVisible(element)) {
        continue;
      }

      const label = getTextLabel(element);
      if (label.includes("model") || label.includes("gemini") || label.includes("flash") || label.includes("pro") || label.includes("thinking")) {
        return element;
      }
    }

    return null;
  }

  function isCurrentSelection(button, targetTier) {
    const label = getTextLabel(button);
    return matchesRequestedModel(label, targetTier);
  }

  function findOpenMenuRoot() {
    const candidates = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], .mat-mdc-menu-panel, .cdk-overlay-pane'));
    return candidates.reverse().find((element) => element instanceof HTMLElement && isElementVisible(element)) || null;
  }

  function findMenuOption(targetTier) {
    const exactLabel = getExactModelLabel(targetTier).toLowerCase();
    const keywords = getTierKeywords(targetTier);
    const scopeRoots = [findOpenMenuRoot(), document.body].filter(Boolean);
    const selectors = ['[role="menuitem"]', '[role="option"]', '.mat-mdc-menu-item', 'button'];

    for (const root of scopeRoots) {
      for (const selector of selectors) {
        const candidates = Array.from(root.querySelectorAll(selector));
        for (const element of candidates) {
          if (!(element instanceof HTMLElement) || !isElementVisible(element)) {
            continue;
          }

          const label = getTextLabel(element);
          if (label === exactLabel || label.includes(exactLabel) || keywords.some((keyword) => label.includes(keyword))) {
            return element;
          }
        }
      }
    }

    return null;
  }

  function closeMenuSafely() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true
      })
    );
  }

  async function selectGeminiModel(targetTier) {
    const resolvedTier = ["lite", "flash", "pro"].includes(targetTier) ? targetTier : "lite";
    const exactLabel = getExactModelLabel(resolvedTier);
    const switcher = cachedModelPickerButton && isElementVisible(cachedModelPickerButton) ? cachedModelPickerButton : await waitForElement(findModelSwitcher);

    if (!switcher) {
      console.warn("[EcoToken] Model picker button not found.");
      return false;
    }

    cachedModelPickerButton = switcher;

    if (isCurrentSelection(switcher, resolvedTier)) {
      console.log(`[EcoToken] Gemini already set to ${exactLabel}.`);
      return true;
    }

    switcher.click();
    await wait(100);

    const option = await waitForElement(() => findMenuOption(resolvedTier), 2500);
    if (!option) {
      closeMenuSafely();
      console.warn(`[EcoToken] No matching model option found for ${exactLabel}.`);
      return false;
    }

    option.click();
    await wait(150);

    const refreshedButton = findModelSwitcher();
    if (refreshedButton) {
      cachedModelPickerButton = refreshedButton;
    }

    console.log(`[EcoToken] Selected Gemini model ${exactLabel}.`);
    return true;
  }

  function isSendButton(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const ariaLabel = (element.getAttribute("aria-label") || "").toLowerCase();
    const title = (element.getAttribute("title") || "").toLowerCase();
    const tooltip = (element.getAttribute("data-tooltip") || "").toLowerCase();
    const text = (element.textContent || "").toLowerCase();
    return ariaLabel.includes("send") || title.includes("send") || tooltip.includes("send") || text === "send";
  }

  function getSendButton() {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    return buttons.find((button) => button instanceof HTMLElement && isSendButton(button)) || null;
  }

  function triggerNativeSend() {
    const sendButton = getSendButton();
    if (sendButton) {
      bypassInterception = true;
      sendButton.click();
      window.setTimeout(() => {
        bypassInterception = false;
      }, 0);
      return true;
    }

    const input = getPromptInput();
    if (!input) {
      return false;
    }

    bypassInterception = true;
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true
      })
    );
    window.setTimeout(() => {
      bypassInterception = false;
    }, 0);
    return true;
  }

  function observeModelPicker() {
    if (modelPickerObserver) {
      return;
    }

    const target = document.querySelector(".model-picker-container") || document.body;
    if (!target) {
      return;
    }

    let scheduled = false;
    const refresh = () => {
      scheduled = false;
      const button = findModelSwitcher();
      if (button) {
        cachedModelPickerButton = button;
      }
    };

    modelPickerObserver = new MutationObserver(() => {
      if (scheduled) {
        return;
      }

      scheduled = true;
      window.requestAnimationFrame(refresh);
    });

    modelPickerObserver.observe(target, { childList: true, subtree: true, attributes: true });
    refresh();
  }

  async function postPrompt(prompt) {
    if (!isEnabled) {
      return;
    }

    const requestId = ++activeRequestId;
    setBadgeState({ metric: "Selecting", subtext: "Choosing Gemini model before send...", loading: true });

    try {
      const response = await fetch(BACKEND_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ prompt })
      });

      if (!response.ok) {
        throw new Error(`Backend request failed with ${response.status}`);
      }

      const payload = await response.json();
      if (requestId !== activeRequestId) {
        return;
      }

      const pctSaved = Number(payload.pct_saved ?? 0);
      const recommendedModel = payload.recommended_model ?? payload.model_used ?? "unknown-model";
      const targetTier = payload.target_tier || resolveTargetTier(payload.model_used || recommendedModel, prompt);
      const exactModelLabel = getExactModelLabel(targetTier);
      const memoryContext = payload.memory_context ?? "";

      await recordAnalytics(payload);
      await selectGeminiModel(targetTier);

      if (memoryContext) {
        maybePrependMemoryContext(getPromptInput(), memoryContext, prompt);
      }

      triggerNativeSend();

      setBadgeState({
        metric: `${pctSaved.toFixed(1)}% saved`,
        subtext: `Model: ${recommendedModel} -> ${exactModelLabel}${memoryContext ? " | Memory attached" : ""}`,
        loading: false
      });
    } catch (error) {
      if (requestId !== activeRequestId) {
        return;
      }

      setBadgeState({
        metric: "Offline",
        subtext: error instanceof Error ? error.message : "Unable to reach local optimizer.",
        loading: false,
        error: true
      });
    }
  }

  async function recordAnalytics(payload) {
    const baselineCost = Number(payload.baseline_cost ?? 0);
    const actualCost = Number(payload.actual_cost ?? 0);
    const costSaved = Math.max(0, baselineCost - actualCost);
    const co2SavedG = Math.max(0, Number(payload.estimated_co2_saved_g ?? 0));

    try {
      const stored = await chrome.storage.local.get(ANALYTICS_KEY);
      const current = stored[ANALYTICS_KEY] ?? {};
      await chrome.storage.local.set({
        [ANALYTICS_KEY]: {
          inferenceCostSaved: Number(current.inferenceCostSaved ?? 0) + costSaved,
          estimatedCo2SavedG: Number(current.estimatedCo2SavedG ?? 0) + co2SavedG,
          promptsOptimized: Number(current.promptsOptimized ?? 0) + 1,
          lastUpdated: new Date().toISOString()
        }
      });
    } catch (error) {
      console.warn("[EcoToken] Could not update local analytics.", error);
    }
  }

  function bindInteractions() {
    const input = getPromptInput();
    if (!input || input.dataset.everosBound === "true") {
      return;
    }

    input.dataset.everosBound = "true";

    input.addEventListener("keydown", (event) => {
      if (!isEnabled || bypassInterception || submissionInFlight || event.key !== "Enter" || event.shiftKey || event.isComposing) {
        return;
      }

      const prompt = getPromptText(input);
      if (!prompt) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      submissionInFlight = true;
      lastPrompt = prompt;

      setTimeout(async () => {
        try {
          await postPrompt(prompt);
        } finally {
          submissionInFlight = false;
        }
      }, 0);
    });

    document.addEventListener(
      "click",
      (event) => {
        if (!isEnabled || bypassInterception || submissionInFlight) {
          return;
        }

        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const button = target.closest('button, [role="button"]');
        if (!button || !isSendButton(button)) {
          return;
        }

        const prompt = getPromptText(input) || lastPrompt;
        if (!prompt) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        submissionInFlight = true;
        lastPrompt = prompt;

        setTimeout(async () => {
          try {
            await postPrompt(prompt);
          } finally {
            submissionInFlight = false;
          }
        }, 0);
      },
      true
    );
  }

  function injectStylesheet() {
    const existing = document.querySelector('link[data-everos-overlay="true"]');
    if (existing) {
      return;
    }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("overlay.css");
    link.dataset.everosOverlay = "true";
    (document.head || document.documentElement).appendChild(link);
  }

  function boot() {
    if (!isEnabled) {
      modelPickerObserver?.disconnect();
      modelPickerObserver = null;
      cachedModelPickerButton = null;
      document.getElementById(BADGE_ID)?.remove();
      return;
    }

    ensureBadge();
    injectStylesheet();
    observeModelPicker();
    bindInteractions();
  }

  const observer = new MutationObserver(() => {
    boot();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[ENABLED_KEY]) {
      return;
    }

    isEnabled = changes[ENABLED_KEY].newValue !== false;
    if (!isEnabled) {
      activeRequestId += 1;
    }
    boot();
  });

  chrome.storage.local.get(ENABLED_KEY).then((stored) => {
    isEnabled = stored[ENABLED_KEY] !== false;
    boot();
  });
})();
