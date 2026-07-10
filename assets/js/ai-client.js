(function attachPitaAiClient(global) {
  const PRESENTATION_ENDPOINT = "/.netlify/functions/presentation-ai";
  const INTERVIEW_ENDPOINT = "/.netlify/functions/gemini-interview";
  const DEFAULT_TIMEOUT_MS = 28000;

  async function postJson(endpoint, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = global.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      let data;

      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          text
            ? `AI 응답을 해석하지 못했습니다: ${text.slice(0, 160)}`
            : "AI 서버로부터 빈 응답을 받았습니다.",
        );
      }

      if (!response.ok) {
        const error = new Error(data.error || "AI 요청이 실패했습니다.");
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("AI 응답 시간이 초과되었습니다. 파일 크기를 줄이거나 다시 시도해주세요.");
      }
      throw error;
    } finally {
      global.clearTimeout(timeoutId);
    }
  }

  function presentationContextFromDom() {
    const type = document.getElementById("presentation-type-select");
    const audience = document.getElementById("audience-select");
    const selectedPurpose = document.querySelector(
      "[data-presentation-branch][aria-pressed='true']",
    );
    const selectedPersona = document.querySelector(
      "[data-persona-value][aria-pressed='true']",
    );

    return {
      presentationType: type?.selectedOptions?.[0]?.textContent?.trim() || type?.value || "",
      purpose:
        selectedPurpose?.querySelector("strong")?.textContent?.trim() ||
        selectedPurpose?.dataset.presentationBranch ||
        "",
      audience:
        audience?.selectedOptions?.[0]?.textContent?.trim() || audience?.value || "",
      personaGuidance:
        selectedPersona?.querySelector("span")?.textContent?.trim() || "",
      targetDurationSeconds: durationFromInputs("presentation-minutes", "presentation-seconds"),
      qaDurationSeconds: durationFromInputs("qa-minutes", "qa-seconds"),
    };
  }

  function durationFromInputs(minutesId, secondsId) {
    const minutes = Number(document.getElementById(minutesId)?.value || 0);
    const seconds = Number(document.getElementById(secondsId)?.value || 0);
    return Math.max(0, Math.round(minutes * 60 + seconds));
  }

  const presentation = {
    generateDraft({ materials = [], context, existingScript = "" } = {}) {
      return postJson(
        PRESENTATION_ENDPOINT,
        {
          task: "draft",
          materials,
          context: context || presentationContextFromDom(),
          existingScript,
        },
        30000,
      );
    },

    generateQuestions({ script, context, count = 6 } = {}) {
      return postJson(PRESENTATION_ENDPOINT, {
        task: "questions",
        script,
        context: context || presentationContextFromDom(),
        count,
      });
    },

    analyze({
      mode,
      script = "",
      mediaBase64 = null,
      mediaMimeType = null,
      context,
      measuredMetrics = {},
      previousSessions = [],
    } = {}) {
      return postJson(
        PRESENTATION_ENDPOINT,
        {
          task: "report",
          mode,
          script,
          mediaBase64,
          mediaMimeType,
          context: context || presentationContextFromDom(),
          measuredMetrics,
          previousSessions,
        },
        30000,
      );
    },
  };

  const interview = {
    generateQuestions(payload = {}) {
      return postJson(INTERVIEW_ENDPOINT, { mode: "questions", ...payload });
    },

    generateReport(payload = {}) {
      return postJson(INTERVIEW_ENDPOINT, { mode: "report", ...payload });
    },
  };

  global.PitaAI = Object.freeze({
    postJson,
    presentation: Object.freeze(presentation),
    interview: Object.freeze(interview),
    presentationContextFromDom,
  });
})(window);

/* ===========================================================
   Shared "종합 레포트" dashboard renderer (Figma node 120:765)
   Used by both presentation.js and interview.js so the layout,
   colors, and chart logic only live in one place.
   =========================================================== */
