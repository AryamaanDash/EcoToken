(() => {
  const ANALYTICS_KEY = "ecotokenAnalytics";
  const extensionApi = globalThis.chrome;
  const storage = extensionApi?.storage?.local;
  const periodButtons = [...document.querySelectorAll("[data-period]")];
  const storageStatus = document.querySelector(".storage-status");
  const storageStatusText = document.querySelector("#storage-status-text");
  const dataNotice = document.querySelector("#data-notice");
  const dataNoticeTitle = document.querySelector("#data-notice-title");
  const dataNoticeCopy = document.querySelector("#data-notice-copy");

  let analytics = {};
  let selectedPeriod = 7;

  const numberFormatter = new Intl.NumberFormat("en-US");
  const shortDateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short" });

  function dateKey(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function emptyBucket(label, longLabel) {
    return {
      label,
      longLabel,
      prompts: 0,
      inferenceCostSaved: 0,
      estimatedCo2SavedG: 0,
      tierCounts: { light: 0, mid: 0, heavy: 0 }
    };
  }

  function addDailyRecord(bucket, record = {}) {
    bucket.prompts += Number(record.prompts ?? 0);
    bucket.inferenceCostSaved += Number(record.inferenceCostSaved ?? 0);
    bucket.estimatedCo2SavedG += Number(record.estimatedCo2SavedG ?? 0);
    const tiers = record.tierCounts ?? {};
    bucket.tierCounts.light += Number(tiers.light ?? 0);
    bucket.tierCounts.mid += Number(tiers.mid ?? 0);
    bucket.tierCounts.heavy += Number(tiers.heavy ?? 0);
  }

  function buildBuckets(period) {
    const daily = analytics.daily && typeof analytics.daily === "object" ? analytics.daily : {};
    const today = new Date();

    if (period === 365) {
      const buckets = [];
      const monthLookup = new Map();
      for (let index = 11; index >= 0; index -= 1) {
        const date = new Date(today.getFullYear(), today.getMonth() - index, 1);
        const key = monthKey(date);
        const label = monthFormatter.format(date);
        const bucket = emptyBucket(label, `${label} ${date.getFullYear()}`);
        monthLookup.set(key, bucket);
        buckets.push(bucket);
      }

      Object.entries(daily).forEach(([key, record]) => {
        const bucket = monthLookup.get(key.slice(0, 7));
        if (bucket) addDailyRecord(bucket, record);
      });
      return buckets;
    }

    const buckets = [];
    for (let index = period - 1; index >= 0; index -= 1) {
      const date = new Date(today);
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - index);
      const label = shortDateFormatter.format(date);
      const bucket = emptyBucket(label, label);
      addDailyRecord(bucket, daily[dateKey(date)]);
      buckets.push(bucket);
    }
    return buckets;
  }

  function summarize(buckets) {
    return buckets.reduce(
      (summary, bucket) => {
        summary.prompts += bucket.prompts;
        summary.inferenceCostSaved += bucket.inferenceCostSaved;
        summary.estimatedCo2SavedG += bucket.estimatedCo2SavedG;
        summary.tierCounts.light += bucket.tierCounts.light;
        summary.tierCounts.mid += bucket.tierCounts.mid;
        summary.tierCounts.heavy += bucket.tierCounts.heavy;
        return summary;
      },
      {
        prompts: 0,
        inferenceCostSaved: 0,
        estimatedCo2SavedG: 0,
        tierCounts: { light: 0, mid: 0, heavy: 0 }
      }
    );
  }

  function formatCost(value, compact = false) {
    if (value > 0 && value < 0.000001) return "<$0.000001";
    if (compact) {
      if (value >= 1) return `$${value.toFixed(2)}`;
      if (value >= 0.01) return `$${value.toFixed(3)}`;
      return `$${value.toFixed(5)}`;
    }
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: value < 0.01 ? 6 : 2,
      maximumFractionDigits: value < 0.01 ? 6 : 4
    }).format(value);
  }

  function formatCo2(value, compact = false) {
    if (value >= 1000) return `${(value / 1000).toFixed(compact ? 1 : 2)} kg`;
    if (value > 0 && value < 0.001) return "<0.001 g";
    if (compact) return `${value < 1 ? value.toFixed(2) : value.toFixed(1)} g`;
    return `${value < 1 ? value.toFixed(3) : value.toFixed(2)} g`;
  }

  function createSvgElement(tag, attributes = {}) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  }

  function labelIndices(length) {
    return [...new Set([0, Math.floor((length - 1) / 2), length - 1])];
  }

  function renderChart(id, buckets, valueKey, formatter) {
    const svg = document.querySelector(`#${id}`);
    const frame = svg.closest(".chart-frame");
    const tooltip = frame.querySelector(".chart-tooltip");
    const emptyState = frame.querySelector(".chart-empty");
    const values = buckets.map((bucket) => Number(bucket[valueKey] ?? 0));
    const hasData = values.some((value) => value > 0);
    const hasRoutingData = buckets.some((bucket) => Number(bucket.prompts ?? 0) > 0);
    frame.classList.toggle("has-data", hasData);
    emptyState.textContent = hasRoutingData
      ? "0 avoided — selected routes matched the Pro baseline"
      : "No routing data in this period";
    svg.replaceChildren();

    const width = 760;
    const height = 280;
    const inset = { top: 16, right: 10, bottom: 34, left: 58 };
    const plotWidth = width - inset.left - inset.right;
    const plotHeight = height - inset.top - inset.bottom;
    const maxValue = Math.max(...values, 0) || 1;

    for (let index = 0; index <= 4; index += 1) {
      const ratio = index / 4;
      const y = inset.top + plotHeight - ratio * plotHeight;
      svg.appendChild(createSvgElement("line", {
        class: "grid-line",
        x1: inset.left,
        x2: width - inset.right,
        y1: y,
        y2: y
      }));
      const label = createSvgElement("text", {
        class: "axis-label",
        x: inset.left - 9,
        y: y + 4,
        "text-anchor": "end"
      });
      label.textContent = formatter(maxValue * ratio, true);
      svg.appendChild(label);
    }

    const points = values.map((value, index) => ({
      x: inset.left + (index / Math.max(1, values.length - 1)) * plotWidth,
      y: inset.top + plotHeight - (value / maxValue) * plotHeight
    }));
    const baseline = inset.top + plotHeight;
    const linePath = points
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
      .join(" ");

    const area = createSvgElement("path", {
      class: "area",
      d: `${linePath} L${points.at(-1).x.toFixed(2)},${baseline} L${points[0].x.toFixed(2)},${baseline} Z`
    });
    const line = createSvgElement("path", { class: "line", d: linePath });
    svg.append(area, line);

    labelIndices(buckets.length).forEach((index) => {
      const label = createSvgElement("text", {
        class: "axis-label",
        x: points[index].x,
        y: height - 8,
        "text-anchor": index === 0 ? "start" : index === buckets.length - 1 ? "end" : "middle"
      });
      label.textContent = buckets[index].label;
      svg.appendChild(label);
    });

    const cursor = createSvgElement("line", {
      class: "cursor-line",
      x1: points[0].x,
      x2: points[0].x,
      y1: inset.top,
      y2: baseline
    });
    const activePoint = createSvgElement("circle", {
      class: "active-point",
      cx: points[0].x,
      cy: points[0].y,
      r: 4.5
    });
    svg.append(cursor, activePoint);

    svg.onpointermove = (event) => {
      const bounds = svg.getBoundingClientRect();
      const relativeX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
      const scaledX = (relativeX / bounds.width) * width;
      const index = Math.min(
        buckets.length - 1,
        Math.max(0, Math.round(((scaledX - inset.left) / plotWidth) * (buckets.length - 1)))
      );
      const point = points[index];
      cursor.setAttribute("x1", point.x);
      cursor.setAttribute("x2", point.x);
      activePoint.setAttribute("cx", point.x);
      activePoint.setAttribute("cy", point.y);
      svg.classList.add("interacting");

      tooltip.innerHTML = `<strong>${formatter(values[index])}</strong>${buckets[index].longLabel}`;
      tooltip.style.left = `${(point.x / width) * bounds.width}px`;
      tooltip.style.top = `${(point.y / height) * bounds.height}px`;
      tooltip.classList.add("visible");
    };

    svg.onpointerleave = () => {
      svg.classList.remove("interacting");
      tooltip.classList.remove("visible");
    };
  }

  function render() {
    const buckets = buildBuckets(selectedPeriod);
    const summary = summarize(buckets);
    const allTimePrompts = Number(analytics.promptsOptimized ?? 0);
    const allTimeCost = Number(analytics.inferenceCostSaved ?? 0);
    const allTimeCo2 = Number(analytics.estimatedCo2SavedG ?? 0);
    const periodName = selectedPeriod === 7 ? "Last 7 days" : selectedPeriod === 30 ? "Last 30 days" : "Last 12 months";
    const periodTotalLabel = selectedPeriod === 7 ? "7-day total" : selectedPeriod === 30 ? "30-day total" : "12-month total";
    const granularityLabel = selectedPeriod === 365 ? "Monthly estimate" : "Daily estimate";

    document.querySelector("#range-title").textContent = periodName;
    document.querySelector("#all-time-prompts").textContent = numberFormatter.format(allTimePrompts);
    document.querySelector("#all-time-cost").textContent = formatCost(allTimeCost);
    document.querySelector("#all-time-co2").textContent = formatCo2(allTimeCo2);
    document.querySelector("#prompt-total").textContent = numberFormatter.format(summary.prompts);
    document.querySelector("#light-total").textContent = numberFormatter.format(summary.tierCounts.light);
    document.querySelector("#mid-total").textContent = numberFormatter.format(summary.tierCounts.mid);
    document.querySelector("#heavy-total").textContent = numberFormatter.format(summary.tierCounts.heavy);
    document.querySelector("#period-cost").textContent = formatCost(summary.inferenceCostSaved);
    document.querySelector("#period-co2").textContent = formatCo2(summary.estimatedCo2SavedG);
    document.querySelector("#cost-period-label").textContent = periodTotalLabel;
    document.querySelector("#co2-period-label").textContent = periodTotalLabel;
    document.querySelector("#cost-granularity").textContent = granularityLabel;
    document.querySelector("#co2-granularity").textContent = granularityLabel;

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - selectedPeriod + 1);
    document.querySelector("#date-range").textContent = `${shortDateFormatter.format(start)} – ${shortDateFormatter.format(today)}, ${today.getFullYear()}`;

    renderChart("cost-chart", buckets, "inferenceCostSaved", formatCost);
    renderChart("co2-chart", buckets, "estimatedCo2SavedG", formatCo2);
  }

  function showDataNotice(title, copy) {
    dataNoticeTitle.textContent = title;
    dataNoticeCopy.textContent = copy;
    dataNotice.hidden = false;
  }

  function updateDataHealth() {
    storageStatus.classList.remove("unavailable");

    if (!storage) {
      storageStatus.classList.add("unavailable");
      storageStatusText.textContent = "Web page cannot read extension data";
      showDataNotice(
        "Open the extension dashboard",
        "A normal web page cannot access Chrome extension storage. Use Open analytics dashboard in the EcoToken popup so this page opens with a chrome-extension:// address."
      );
      return;
    }

    const allTimePrompts = Number(analytics.promptsOptimized ?? 0);
    const daily = analytics.daily && typeof analytics.daily === "object" ? analytics.daily : {};
    const hasDatedHistory = Object.values(daily).some((record) => Number(record?.prompts ?? 0) > 0);

    if (allTimePrompts > 0 && (!hasDatedHistory || Number(analytics.schemaVersion ?? 0) < 2)) {
      storageStatus.classList.add("unavailable");
      storageStatusText.textContent = "Timeline refresh required";
      showDataNotice(
        "Timeline tracking needs a refresh",
        "Your all-time totals are available, but this Gemini tab is still writing the older undated format. Reload EcoToken on chrome://extensions, then reload the open Gemini tab. New routes will appear in the charts; older totals cannot be assigned to past dates accurately."
      );
      return;
    }

    dataNotice.hidden = true;
    storageStatusText.textContent = analytics.lastUpdated ? "Local data up to date" : "Waiting for first route";
  }

  periodButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedPeriod = Number(button.dataset.period);
      periodButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      render();
    });
  });

  async function initialize() {
    if (!storage) {
      analytics = {};
      updateDataHealth();
      render();
      return;
    }

    const stored = await storage.get(ANALYTICS_KEY);
    analytics = stored[ANALYTICS_KEY] ?? {};
    updateDataHealth();
    render();
  }

  extensionApi?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && changes[ANALYTICS_KEY]) {
      analytics = changes[ANALYTICS_KEY].newValue ?? {};
      updateDataHealth();
      render();
    }
  });

  initialize().catch(() => {
    storageStatus.classList.add("unavailable");
    storageStatusText.textContent = "Unable to read local data";
    showDataNotice(
      "Local analytics could not be read",
      "Reload this dashboard. If the issue remains, reload EcoToken on chrome://extensions and open the dashboard from the popup again."
    );
    render();
  });
})();
