(() => {
  const CHANNEL = "video-batch-assistant-v1";
  const BUILD_MANIFEST = chrome.runtime.getManifest();
  const BUILD_NAME = BUILD_MANIFEST.name;
  const BUILD_VERSION = BUILD_MANIFEST.version;
  const IS_EDGE_BUILD = BUILD_NAME.includes("Edge");
  const PANEL_POSITION_KEY = "video-batch-assistant-panel-position";
  const SETTINGS_KEY = "video-batch-assistant-settings-v1";
  const DEFAULT_SETTINGS = Object.freeze({
    description: "👆点上方链接，免费看全集",
    shortTitle: "免费短剧看全集",
    linkType: "小程序短剧",
    videoMark: "含AI生成内容",
    declareOriginal: false,
    manualCoverEnabled: false
  });
  const EXTRA_WAIT_MS = IS_EDGE_BUILD ? 10000 : 0;
  const TIMEOUTS = {
    normal: 30000 + EXTRA_WAIT_MS,
    upload: 90000 + EXTRA_WAIT_MS,
    returnToList: 90000 + EXTRA_WAIT_MS
  };
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const dramaNameFromFolder = (value) => normalize(value).replace(/^剪辑\s*[-－—]\s*/, "").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };

  function uniqueFromSelectors(doc, selectors, { text = null, visible = true } = {}) {
    for (const selector of selectors) {
      const matches = [...doc.querySelectorAll(selector)].filter((element) => {
        if (visible && !isVisible(element)) return false;
        return text === null || normalize(element.textContent) === text;
      });
      if (matches.length === 1) return matches[0];
    }
    return null;
  }

  async function waitFor(getValue, label, timeout, isCancelled = () => false) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (isCancelled()) throw new Error("已取消");
      const value = getValue();
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`等待超时：${label}`);
  }

  function setInputValue(input, value) {
    const view = input.ownerDocument.defaultView;
    const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    input.dispatchEvent(new view.Event("change", { bubbles: true }));
    input.blur();
  }

  async function waitForStableText(element, expected, timeout, isCancelled) {
    const started = Date.now();
    let matchedSince = 0;
    const normalizedExpected = normalize(expected);
    while (Date.now() - started < timeout) {
      if (isCancelled()) throw new Error("已取消");
      if (normalize(element.textContent) === normalizedExpected) {
        if (!matchedSince) matchedSince = Date.now();
        if (Date.now() - matchedSince >= 1500) return true;
      } else {
        matchedSince = 0;
      }
      await sleep(250);
    }
    throw new Error(`等待超时：确认视频描述稳定写入；当前值=${JSON.stringify(normalize(element.textContent))}`);
  }

  function setVideoFile(input, file) {
    const view = input.ownerDocument.defaultView;
    const transfer = new view.DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    input.dispatchEvent(new view.Event("change", { bubbles: true }));
  }

  function queryAllDeep(root, selector) {
    const matches = [...root.querySelectorAll(selector)];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) matches.push(...queryAllDeep(element.shadowRoot, selector));
    }
    return matches;
  }

  function findVideoInput(doc) {
    const inputs = queryAllDeep(doc, 'input[type="file"]')
      .filter((input) => !input.closest?.("#video-batch-assistant-panel"));
    const videoInputs = inputs.filter((input) => /video/i.test(input.getAttribute("accept") || ""));
    if (videoInputs.length === 1) return videoInputs[0];
    if (inputs.length === 1) return inputs[0];
    return null;
  }

  function findUploadDropZone(doc) {
    const candidates = queryAllDeep(doc, "div, label, section").filter((element) => {
      const text = normalize(element.textContent);
      if (!isVisible(element)) return false;
      return text.includes("上传时长") && (text.includes("20GB") || text.includes("MP4/H.264"));
    });
    candidates.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.width * aRect.height - bRect.width * bRect.height;
    });
    return candidates[0] || null;
  }

  function dropVideoFile(target, file) {
    const view = target.ownerDocument.defaultView;
    const transfer = new view.DataTransfer();
    transfer.items.add(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(new view.DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: transfer
      }));
    }
  }

  function uploadDiagnostics(doc) {
    const inputs = queryAllDeep(doc, "input").map((input) => ({
      type: input.type || "", accept: input.getAttribute("accept") || ""
    }));
    return `inputs=${JSON.stringify(inputs).slice(0, 600)}; bodyHasUploadText=${normalize(doc.body?.textContent).includes("上传时长")}`;
  }

  function collectAccessibleDocuments(rootWindow = window) {
    const results = [];
    const seen = new Set();
    const visit = (currentWindow) => {
      try {
        const currentDocument = currentWindow.document;
        if (!currentDocument || seen.has(currentDocument)) return;
        seen.add(currentDocument);
        results.push({ doc: currentDocument, url: currentWindow.location.href });
        for (const frame of currentDocument.querySelectorAll("iframe, frame")) {
          if (frame.contentWindow) visit(frame.contentWindow);
        }
      } catch {
        // Cross-origin documents are intentionally skipped.
      }
    };
    visit(rootWindow);
    return results;
  }

  function hasCreateFormEvidence(doc) {
    if (findDescription(doc) || findShortTitle(doc) || findUploadDropZone(doc)) return true;
    const text = normalize(doc.body?.innerText || doc.body?.textContent);
    return text.includes("视频描述") && text.includes("短标题") && text.includes("视频标注");
  }

  function createDocumentDiagnostics() {
    return collectAccessibleDocuments().map(({ doc, url }) => ({
      url,
      inputs: queryAllDeep(doc, "input").length,
      fileInputs: queryAllDeep(doc, 'input[type="file"]').filter((input) =>
        !input.closest?.("#video-batch-assistant-panel")
      ).length,
      description: Boolean(findDescription(doc)),
      shortTitle: Boolean(findShortTitle(doc)),
      uploadText: normalize(doc.body?.innerText || doc.body?.textContent).includes("上传时长"),
      bodyChildren: doc.body?.children.length ?? -1
    }));
  }

  async function submitVideoToUploader(doc, file, report, isCancelled) {
    const existingVideoCount = doc.querySelectorAll("video").length;
    const input = findVideoInput(doc);
    if (input) {
      report(`已定位网站文件控件，正在上传：${file.name}`);
      setVideoFile(input, file);
    } else {
      const dropZone = findUploadDropZone(doc);
      if (!dropZone) throw new Error(`找不到网站视频上传控件；${uploadDiagnostics(doc)}`);
      report(`已定位网站拖放区域，正在拖入：${file.name}`);
      dropVideoFile(dropZone, file);
    }
    await waitFor(() => {
      const selectedInput = findVideoInput(doc);
      if (selectedInput?.files?.length) return true;
      if (doc.querySelectorAll("video").length > existingVideoCount) return true;
      return !findUploadDropZone(doc);
    }, `网站接收视频文件；${uploadDiagnostics(doc)}`, TIMEOUTS.normal, isCancelled);
  }

  function findDescription(doc) {
    const selectors = [
      'div.input-editor[contenteditable][data-placeholder="添加描述"]',
      '[contenteditable][data-placeholder*="描述"]',
      '.post-desc-box [contenteditable]'
    ];
    for (const selector of selectors) {
      const candidates = queryAllDeep(doc, selector).filter((element) => {
        if (!doc.contains(element) && !element.getRootNode()?.host) return false;
        const box = element.closest?.(".post-desc-box") || element;
        return isVisible(box);
      });
      if (candidates.length === 1) return candidates[0];
    }
    return null;
  }

  function findShortTitle(doc) {
    const selectors = [
      'input[type="text"][placeholder="填写短标题有机会获得更多流量"]',
      'input[type="text"][placeholder*="短标题"]'
    ];
    for (const selector of selectors) {
      const candidates = queryAllDeep(doc, selector).filter(isVisible);
      if (candidates.length === 1) return candidates[0];
    }
    return null;
  }

  function fieldDiagnostics(doc) {
    const editables = queryAllDeep(doc, "[contenteditable]").map((element) => ({
      tag: element.tagName,
      className: String(element.className || ""),
      dataPlaceholder: element.getAttribute("data-placeholder"),
      visible: isVisible(element.closest?.(".post-desc-box") || element),
      attached: doc.contains(element)
    }));
    const textInputs = queryAllDeep(doc, 'input[type="text"]').map((element) => ({
      placeholder: element.getAttribute("placeholder"), visible: isVisible(element)
    }));
    return `editables=${JSON.stringify(editables).slice(0, 900)}; textInputs=${JSON.stringify(textInputs).slice(0, 700)}`;
  }

  function exactTextDiagnostics(doc, texts) {
    const wanted = new Set(texts);
    const matches = queryAllDeep(doc, "div, span, button").filter((element) =>
      wanted.has(normalize(element.textContent))
    ).map((element) => ({
      tag: element.tagName,
      className: String(element.className || ""),
      text: normalize(element.textContent),
      visible: isVisible(element),
      parentClass: String(element.parentElement?.className || "")
    }));
    return JSON.stringify(matches).slice(0, 1400);
  }

  function findExactClickTarget(doc, text, preferredSelectors = []) {
    for (const selector of preferredSelectors) {
      const matches = queryAllDeep(doc, selector).filter((element) =>
        isVisible(element) && normalize(element.textContent) === text
      );
      if (matches.length === 1) return matches[0];
    }
    const matches = queryAllDeep(doc, "button, div, span, td, tr").filter((element) =>
      isVisible(element) && normalize(element.textContent) === text
    );
    matches.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.width * aRect.height - bRect.width * bRect.height;
    });
    return matches[0] || null;
  }

  function findVisibleInput(doc, selectors) {
    for (const selector of selectors) {
      const matches = queryAllDeep(doc, selector).filter((element) =>
        isVisible(element) && !element.disabled
      );
      if (matches.length === 1) return matches[0];
    }
    return null;
  }

  function getSelectedDramaTitle(doc) {
    const candidates = queryAllDeep(doc, ".choose-content, .link-input-wrap .content-wrap")
      .filter(isVisible)
      .map((element) => normalize(element.textContent))
      .filter((text) => text && ![
        "选择需要添加的短剧", "选择需要添加的视频号剧集", "选择链接"
      ].includes(text));
    return candidates[0] || "";
  }

  function findUniqueSeriesRow(doc, searchKeyword) {
    const escapedName = searchKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const titlePattern = new RegExp(`^${escapedName}(?:\\d+集)?$`);
    const rows = queryAllDeep(doc, "tr.drama-row, tr.ant-table-row, .weui-desktop-dialog tr")
      .filter(isVisible)
      .filter((row) => {
        const titleCandidates = queryAllDeep(row, ".drama-info-cell, .series-info-cell, [class*='title']")
          .map((element) => normalize(element.textContent))
          .filter(Boolean);
        if (titleCandidates.some((title) => titlePattern.test(title))) return true;
        const firstCellText = normalize(row.querySelector("td")?.textContent);
        return titlePattern.test(firstCellText);
      });
    return rows.length === 1 ? rows[0] : null;
  }

  function isChecked(element) {
    if (!element) return false;
    if (element.matches?.('input[type="checkbox"]')) return element.checked;
    return element.getAttribute?.("aria-checked") === "true" ||
      String(element.className || "").includes("checked");
  }

  function findCheckboxNearText(root, text) {
    const textNodes = queryAllDeep(root, "label, div, span, p").filter((element) =>
      isVisible(element) && normalize(element.textContent).includes(text)
    );
    textNodes.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height -
      b.getBoundingClientRect().width * b.getBoundingClientRect().height);
    for (const textNode of textNodes) {
      let scope = textNode;
      for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
        const native = scope.querySelector?.('input[type="checkbox"]');
        if (native) {
          const label = textNode.closest?.("label") || native.closest?.("label");
          return { control: native, clickTarget: label || native };
        }
        const custom = [...(scope.querySelectorAll?.('[role="checkbox"], .weui-desktop-form__checkbox, [class*="checkbox"]') || [])]
          .find(isVisible);
        if (custom) return { control: custom, clickTarget: custom };
      }
    }
    return null;
  }

  async function applyOriginalDeclaration(doc, report, isCancelled, requestManualOriginal) {
    const pageAgreementText = "声明后，作品将展示原创标记";
    const modalAgreementText = "我已阅读并同意";
    try {
      report("正在声明原创…");
      const pageCheckbox = await waitFor(
        () => findCheckboxNearText(doc, pageAgreementText),
        `原创声明入口；候选=${exactTextDiagnostics(doc, ["声明原创"])}`,
        TIMEOUTS.normal,
        isCancelled
      );
      if (isChecked(pageCheckbox.control)) return;
      if (!isChecked(pageCheckbox.control)) pageCheckbox.clickTarget.click();

      await waitFor(() => findExactClickTarget(doc, "原创权益", [
        ".weui-desktop-dialog__title", ".weui-desktop-dialog__hd"
      ]), "原创权益弹窗", TIMEOUTS.normal, isCancelled);
      const agreement = await waitFor(
        () => findCheckboxNearText(doc, modalAgreementText),
        "原创权益协议勾选框",
        TIMEOUTS.normal,
        isCancelled
      );
      if (!isChecked(agreement.control)) agreement.clickTarget.click();

      const confirmButton = await waitFor(() => {
        const buttons = queryAllDeep(doc, "button").filter((button) =>
          isVisible(button) && normalize(button.textContent) === "声明原创" &&
          !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
          !String(button.className).includes("disabled")
        );
        return buttons.length === 1 ? buttons[0] : null;
      }, "可点击的“声明原创”按钮", TIMEOUTS.normal, isCancelled);
      confirmButton.click();
      await waitFor(() => !findExactClickTarget(doc, "原创权益", [
        ".weui-desktop-dialog__title", ".weui-desktop-dialog__hd"
      ]), "原创权益弹窗关闭", TIMEOUTS.normal, isCancelled);
    } catch (error) {
      if (isCancelled() || !requestManualOriginal) throw error;
      await requestManualOriginal(doc, error.message);
    }
  }

  function findPublishButton(doc) {
    return queryAllDeep(doc, "button").find((button) =>
      isVisible(button) && normalize(button.textContent) === "发表" && !button.disabled &&
      button.getAttribute("aria-disabled") !== "true" &&
      !String(button.className).includes("weui-desktop-btn_disabled")
    );
  }

  function visibleWebsiteStatusTexts(doc, pattern) {
    return queryAllDeep(doc, "div, span, p").filter((element) => {
      if (element.closest?.("#video-batch-assistant-panel")) return false;
      if (!isVisible(element)) return false;
      const text = normalize(element.textContent);
      return text.length > 0 && text.length <= 80 && pattern.test(text);
    }).map((element) => normalize(element.textContent));
  }

  function publishReadinessDiagnostics(doc) {
    const buttons = queryAllDeep(doc, "button").filter((button) =>
      normalize(button.textContent) === "发表"
    ).map((button) => ({
      visible: isVisible(button),
      disabled: button.disabled,
      ariaDisabled: button.getAttribute("aria-disabled"),
      className: String(button.className || "")
    }));
    const videos = queryAllDeep(doc, "video").map((video) => ({
      readyState: video.readyState,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth,
      height: video.videoHeight
    }));
    const blocking = visibleWebsiteStatusTexts(doc, /(正在上传|上传中|等待上传|正在处理|处理中|正在转码|转码中)/);
    const errors = visibleWebsiteStatusTexts(doc, /(上传失败|处理失败|转码失败)/);
    return JSON.stringify({ buttons, videos, blocking, errors }).slice(0, 1800);
  }

  async function waitForUploadCompletionAndPublishButton(doc, label, timeout, isCancelled) {
    const started = Date.now();
    let readySince = 0;
    while (Date.now() - started < timeout) {
      if (isCancelled()) throw new Error("已取消");
      const errors = visibleWebsiteStatusTexts(doc, /(上传失败|处理失败|转码失败)/);
      if (errors.length) throw new Error(`网站报告视频处理失败：${errors.join(" | ")}`);
      const blocking = visibleWebsiteStatusTexts(doc, /(正在上传|上传中|等待上传|正在处理|处理中|正在转码|转码中)/);
      const button = findPublishButton(doc);
      if (button && blocking.length === 0) {
        if (!readySince) readySince = Date.now();
        if (Date.now() - readySince >= 1500) return button;
      } else {
        readySince = 0;
      }
      await sleep(250);
    }
    throw new Error(`等待超时：${label}；就绪诊断=${publishReadinessDiagnostics(doc)}`);
  }

  async function runCreateFrameJob(
    payload,
    report,
    isCancelled,
    requestManualDramaSelection = null,
    requestManualCoverEdit = null,
    requestManualOriginal = null,
    requestManualReview = null
  ) {
    const doc = document;
    report(`正在定位网站上传控件：${payload.file.name}`);
    await waitFor(() => doc.readyState === "complete" && doc.body, "发布表单页面加载", TIMEOUTS.normal, isCancelled);
    await submitVideoToUploader(doc, payload.file, report, isCancelled);

    if (payload.description) {
      report("正在填写视频描述…");
      const description = await waitFor(
        () => findDescription(doc),
        `视频描述；${fieldDiagnostics(doc)}`,
        TIMEOUTS.normal,
        isCancelled
      );
      const descriptionResult = await chrome.runtime.sendMessage({
        type: "fill-description-main",
        value: payload.description
      });
      if (!descriptionResult?.ok) {
        throw new Error(`无法写入网站表单状态中的视频描述：${descriptionResult?.error || "未知错误"}`);
      }
      await waitForStableText(description, payload.description, TIMEOUTS.normal, isCancelled);
    }
    if (payload.shortTitle) {
      report("正在填写短标题…");
      const shortTitle = await waitFor(
        () => findShortTitle(doc),
        `短标题；${fieldDiagnostics(doc)}`,
        TIMEOUTS.normal,
        isCancelled
      );
      setInputValue(shortTitle, payload.shortTitle);
      await waitFor(() => shortTitle.value === payload.shortTitle, "确认短标题写入", TIMEOUTS.normal, isCancelled);
    }

    if (payload.linkType !== "不关联链接") {
      report(`正在选择${payload.linkType}…`);
      const linkDisplay = await waitFor(() => findExactClickTarget(doc, "选择链接", [
        "div.link-display-wrap",
        "div.post-link-wrap div.link-display-wrap",
        "div.select-display"
      ]), `链接下拉框；候选=${exactTextDiagnostics(doc, ["选择链接"])}`, TIMEOUTS.normal, isCancelled);
      linkDisplay.click();
      const linkOption = await waitFor(() => findExactClickTarget(doc, payload.linkType, [
        "div.link-option-item", "div.link-list-options > div"
      ]), `${payload.linkType}选项；候选=${exactTextDiagnostics(doc, [payload.linkType])}`, TIMEOUTS.normal, isCancelled);
      linkOption.click();
      const triggerText = payload.linkType === "视频号剧集"
        ? "选择需要添加的视频号剧集"
        : "选择需要添加的短剧";
      const trigger = await waitFor(() => findExactClickTarget(doc, triggerText, [
        "div.post-component-choose-wrap", "div.link-input-wrap div.content-wrap"
      ]), `${payload.linkType}选择入口；候选=${exactTextDiagnostics(doc, [triggerText])}`, TIMEOUTS.normal, isCancelled);
      trigger.click();
      const search = await waitFor(() => findVisibleInput(doc, [
        'input[placeholder="请输入短剧名称"]',
        'input[placeholder*="短剧名称"]',
        'input[placeholder="搜索内容"]',
        '.weui-desktop-dialog input.weui-desktop-form__input',
        '.weui-desktop-dialog input[type="text"]'
      ]), `${payload.linkType}搜索框`, TIMEOUTS.normal, isCancelled);
      setInputValue(search, payload.searchKeyword);

      const row = await waitFor(
        () => findUniqueSeriesRow(doc, payload.searchKeyword),
        `唯一${payload.linkType}搜索结果`,
        TIMEOUTS.normal,
        isCancelled
      ).catch(async (error) => {
        if (isCancelled() || !requestManualDramaSelection) throw error;
        await requestManualDramaSelection(doc, payload.searchKeyword, payload.linkType);
        return null;
      });
      if (row) {
        row.click();
        await waitFor(() => Boolean(getSelectedDramaTitle(doc)),
          `确认${payload.linkType}选择；目标=${payload.searchKeyword}`,
          TIMEOUTS.normal,
          isCancelled);
      }
    }

    if (payload.videoMark !== "不设置") {
      report(`正在设置视频标注：${payload.videoMark}…`);
      const markSelect = await waitFor(() => {
        const direct = queryAllDeep(doc, "div.mark-tag-select").filter(isVisible);
        if (direct.length === 1) return direct[0];
        return findExactClickTarget(doc, "选择视频标注", [
          "div.form-item.post-with-mark-tag div.select-display",
          "div.post-with-mark-tag div.select-display"
        ]);
      }, `视频标注下拉框；候选=${exactTextDiagnostics(doc, ["选择视频标注"])}`, TIMEOUTS.normal, isCancelled);
      markSelect.click();
      const markOption = await waitFor(() => findExactClickTarget(doc, payload.videoMark, [
        "div.mark-tag-option", "div.mark-tag-options > div"
      ]), `${payload.videoMark}选项；候选=${exactTextDiagnostics(doc, [payload.videoMark])}`, TIMEOUTS.normal, isCancelled);
      markOption.click();
      await waitFor(() => queryAllDeep(doc, "div.mark-tag-select, div.post-with-mark-tag")
        .filter(isVisible)
        .some((element) => normalize(element.textContent).includes(payload.videoMark)),
      `确认视频标注；目标=${payload.videoMark}`, TIMEOUTS.normal, isCancelled);
    }

    if (payload.declareOriginal) {
      await applyOriginalDeclaration(doc, report, isCancelled, requestManualOriginal);
    }

    report("视频正在上传和处理，请等待…");
    let publish = await waitForUploadCompletionAndPublishButton(
      doc, "视频上传和处理完成", TIMEOUTS.upload, isCancelled
    );
    let reviewedManually = false;
    if (requestManualReview && await requestManualReview(doc)) {
      reviewedManually = true;
      report("人工检查已确认，准备直接发表…");
      publish = findPublishButton(doc);
      if (!publish) throw new Error("人工检查后当前没有可点击的“发表”按钮");
    }
    if (!reviewedManually && requestManualCoverEdit) {
      await requestManualCoverEdit(doc);
      report("封面编辑已确认，正在重新检查发表状态…");
      publish = await waitForUploadCompletionAndPublishButton(
        doc, "封面编辑后的发表按钮", TIMEOUTS.normal, isCancelled
      );
    }
    report("正在发表…");
    publish.click();
  }

  if (window.top !== window) {
    if (window.__videoBatchAssistantFrameLoaded) return;
    window.__videoBatchAssistantFrameLoaded = true;
    let cancelled = false;
    window.addEventListener("message", async (event) => {
      const message = event.data;
      if (!message || message.channel !== CHANNEL) return;
      if (message.type === "STOP_FRAME_JOB") {
        cancelled = true;
        return;
      }
      if (message.type !== "RUN_FRAME_JOB" || !(message.payload?.file instanceof File)) return;
      if (location.pathname !== "/micro/content/post/create") return;
      cancelled = false;
      const respond = (type, extra = {}) => window.parent.postMessage({
        channel: CHANNEL, type, requestId: message.requestId, frameUrl: location.href, ...extra
      }, "*");
      try {
        await runCreateFrameJob(message.payload, (nextStatus) => respond("FRAME_STATUS", { status: nextStatus }), () => cancelled);
        respond("FRAME_RESULT", { ok: true });
      } catch (error) {
        respond("FRAME_RESULT", { ok: false, error: error.message });
      }
    });
    return;
  }

  if (window.__videoBatchAssistantLoaded) return;
  window.__videoBatchAssistantLoaded = true;
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (!saved || typeof saved !== "object") return { ...DEFAULT_SETTINGS };
      return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [
        key, Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : DEFAULT_SETTINGS[key]
      ]));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch {
      // Settings persistence is optional; the active run still uses the form values.
    }
  }

  const state = {
    files: [], sourceFolderName: "", folderName: "", running: false, cancelled: false,
    currentIndex: -1, completedCount: 0, manualSelection: null,
    searchKeyword: "", manualReviewRequested: false, settings: loadSettings()
  };
  let panel;
  let removePanelDragHandlers = null;
  let status = "请选择一个剧集文件夹";

  function updatePanel(message) {
    if (message) status = message;
    if (!panel) return;
    panel.querySelector("[data-status]").textContent = status;
    panel.querySelector("[data-count]").textContent = `${state.files.length} 个视频`;
    panel.querySelector("[data-folder-name]").textContent = state.searchKeyword || "尚未选择文件夹";
    panel.querySelector("[data-source-folder]").textContent = state.sourceFolderName || "—";
    panel.querySelector("[data-current]").textContent = state.currentIndex >= 0
      ? `${state.currentIndex + 1} / ${state.files.length}`
      : `${state.completedCount} / ${state.files.length || 0}`;
    panel.querySelector("[data-current-file]").textContent = state.currentIndex >= 0
      ? state.files[state.currentIndex]?.name || "—"
      : "—";
    const progress = state.files.length ? Math.round((state.completedCount / state.files.length) * 100) : 0;
    panel.querySelector("[data-progress-bar]").style.width = `${progress}%`;
    panel.querySelector("[data-progress-text]").textContent = `${progress}%`;
    panel.querySelector("[data-status-card]").dataset.kind = state.manualSelection
      ? "manual"
      : status.startsWith("已暂停") ? "error"
      : status === "全部完成" ? "success"
      : state.running ? "running" : "idle";
    panel.querySelector("[data-start]").disabled = state.running || !state.files.length;
    panel.querySelector("[data-continue]").disabled = !state.manualSelection;
    panel.querySelector("[data-cancel]").disabled = !state.running;
    panel.querySelector("[data-folder]").disabled = state.running;
    for (const control of panel.querySelectorAll("[data-setting]")) control.disabled = state.running;
    const reviewButton = panel.querySelector("[data-review-next]");
    reviewButton.disabled = !state.running || state.manualReviewRequested ||
      ["cover", "review"].includes(state.manualSelection?.type);
    reviewButton.textContent = state.manualReviewRequested
      ? "已预约：下次发表前暂停"
      : "下次发表前暂停并人工检查";
  }

  function requestManualDramaSelection(doc, searchKeyword, linkType) {
    return new Promise((resolve) => {
      state.manualSelection = { type: "drama", doc, searchKeyword, linkType, resolve };
      status = `未自动唯一匹配${linkType}“${searchKeyword}”。请在网站弹窗中人工搜索并选择，然后点击“继续”。`;
      updatePanel();
    }).then((selectedTitle) => {
      if (!selectedTitle || state.cancelled) throw new Error("已取消");
      return selectedTitle;
    });
  }

  function requestManualCoverEdit(doc) {
    return new Promise((resolve) => {
      state.manualSelection = { type: "cover", doc, resolve };
      status = "视频和表单已经准备完成。请在网站中人工编辑并保存封面，完成后点击“继续”发表。";
      updatePanel();
    }).then((confirmed) => {
      if (!confirmed || state.cancelled) throw new Error("已取消");
      return true;
    });
  }

  function requestManualOriginal(doc, reason) {
    return new Promise((resolve) => {
      state.manualSelection = { type: "original", doc, resolve };
      status = `原创声明未能自动完成（${reason}）。请在网站中人工完成原创声明，然后点击“继续”。`;
      updatePanel();
    }).then((confirmed) => {
      if (!confirmed || state.cancelled) throw new Error("已取消");
      return true;
    });
  }

  function requestManualReview(doc) {
    if (!state.manualReviewRequested) return Promise.resolve(false);
    state.manualReviewRequested = false;
    return new Promise((resolve) => {
      state.manualSelection = { type: "review", doc, resolve };
      status = "已停在发表前。你可以任意修改内容；完成后点击“继续”，脚本将不审查修改内容并直接发表。";
      updatePanel();
    }).then((confirmed) => {
      if (!confirmed || state.cancelled) throw new Error("已取消");
      return true;
    });
  }

  function continueAfterManualSelection() {
    const pending = state.manualSelection;
    if (!pending) return;
    if (["cover", "original", "review"].includes(pending.type)) {
      state.manualSelection = null;
      status = pending.type === "cover"
        ? "已确认封面编辑完成，正在准备发表…"
        : pending.type === "original"
          ? "已确认原创声明完成，正在继续…"
          : "已确认人工检查完成，正在直接发表…";
      updatePanel();
      pending.resolve(true);
      return;
    }
    const selectedTitle = getSelectedDramaTitle(pending.doc);
    if (!selectedTitle) {
      status = "尚未检测到已选择的短剧。请先在网站弹窗中选择，再点击“继续”。";
      updatePanel();
      return;
    }
    state.manualSelection = null;
    status = `已确认人工选择：${selectedTitle}，正在继续…`;
    updatePanel();
    pending.resolve(selectedTitle);
  }

  async function openCreatePage() {
    status = "正在打开发表页面…";
    updatePanel();
    const result = await chrome.runtime.sendMessage({ type: "click-list-publish" });
    if (!result?.ok) throw new Error(result?.error || `发表视频按钮匹配数量为 ${result?.count ?? 0}${result?.detail ? `；frame扫描：${result.detail}` : ""}`);
    return waitFor(() => location.pathname === "/platform/post/create", "发布页面", TIMEOUTS.normal, () => state.cancelled);
  }

  async function runJobInCreateFrame(file) {
    status = "正在按实际表单内容定位执行文档…";
    updatePanel();
    let createDocument;
    try {
      createDocument = await waitFor(() => {
        const matches = collectAccessibleDocuments().filter(({ doc }) => hasCreateFormEvidence(doc));
        return matches.length === 1 ? matches[0] : null;
      }, "唯一的真实发布表单", TIMEOUTS.normal, () => state.cancelled);
    } catch (error) {
      throw new Error(`${error.message}；文档扫描=${JSON.stringify(createDocumentDiagnostics()).slice(0, 1600)}`);
    }
    const payload = {
      file,
      description: state.settings.description,
      shortTitle: state.settings.shortTitle,
      searchKeyword: state.searchKeyword,
      linkType: state.settings.linkType,
      videoMark: state.settings.videoMark,
      declareOriginal: state.settings.declareOriginal
    };
    await runCreateFrameJob(payload, (nextStatus) => {
      status = `${nextStatus}；document=${createDocument.url}`;
      updatePanel();
    },
    () => state.cancelled,
    requestManualDramaSelection,
    state.settings.manualCoverEnabled ? requestManualCoverEdit : null,
    requestManualOriginal,
    requestManualReview);
  }

  async function publishOne(file) {
    state.currentIndex = state.files.indexOf(file);
    status = `正在处理第 ${state.currentIndex + 1}/${state.files.length} 个：${file.name}`;
    updatePanel();
    await openCreatePage();
    await runJobInCreateFrame(file);
    await waitFor(() => location.pathname === "/platform/post/list", "发表后返回视频列表", TIMEOUTS.returnToList, () => state.cancelled);
    const listResult = await chrome.runtime.sendMessage({ type: "check-list" });
    if (!listResult?.ok) throw new Error(listResult?.error || `返回列表后发表视频按钮匹配数量为 ${listResult?.count ?? 0}`);
  }

  async function runQueue() {
    if (state.running || !state.files.length) return;
    if (state.settings.linkType !== "不关联链接" && !normalize(state.searchKeyword)) {
      updatePanel("请先填写短剧搜索词，或把链接类型设为“不关联链接”");
      return;
    }
    saveSettings();
    state.running = true;
    state.cancelled = false;
    state.completedCount = 0;
    status = `准备发布，共 ${state.files.length} 个视频…`;
    updatePanel();
    try {
      for (const file of state.files) {
        await publishOne(file);
        state.completedCount += 1;
        updatePanel(`已完成：${file.name}`);
      }
      updatePanel("全部完成");
    } catch (error) {
      updatePanel(`已暂停：${error.message}`);
    } finally {
      state.running = false;
      state.manualReviewRequested = false;
      state.currentIndex = -1;
      updatePanel();
    }
  }

  function stopQueue() {
    state.cancelled = true;
    state.manualReviewRequested = false;
    const pending = state.manualSelection;
    state.manualSelection = null;
    if (pending) pending.resolve(null);
    status = "正在停止…";
    updatePanel();
    for (const frame of document.querySelectorAll("iframe")) {
      frame.contentWindow?.postMessage({ channel: CHANNEL, type: "STOP_FRAME_JOB" }, "*");
    }
  }

  function makePanelDraggable(element) {
    const handle = element.querySelector(".vba-head");
    let drag = null;

    const setPosition = (left, top, save = false) => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const nextLeft = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      const nextTop = Math.max(8, Math.min(top, window.innerHeight - height - 8));
      element.style.left = `${Math.max(8, nextLeft)}px`;
      element.style.top = `${Math.max(8, nextTop)}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
      if (save) {
        try {
          localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({ left: nextLeft, top: nextTop }));
        } catch {
          // Position persistence is optional.
        }
      }
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      const rect = element.getBoundingClientRect();
      drag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
      element.classList.add("vba-dragging");
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };
    const onPointerMove = (event) => {
      if (!drag) return;
      setPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    };
    const onPointerUp = (event) => {
      if (!drag) return;
      const rect = element.getBoundingClientRect();
      drag = null;
      element.classList.remove("vba-dragging");
      handle.releasePointerCapture?.(event.pointerId);
      setPosition(rect.left, rect.top, true);
    };
    const onResize = () => {
      const rect = element.getBoundingClientRect();
      setPosition(rect.left, rect.top);
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    handle.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("resize", onResize);

    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_POSITION_KEY) || "null");
      if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
        requestAnimationFrame(() => setPosition(saved.left, saved.top));
      }
    } catch {
      // Keep the default position.
    }

    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("resize", onResize);
    };
  }

  function createPanel() {
    panel = document.createElement("div");
    panel.id = "video-batch-assistant-panel";
    panel.innerHTML = `
      <style>
        #video-batch-assistant-panel * { box-sizing: border-box; }
        #video-batch-assistant-panel .vba-head { display:flex; align-items:center; justify-content:space-between; margin:-4px -4px 14px; padding:5px 4px 8px; cursor:grab; touch-action:none; user-select:none; border-bottom:1px solid #f0f1f3; }
        #video-batch-assistant-panel.vba-dragging .vba-head { cursor:grabbing; }
        #video-batch-assistant-panel .vba-title { font-size:17px; font-weight:750; color:#182230; }
        #video-batch-assistant-panel .vba-badge { padding:3px 8px; border-radius:999px; background:#fff3e8; color:#f26b21; font-size:11px; font-weight:700; }
        #video-batch-assistant-panel .vba-picker { display:flex; align-items:center; justify-content:center; width:100%; height:38px; border:1px dashed #f59a5b; border-radius:9px; color:#e9651d; background:#fff9f5; cursor:pointer; font-weight:650; transition:.15s; }
        #video-batch-assistant-panel .vba-picker:hover { background:#fff3e9; border-color:#ee741f; }
        #video-batch-assistant-panel .vba-picker input { display:none; }
        #video-batch-assistant-panel .vba-meta { margin-top:12px; padding:12px; border-radius:9px; background:#f7f8fa; }
        #video-batch-assistant-panel .vba-row { display:flex; justify-content:space-between; gap:14px; color:#667085; font-size:13px; }
        #video-batch-assistant-panel .vba-row + .vba-row { margin-top:5px; }
        #video-batch-assistant-panel .vba-value { color:#293241; font-weight:650; max-width:245px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        #video-batch-assistant-panel .vba-progress-head { display:flex; justify-content:space-between; margin:12px 0 5px; color:#667085; font-size:12px; }
        #video-batch-assistant-panel .vba-progress { height:7px; overflow:hidden; border-radius:999px; background:#edf0f3; }
        #video-batch-assistant-panel .vba-progress > i { display:block; width:0; height:100%; border-radius:inherit; background:linear-gradient(90deg,#ff9a4a,#f36b21); transition:width .25s ease; }
        #video-batch-assistant-panel .vba-settings { margin-top:12px; padding:12px; border:1px solid #eceef1; border-radius:10px; background:#fff; }
        #video-batch-assistant-panel .vba-settings-title { margin-bottom:9px; color:#293241; font-size:13px; font-weight:750; }
        #video-batch-assistant-panel .vba-field { display:grid; grid-template-columns:82px minmax(0,1fr); align-items:center; gap:8px; margin-top:8px; color:#667085; font-size:12px; }
        #video-batch-assistant-panel .vba-field:first-of-type { margin-top:0; }
        #video-batch-assistant-panel .vba-field textarea,
        #video-batch-assistant-panel .vba-field input,
        #video-batch-assistant-panel .vba-field select { width:100%; min-width:0; border:1px solid #dfe3e8; border-radius:7px; background:#fff; color:#293241; font-family:inherit; font-size:12px; line-height:1.45; outline:none; }
        #video-batch-assistant-panel .vba-field input,
        #video-batch-assistant-panel .vba-field select { height:32px; padding:0 8px; }
        #video-batch-assistant-panel .vba-field textarea { min-height:52px; padding:7px 8px; resize:vertical; }
        #video-batch-assistant-panel .vba-field textarea:focus,
        #video-batch-assistant-panel .vba-field input:focus,
        #video-batch-assistant-panel .vba-field select:focus { border-color:#f27628; box-shadow:0 0 0 2px rgba(242,118,40,.12); }
        #video-batch-assistant-panel .vba-option { display:flex; align-items:center; gap:8px; margin-top:12px; padding:10px 11px; border:1px solid #eceef1; border-radius:9px; background:#fff; color:#475467; font-size:13px; cursor:pointer; }
        #video-batch-assistant-panel .vba-option input { width:16px; height:16px; margin:0; accent-color:#f27628; }
        #video-batch-assistant-panel .vba-option:has(input:disabled) { opacity:.55; cursor:not-allowed; }
        #video-batch-assistant-panel .vba-status { margin-top:12px; padding:12px 13px; min-height:58px; border:1px solid #e7e9ed; border-radius:9px; background:#fafbfc; color:#475467; font-size:13px; line-height:1.55; word-break:break-word; }
        #video-batch-assistant-panel .vba-status[data-kind="running"] { border-color:#ffd7b8; background:#fff8f2; color:#b54708; }
        #video-batch-assistant-panel .vba-status[data-kind="manual"] { border-color:#f7c948; background:#fffbea; color:#854d0e; }
        #video-batch-assistant-panel .vba-status[data-kind="error"] { border-color:#fda29b; background:#fff5f4; color:#b42318; }
        #video-batch-assistant-panel .vba-status[data-kind="success"] { border-color:#86d9aa; background:#f1fcf5; color:#08783e; }
        #video-batch-assistant-panel .vba-actions { display:grid; grid-template-columns:1fr 1fr 1fr; gap:7px; margin-top:12px; }
        #video-batch-assistant-panel button { height:36px; border:0; border-radius:8px; cursor:pointer; font-weight:700; font-size:12px; transition:.15s; }
        #video-batch-assistant-panel button:disabled { cursor:not-allowed; opacity:.42; }
        #video-batch-assistant-panel [data-start] { color:#fff; background:#f27628; }
        #video-batch-assistant-panel [data-continue] { color:#7a4a00; background:#ffd666; }
        #video-batch-assistant-panel [data-cancel] { color:#475467; background:#eef1f4; }
        #video-batch-assistant-panel [data-review-next] { width:100%; margin-top:12px; color:#7a4a00; background:#fff0bd; border:1px solid #f5cf67; }
        #video-batch-assistant-panel [data-review-next]:not(:disabled):hover { background:#ffe69a; }
        #video-batch-assistant-panel .vba-note { margin-top:9px; color:#98a2b3; font-size:11px; text-align:center; }
      </style>
      <div class="vba-head">
        <div class="vba-title">视频号批量发布助手</div>
        <div class="vba-badge">${IS_EDGE_BUILD ? "Edge" : "Chrome"} · v${BUILD_VERSION}</div>
      </div>
      <label class="vba-picker">选择剧集文件夹<input data-folder type="file" webkitdirectory multiple accept="video/*"></label>
      <div class="vba-meta">
        <div class="vba-row"><span>来源文件夹</span><span class="vba-value" data-source-folder>—</span></div>
        <div class="vba-row"><span>搜索剧名</span><span class="vba-value" data-folder-name>尚未选择文件夹</span></div>
        <div class="vba-row"><span>文件</span><span class="vba-value" data-count>0 个视频</span></div>
        <div class="vba-row"><span>当前</span><span class="vba-value" data-current-file>—</span></div>
      </div>
      <div class="vba-progress-head"><span>批次进度 <b data-current>0 / 0</b></span><span data-progress-text>0%</span></div>
      <div class="vba-progress"><i data-progress-bar></i></div>
      <div class="vba-settings">
        <div class="vba-settings-title">本批次发布设置（开始前可编辑）</div>
        <label class="vba-field"><span>视频描述</span><textarea data-setting data-description></textarea></label>
        <label class="vba-field"><span>短标题</span><input data-setting data-short-title type="text"></label>
        <label class="vba-field"><span>链接类型</span><select data-setting data-link-type>
          <option>小程序短剧</option><option>视频号剧集</option><option>不关联链接</option>
        </select></label>
        <label class="vba-field"><span>搜索词</span><input data-setting data-search-keyword type="text" placeholder="选择文件夹后自动带入，可修改"></label>
        <label class="vba-field"><span>视频标注</span><select data-setting data-video-mark>
          <option>含AI生成内容</option><option>无需标注</option><option>内容为虚构剧情，仅供娱乐</option>
          <option>个人观点，仅供参考</option><option>内容包含营销广告</option><option>不设置</option>
        </select></label>
      </div>
      <label class="vba-option"><input data-setting data-declare-original type="checkbox">自动声明原创（失败时人工接管）</label>
      <label class="vba-option"><input data-setting data-manual-cover type="checkbox">发布前人工编辑封面（可选）</label>
      <button data-review-next disabled>下次发表前暂停并人工检查</button>
      <div class="vba-status" data-status-card data-kind="idle"><span data-status>请选择一个剧集文件夹</span></div>
      <div class="vba-actions">
        <button data-start disabled>开始发布</button>
        <button data-continue disabled>继续</button>
        <button data-cancel disabled>停止</button>
      </div>
      <div class="vba-note">运行中可随时预约下一次发表前暂停；每点击一次只生效一次</div>
    `;
    Object.assign(panel.style, {
      position: "fixed", right: "24px", bottom: "24px", zIndex: "2147483647", width: "400px", maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100vh - 16px)", overflowY: "auto",
      padding: "18px", background: "rgba(255,255,255,.98)", color: "#222", border: "1px solid #e5e7eb", borderRadius: "14px",
      boxShadow: "0 12px 36px rgba(16,24,40,.18)", font: "14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif",
      backdropFilter: "blur(8px)"
    });
    panel.querySelector("[data-start]").addEventListener("click", runQueue);
    panel.querySelector("[data-continue]").addEventListener("click", continueAfterManualSelection);
    panel.querySelector("[data-cancel]").addEventListener("click", stopQueue);
    panel.querySelector("[data-review-next]").addEventListener("click", () => {
      if (!state.running || state.manualReviewRequested) return;
      state.manualReviewRequested = true;
      status = "已预约：将在下一次点击“发表”之前暂停，届时可人工修改全部内容。";
      updatePanel();
    });
    const settingsBindings = [
      ["[data-description]", "description", "value"],
      ["[data-short-title]", "shortTitle", "value"],
      ["[data-link-type]", "linkType", "value"],
      ["[data-video-mark]", "videoMark", "value"],
      ["[data-declare-original]", "declareOriginal", "checked"],
      ["[data-manual-cover]", "manualCoverEnabled", "checked"]
    ];
    for (const [selector, key, property] of settingsBindings) {
      const control = panel.querySelector(selector);
      control[property] = state.settings[key];
      control.addEventListener("change", () => {
        state.settings[key] = control[property];
        saveSettings();
        updatePanel();
      });
    }
    const descriptionControl = panel.querySelector("[data-description]");
    const shortTitleControl = panel.querySelector("[data-short-title]");
    for (const [control, key] of [[descriptionControl, "description"], [shortTitleControl, "shortTitle"]]) {
      control.addEventListener("input", () => { state.settings[key] = control.value; });
    }
    const searchControl = panel.querySelector("[data-search-keyword]");
    searchControl.value = state.searchKeyword;
    searchControl.addEventListener("input", () => {
      state.searchKeyword = searchControl.value;
    });
    searchControl.addEventListener("change", updatePanel);
    panel.querySelector("[data-folder]").addEventListener("change", (event) => {
      const files = [...event.target.files]
        .filter((file) => file.type.startsWith("video/") || /\.(mp4|m4v|mov|webm)$/i.test(file.name))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" }));
      const roots = new Set(files.map((file) => (file.webkitRelativePath || file.name).split("/")[0]));
      state.completedCount = 0;
      if (roots.size !== 1 || files.length === 0) {
        state.files = [];
        state.sourceFolderName = "";
        state.folderName = "";
        state.searchKeyword = "";
        searchControl.value = "";
        status = "请选择只包含一个剧集名称的文件夹";
      } else {
        state.files = files;
        state.sourceFolderName = [...roots][0];
        state.folderName = dramaNameFromFolder(state.sourceFolderName);
        state.searchKeyword = state.folderName;
        searchControl.value = state.searchKeyword;
        if (!state.folderName) {
          state.files = [];
          status = "去掉“剪辑-”后没有可用于搜索的剧名";
        } else {
          status = state.sourceFolderName === state.folderName
            ? `已选择：${state.folderName}`
            : `已选择：${state.sourceFolderName}；搜索剧名：${state.folderName}`;
        }
      }
      updatePanel();
    });
    document.documentElement.appendChild(panel);
    removePanelDragHandlers = makePanelDraggable(panel);
    updatePanel();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "TOGGLE_PANEL") return;
    if (panel) {
      removePanelDragHandlers?.();
      removePanelDragHandlers = null;
      panel.remove();
      panel = null;
    } else createPanel();
  });
})();