(function attachPitaReportUI(global) {
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function clamp(value, min = 0, max = 100, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function ringSvg({ value, size = 148, stroke = 10, color = "#00e5e5", track = "#262626" }) {
    const v = clamp(value, 0, 100, 0);
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const off = c * (1 - v / 100);
    const cx = size / 2;
    const cy = size / 2;
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" stroke-linecap="round"
        transform="rotate(-90 ${cx} ${cy})"/>
    </svg>`;
  }

  function donutBlock({ value, size = 148, stroke = 10, color = "#00e5e5", valueSize = 32, label = "" }) {
    return `
      <div class="rd-donut-wrap" style="position:relative;width:${size}px;height:${size}px;margin-left:auto;margin-right:auto;">
        ${ringSvg({ value, size, stroke, color })}
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
          <strong style="font-size:${valueSize}px;font-weight:700;color:#f5f5f5;line-height:1;">${Math.round(clamp(value))}${size >= 100 ? "%" : ""}</strong>
          ${label ? `<span style="font-size:11px;color:#8a8a8a;margin-top:6px;">${escapeHtml(label)}</span>` : ""}
        </div>
      </div>
    `;
  }

  function miniRing({ value, color = "#00e5e5", size = 56 }) {
    return `
      <div style="position:relative;width:${size}px;height:${size}px;flex-shrink:0;">
        ${ringSvg({ value, size, stroke: 6, color })}
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#f5f5f5;">${Math.round(clamp(value))}</div>
      </div>
    `;
  }

  function radarSvg({ labels, mine, avg, size = 220 }) {
    const n = labels.length || 1;
    const cx = size / 2;
    const cy = size / 2;
    const maxR = size * 0.34;
    const fixed = (i, R) => {
      const a = (i / n) * 2 * Math.PI - Math.PI / 2;
      return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
    };
    const pt = (v, i, R) => {
      const a = (i / n) * 2 * Math.PI - Math.PI / 2;
      const ratio = clamp(v, 0, 100, 0) / 100;
      return { x: cx + R * ratio * Math.cos(a), y: cy + R * ratio * Math.sin(a) };
    };
    const pathFor = (points) =>
      points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") + "Z";

    let html = "";
    for (let ring = 1; ring <= 4; ring += 1) {
      const r = (maxR * ring) / 4;
      const pts = Array.from({ length: n }, (_, i) => fixed(i, r));
      html += `<path d="${pathFor(pts)}" fill="none" stroke="#333" stroke-width="${ring === 4 ? 1.2 : 0.7}" opacity="${ring === 4 ? 0.8 : 0.35}"/>`;
    }
    for (let i = 0; i < n; i += 1) {
      const o = fixed(i, maxR);
      html += `<line x1="${cx}" y1="${cy}" x2="${o.x.toFixed(1)}" y2="${o.y.toFixed(1)}" stroke="#333" stroke-width="1"/>`;
    }
    const avgPts = (avg || []).map((v, i) => pt(v, i, maxR));
    if (avgPts.length === n) {
      html += `<path d="${pathFor(avgPts)}" fill="rgba(138,138,138,0.08)" stroke="#8a8a8a" stroke-width="1.5"/>`;
    }
    const minePts = (mine || []).map((v, i) => pt(v, i, maxR));
    if (minePts.length === n) {
      html += `<path d="${pathFor(minePts)}" fill="rgba(0,229,229,0.12)" stroke="#00e5e5" stroke-width="2"/>`;
      minePts.forEach((p) => {
        html += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#00e5e5"/>`;
      });
    }
    labels.forEach((label, i) => {
      const lp = fixed(i, maxR + 16);
      html += `<text x="${lp.x.toFixed(1)}" y="${(lp.y + 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#8a8a8a">${escapeHtml(label)}</text>`;
    });
    return `<svg width="100%" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;">${html}</svg>`;
  }

  function waveBars(seedBase, count = 20) {
    let seed = Math.max(1, Math.round(Math.abs(seedBase) || 50));
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    const bars = [];
    for (let i = 0; i < count; i += 1) {
      bars.push(24 + Math.round(rand() * 76));
    }
    return bars;
  }

  function waveBlock(seed) {
    const bars = waveBars(seed);
    const inner = bars
      .map((h, i) => {
        const accent = i % 7 === 3 ? "#ffa502" : i % 11 === 5 ? "#ff4857" : "#00e5e5";
        return `<div class="rd-wave-bar" style="height:${h}%;background:${accent};"></div>`;
      })
      .join("");
    return `<div class="rd-wave">${inner}</div>`;
  }

  function progRow({ label, value, color = "#00e5e5", suffix = "%" }) {
    const v = clamp(value, 0, 100, 0);
    return `
      <div class="rd-prog-row">
        <span class="rd-prog-label">${escapeHtml(label)}</span>
        <div class="rd-prog-track"><div class="rd-prog-fill" style="width:${v}%;background:${color};"></div></div>
        <span class="rd-prog-val">${Math.round(v)}${suffix}</span>
      </div>
    `;
  }

  function listBlock(items, fallback) {
    if (!items || !items.length) {
      return `<ul class="rd-list"><li class="rd-list-item">${escapeHtml(fallback)}</li></ul>`;
    }
    return `<ul class="rd-list">${items
      .map((item) => {
        if (typeof item === "string") return `<li class="rd-list-item">${escapeHtml(item)}</li>`;
        const tone = item.tone ? ` is-${item.tone}` : "";
        return `<li class="rd-list-item${tone}">${item.title ? `<strong>${escapeHtml(item.title)}</strong>` : ""}${escapeHtml(item.text || item.detail || "")}</li>`;
      })
      .join("")}</ul>`;
  }

  const NAV_ICONS = {
    script: "&#9998;",
    report: "&#9678;",
    ai: "&#9672;",
    video: "&#9673;",
  };

  function renderDashboard(container, model) {
    if (!container) return;
    const tabs = (model.tabs || []).filter((tab) => tab.visible !== false);
    const defaultTab = tabs.some((tab) => tab.id === model.defaultTab) ? model.defaultTab : tabs[0]?.id;

    const navHtml = tabs
      .map(
        (tab) => `
        <button type="button" class="rd-nav-item${tab.id === defaultTab ? " is-active" : ""}" data-rd-nav="${tab.id}">
          <span class="rd-nav-icon">${NAV_ICONS[tab.id] || "&#9679;"}</span>
          <span>${escapeHtml(tab.label)}</span>
        </button>
      `,
      )
      .join("");

    container.classList.add("report-dashboard");
    container.innerHTML = `
      <aside class="rd-sidebar">
        <div class="rd-logo">PITA</div>
        <div class="rd-divider"></div>
        <nav class="rd-nav">${navHtml}</nav>
        <div class="rd-sidebar-user">
          <div class="rd-avatar">${escapeHtml((model.userName || "P").slice(0, 1))}</div>
          <div>
            <div class="rd-user-name">${escapeHtml(model.userName || "")}</div>
            <div class="rd-user-sub">${escapeHtml(model.userSub || "")}</div>
          </div>
        </div>
      </aside>
      <div class="rd-main">
        <div class="rd-topbar">
          <span class="rd-topbar-title" data-rd-topbar-title>${escapeHtml(tabs.find((tab) => tab.id === defaultTab)?.label || "")}</span>
          <div class="rd-topbar-badge">
            <span class="rd-topbar-dot"></span>
            <span>${escapeHtml(model.sessionBadge || "")}</span>
          </div>
        </div>
        <nav class="rd-mobile-tabs">${navHtml}</nav>
        <div class="rd-content">
          ${tabs.map((tab) => renderView(tab, model, defaultTab)).join("")}
        </div>
        <div class="rd-action-bar">
          <button type="button" class="rd-btn" data-rd-action="share">${escapeHtml(model.actions?.shareLabel || "공유하기")}</button>
          <button type="button" class="rd-btn rd-btn-primary" data-rd-action="reset">${escapeHtml(model.actions?.resetLabel || "다시 연습하기")}</button>
        </div>
      </div>
    `;

    container.querySelectorAll("[data-rd-nav]").forEach((button) => {
      button.addEventListener("click", () => {
        const target = button.dataset.rdNav;
        container.querySelectorAll("[data-rd-nav]").forEach((item) => {
          item.classList.toggle("is-active", item.dataset.rdNav === target);
        });
        container.querySelectorAll("[data-rd-view]").forEach((view) => {
          view.classList.toggle("is-active", view.dataset.rdView === target);
        });
        const titleEl = container.querySelector("[data-rd-topbar-title]");
        if (titleEl) titleEl.textContent = tabs.find((tab) => tab.id === target)?.label || "";
        container.querySelector(".rd-content")?.scrollTo?.({ top: 0, behavior: "instant" });
      });
    });

    const shareBtn = container.querySelector('[data-rd-action="share"]');
    const resetBtn = container.querySelector('[data-rd-action="reset"]');
    if (shareBtn) shareBtn.addEventListener("click", () => model.actions?.onShare?.());
    if (resetBtn) resetBtn.addEventListener("click", () => model.actions?.onReset?.());

    if (model.video?.objectUrl) {
      const videoEl = container.querySelector("[data-rd-video-el]");
      if (videoEl) videoEl.src = model.video.objectUrl;
    }
  }

  function renderView(tab, model, defaultTab) {
    const active = tab.id === defaultTab ? " is-active" : "";
    let body = "";
    if (tab.id === "report") body = renderReportView(model.report || {}, model);
    else if (tab.id === "ai") body = renderAiView(model.ai || {});
    else if (tab.id === "video") body = renderVideoView(model.video || {});
    else if (tab.id === "script") body = renderScriptView(model.script || {});
    return `<section class="rd-view${active}" data-rd-view="${tab.id}">${body}</section>`;
  }

  function renderReportView(report, model) {
    const coaching = report.coaching || {};
    const emojis = coaching.emojis?.length ? coaching.emojis : ["🙂"];
    const voice = report.voice || {};
    const content = report.content || {};
    const radar = report.radar || {};
    const summary = report.scoreSummary || {};

    return `
      <h1 class="rd-page-title">${escapeHtml(model.title || "분석 결과")}</h1>
      <p class="rd-page-sub">${escapeHtml(model.meta || "")}</p>
      <div class="rd-row">
        <div class="rd-col">
          <div class="rd-card">
            <div class="rd-card-title">${escapeHtml(coaching.cardTitle || "💡 AI 코칭")}</div>
            <div class="rd-emoji-row">
              ${emojis.map((emoji, index) => `<div class="rd-emoji${index === (coaching.activeIndex ?? 0) ? " is-active" : ""}">${emoji}</div>`).join("")}
            </div>
            <h3 class="rd-coach-title">${escapeHtml(coaching.title || "분석 결과를 확인해보세요")}</h3>
            <p class="rd-coach-body">${escapeHtml(coaching.body || "")}</p>
          </div>
          <div class="rd-card">
            <div class="rd-card-title">${escapeHtml(voice.cardTitle || "🎙️ 음성 분석")}</div>
            ${waveBlock(voice.seed ?? voice.wpm ?? 50)}
            <div class="rd-stat-row">
              ${(
                voice.stats || [
                  { value: voice.wpm != null ? `${voice.wpm} WPM` : "-", label: "말하기 속도" },
                  { value: voice.silenceRatioPct != null ? `${voice.silenceRatioPct}%` : "-", label: "침묵 비율" },
                  { value: voice.durationLabel || "-", label: "총 시간" },
                ]
              )
                .map((stat) => `<div class="rd-stat"><b>${escapeHtml(stat.value)}</b><span>${escapeHtml(stat.label)}</span></div>`)
                .join("")}
            </div>
            ${(voice.bars || [])
              .map((bar) => progRow({ label: bar.label, value: bar.value, color: bar.color }))
              .join("")}
          </div>
        </div>

        <div class="rd-card">
          <div class="rd-card-title">${escapeHtml(content.cardTitle || "📝 내용 분석")}</div>
          ${donutBlock({ value: content.donutPct, label: "종합 점수" })}
          ${(content.subScores || [])
            .map(
              (sub) => `
                <div class="rd-sub-score-row">
                  <span class="rd-sub-score-name">${escapeHtml(sub.label)}</span>
                  <span class="rd-sub-score-val" style="color:${sub.color}">${Math.round(clamp(sub.score))}점</span>
                </div>
                <div class="rd-sub-score-track"><div class="rd-sub-score-fill" style="width:${clamp(sub.score)}%;background:${sub.color};"></div></div>
              `,
            )
            .join("")}
          ${content.note ? `<div class="rd-analysis-box">"${escapeHtml(content.note)}"</div>` : ""}
        </div>

        <div class="rd-card">
          <div class="rd-card-title">${escapeHtml(radar.cardTitle || "📊 역량 레이더")}</div>
          <div class="rd-radar-wrap">${radarSvg({ labels: radar.labels || [], mine: radar.mine || [], avg: radar.avg || [], size: 220 })}</div>
          <div class="rd-radar-legend">
            <span><span class="rd-radar-legend-dot" style="background:#00e5e5;"></span>나의 점수</span>
            <span><span class="rd-radar-legend-dot" style="background:#8a8a8a;"></span>평균 점수</span>
          </div>
          <div class="rd-radar-badges">
            ${(radar.badges || [])
              .map(
                (badge) => `
                  <div class="rd-radar-badge">
                    <b style="color:${badge.color}">${Math.round(clamp(badge.value))}점</b>
                    <span>${escapeHtml(badge.label)}</span>
                  </div>
                `,
              )
              .join("")}
          </div>
          ${radar.note ? `<p class="rd-radar-note">${escapeHtml(radar.note)}</p>` : ""}
        </div>

        <div class="rd-card">
          <div class="rd-card-title">세션 점수</div>
          <div class="rd-score-big">${Math.round(clamp(summary.big))}</div>
          <div class="rd-score-big-sub">/ 100</div>
          ${(summary.items || [])
            .map(
              (item) => `
                <div class="rd-mini-row">
                  ${miniRing({ value: item.value, color: item.color })}
                  <div class="rd-mini-info">
                    <div class="rd-user-name" style="font-size:16px;">${Math.round(clamp(item.value))}</div>
                    <div class="rd-mini-label">${escapeHtml(item.label)}</div>
                    ${item.deltaLabel ? `<div class="rd-mini-delta${item.deltaUp === false ? " is-down" : ""}">${escapeHtml(item.deltaLabel)}</div>` : ""}
                  </div>
                </div>
              `,
            )
            .join("")}
        </div>
      </div>
    `;
  }

  function renderAiView(ai) {
    const metrics = ai.metrics || [];
    const insights = ai.insights || [];
    return `
      <h1 class="rd-page-title">AI 분석 상세</h1>
      <p class="rd-page-sub">${escapeHtml(ai.subtitle || "핵심 지표 기반 심층 분석")}</p>
      <div class="rd-metrics-grid">
        ${metrics
          .map(
            (metric) => `
              <div class="rd-metric-tile">
                ${donutBlock({ value: metric.value, size: 64, stroke: 5, color: metric.color, valueSize: 13 })}
                <div class="rd-metric-name">${escapeHtml(metric.label)}</div>
              </div>
            `,
          )
          .join("")}
      </div>
      <div class="rd-grid-2">
        <div class="rd-card">
          <div class="rd-card-title">📡 역량 레이더</div>
          <div class="rd-radar-wrap">${radarSvg({ labels: ai.radar?.labels || [], mine: ai.radar?.mine || [], avg: ai.radar?.avg || [], size: 220 })}</div>
        </div>
        <div>
          <div class="rd-card-title" style="margin-bottom:12px;">💡 AI 핵심 인사이트</div>
          <div class="rd-list" style="gap:10px;">
            ${insights
              .map(
                (insight, index) => `
                  <div class="rd-insight-item">
                    <div class="rd-insight-num">${index + 1}</div>
                    <div>
                      <h4 class="rd-insight-title">${escapeHtml(insight.title)}</h4>
                      <p class="rd-insight-body">${escapeHtml(insight.body)}</p>
                    </div>
                  </div>
                `,
              )
              .join("") || `<div class="rd-empty-note">아직 표시할 인사이트가 없습니다.</div>`}
          </div>
        </div>
      </div>
      ${ai.historyNote ? `<div class="rd-card" style="margin-top:16px;"><div class="rd-card-title">🕓 이전 세션 비교</div><p class="rd-radar-note">${escapeHtml(ai.historyNote)}</p></div>` : ""}
    `;
  }

  function renderVideoView(video) {
    const hasVideo = Boolean(video.objectUrl);
    return `
      <h1 class="rd-page-title">영상 분석</h1>
      <p class="rd-page-sub">${escapeHtml(video.subtitle || "카메라 영상 기반 비언어 분석")}</p>
      <div class="rd-video-layout">
        <div>
          <div class="rd-video-player">
            <div class="rd-video-screen">
              ${
                hasVideo
                  ? `<video data-rd-video-el controls playsinline src="${escapeHtml(video.objectUrl)}"></video>`
                  : `<div class="rd-video-empty"><span class="rd-video-empty-icon">🎬</span><span>${escapeHtml(video.emptyNote || "분석할 영상 샘플이 없습니다.")}</span></div>`
              }
            </div>
            <div class="rd-video-scores">
              ${(video.scores || [])
                .map(
                  (score) => `
                    <div class="rd-video-score">
                      ${donutBlock({ value: score.value, size: 72, stroke: 6, color: score.color, valueSize: 14 })}
                      <div class="rd-video-score-label">${escapeHtml(score.label)}</div>
                    </div>
                  `,
                )
                .join("")}
            </div>
          </div>
        </div>
        <div class="rd-video-feedback">
          <div class="rd-video-feedback-header">👤 비언어 피드백</div>
          <div class="rd-video-feedback-scroll">
            ${
              (video.feedback || [])
                .map(
                  (item) => `
                    <div class="rd-list-item${item.tone ? ` is-${item.tone}` : ""}">
                      ${item.tag ? `<strong>${escapeHtml(item.tag)}</strong>` : ""}
                      ${escapeHtml(item.text)}
                    </div>
                  `,
                )
                .join("") || `<div class="rd-empty-note">${escapeHtml(video.emptyFeedbackNote || "표시할 피드백이 없습니다.")}</div>`
            }
          </div>
        </div>
      </div>
    `;
  }

  function renderScriptView(script) {
    const tiles = script.scoreTiles || [];
    return `
      <h1 class="rd-page-title">발표 대본 분석</h1>
      <p class="rd-page-sub">${escapeHtml(script.subtitle || "대본 구조와 논리, 근거를 점검합니다")}</p>
      <div class="rd-tile-row">
        ${tiles
          .map(
            (tile) => `
              <div class="rd-tile">
                <div class="rd-tile-label">${escapeHtml(tile.label)}</div>
                <div class="rd-tile-value" style="color:${tile.color || "#f5f5f5"}">${escapeHtml(String(tile.value))}</div>
                <div class="rd-tile-sub">${escapeHtml(tile.sub || "")}</div>
              </div>
            `,
          )
          .join("")}
      </div>
      <div class="rd-card" style="margin-top:16px;">
        <div class="rd-card-title">💬 총평</div>
        <p class="rd-coach-body" style="font-size:13px;color:#f5f5f5;line-height:1.75;">${escapeHtml(script.summary || "")}</p>
      </div>
      <div class="rd-grid-2">
        <div class="rd-card">
          <div class="rd-card-title">💪 강점</div>
          ${listBlock(script.strengths, "강점 항목이 아직 없습니다.")}
        </div>
        <div class="rd-card">
          <div class="rd-card-title">🎯 개선 우선순위</div>
          ${listBlock(
            (script.improvements || []).map((item) => ({
              title: item.title,
              text: item.detail,
              tone: item.tone || "warn",
            })),
            "개선 우선순위가 아직 없습니다.",
          )}
        </div>
      </div>
      <div class="rd-card" style="margin-top:16px;">
        <div class="rd-card-title">❓ 예상 질문</div>
        ${
          (script.qa || [])
            .map(
              (item, index) => `
                <div class="rd-qa-item">
                  <div class="rd-qa-q"><span class="rd-qa-mark">Q${index + 1}</span>${escapeHtml(item.question)}</div>
                  ${item.intent ? `<div class="rd-qa-row"><span class="rd-qa-label">의도</span><span class="rd-qa-text">${escapeHtml(item.intent)}</span></div>` : ""}
                  ${item.points ? `<div class="rd-qa-row"><span class="rd-qa-label" style="background:rgba(0,201,167,.14);color:#00c9a7;">답변 포인트</span><span class="rd-qa-text">${escapeHtml(item.points)}</span></div>` : ""}
                </div>
              `,
            )
            .join("") || `<div class="rd-empty-note">예상 질문이 아직 없습니다.</div>`
        }
      </div>
    `;
  }

  global.PitaReportUI = Object.freeze({
    renderDashboard,
    escapeHtml,
    clamp,
    waveBars,
  });
})(window);
