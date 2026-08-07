(() => {
  const chartRoot = document.querySelector("#energy-chart");
  if (!chartRoot) return;

  const svg = chartRoot.querySelector(".chart");
  const grid = svg.querySelector(".chart-grid");
  const area = svg.querySelector(".chart-area");
  const line = svg.querySelector(".chart-line");
  const pointsGroup = svg.querySelector(".chart-points");
  const labels = svg.querySelector(".chart-labels");
  const tooltip = chartRoot.querySelector(".chart-tooltip");

  const weights = [
    12, 14, 13, 17, 15, 10, 16, 19, 14, 11,
    15, 18, 16, 13, 9, 12, 14, 17, 20, 16,
    13, 11, 14, 18, 17, 12, 15, 19, 16, 14,
  ];
  const total = weights.reduce((sum, value) => sum + value, 0);
  const values = weights.map((value) => Number(((value / total) * 428).toFixed(1)));
  const roundedTotal = values.reduce((sum, value) => sum + value, 0);
  values[values.length - 1] = Number((values.at(-1) + (428 - roundedTotal)).toFixed(1));

  const width = 920;
  const height = 320;
  const inset = { top: 16, right: 10, bottom: 34, left: 42 };
  const plotWidth = width - inset.left - inset.right;
  const plotHeight = height - inset.top - inset.bottom;
  const maxValue = 24;
  const minDate = new Date("2026-07-09T12:00:00");

  const pointFor = (value, index) => ({
    x: inset.left + (index / (values.length - 1)) * plotWidth,
    y: inset.top + plotHeight - (value / maxValue) * plotHeight,
  });

  const points = values.map(pointFor);
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
  const baseline = height - inset.bottom;

  line.setAttribute("d", linePath);
  area.setAttribute(
    "d",
    `${linePath} L${points.at(-1).x.toFixed(2)},${baseline} L${points[0].x.toFixed(2)},${baseline} Z`,
  );

  const createSvgElement = (tag, attributes = {}) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
    return element;
  };

  [0, 6, 12, 18, 24].forEach((value) => {
    const y = inset.top + plotHeight - (value / maxValue) * plotHeight;
    grid.appendChild(
      createSvgElement("line", {
        x1: inset.left,
        x2: width - inset.right,
        y1: y,
        y2: y,
      }),
    );

    const label = createSvgElement("text", {
      x: inset.left - 10,
      y: y + 4,
      "text-anchor": "end",
    });
    label.textContent = value === 0 ? "0" : `${value} Wh`;
    labels.appendChild(label);
  });

  const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
  [0, 7, 14, 21, 29].forEach((index) => {
    const date = new Date(minDate);
    date.setDate(date.getDate() + index);
    const label = createSvgElement("text", {
      x: points[index].x,
      y: height - 8,
      "text-anchor": index === 0 ? "start" : index === 29 ? "end" : "middle",
    });
    label.textContent = dateFormatter.format(date);
    labels.appendChild(label);
  });

  const circles = points.map((point, index) => {
    const circle = createSvgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: 4.5,
      "data-index": index,
    });
    pointsGroup.appendChild(circle);
    return circle;
  });

  const showPoint = (index) => {
    circles.forEach((circle, circleIndex) => {
      circle.classList.toggle("active", circleIndex === index);
    });

    const date = new Date(minDate);
    date.setDate(date.getDate() + index);
    const svgRect = svg.getBoundingClientRect();
    const point = points[index];
    const x = (point.x / width) * svgRect.width;
    const y = (point.y / height) * svgRect.height;

    tooltip.innerHTML = `<strong>${values[index].toFixed(1)} Wh avoided</strong>${dateFormatter.format(date)}`;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    tooltip.classList.add("visible");
  };

  const hidePoint = () => {
    tooltip.classList.remove("visible");
    circles.forEach((circle) => circle.classList.remove("active"));
  };

  chartRoot.addEventListener("pointermove", (event) => {
    const bounds = svg.getBoundingClientRect();
    const relativeX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
    const index = Math.round((relativeX / bounds.width) * (values.length - 1));
    showPoint(index);
  });
  chartRoot.addEventListener("pointerleave", hidePoint);

  document.querySelectorAll('.nav-link[href^="#"]').forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".nav-link").forEach((item) => {
        item.classList.remove("active");
        item.removeAttribute("aria-current");
      });
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
    });
  });
})();
