(() => {
  const BACKEND_URL = "http://localhost:8000/api/optimize-gemini";
  const BADGE_ID = "everos-gemini-badge";
  const PREPEND_MEMORY_CONTEXT = false;

  let lastPrompt = "";
  let activeRequestId = 0;

  function normalizeModelName(modelName) {
    return (modelName || "").toLowerCase().replace(/[^a-z0-9.-]/g, "");
  }

  function findModelSwitcher() {
    const selectors = [
      'button[aria-label*="model"]',
      'button[title*="model"]',
      '[role="menuitem"]',
      '[role="option"]'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLElement) {
        return element;
      }
    }

    return null;
  }

  function applyGeminiModelSelection(recommendedModel) {
    const switcher = findModelSwitcher();
    if (!switcher) {
      return false;
    }

    const normalized = normalizeModelName(recommendedModel);
    const label = [switcher.getAttribute("aria-label"), switcher.getAttribute("title"), switcher.textContent]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (label.includes(normalized) || label.includes("gemini")) {
      switcher.click();
      return true;
    }

    return false;
  }

  function ensureBadge() {
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

  async function postPrompt(prompt) {
    const requestId = ++activeRequestId;
    setBadgeState({ metric: "Analyzing", subtext: "Sending prompt to local optimizer...", loading: true });

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
      const modelUsed = payload.model_used ?? "unknown-model";
      const memoryContext = payload.memory_context ?? "";

      applyGeminiModelSelection(recommendedModel);

      setBadgeState({
        metric: `${pctSaved.toFixed(1)}% saved`,
        subtext: `Model: ${recommendedModel}${memoryContext ? ` | Memory attached` : ""}`,
        loading: false
      });

      const input = getPromptInput();
      maybePrependMemoryContext(input, memoryContext, prompt);
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

  function bindInteractions() {
    const input = getPromptInput();
    if (!input || input.dataset.everosBound === "true") {
      return;
    }

    input.dataset.everosBound = "true";

    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
        return;
      }

      const prompt = getPromptText(input);
      if (!prompt) {
        return;
      }

      lastPrompt = prompt;
      setTimeout(() => postPrompt(prompt), 0);
    });

    document.addEventListener(
      "click",
      (event) => {
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

        lastPrompt = prompt;
        setTimeout(() => postPrompt(prompt), 0);
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
    document.head.appendChild(link);
  }

  function boot() {
    ensureBadge();
    injectStylesheet();
    bindInteractions();
  }

  const observer = new MutationObserver(() => {
    boot();
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  boot();
})();
