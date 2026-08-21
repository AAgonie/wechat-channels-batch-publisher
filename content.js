(() => {
  const CHANNEL = "video-batch-assistant-v1";
  const BUILD_MANIFEST = chrome.runtime.getManifest();
  const BUILD_NAME = BUILD_MANIFEST.name;
  const BUILD_VERSION = BUILD_MANIFEST.version;
  const IS_EDGE_BUILD = BUILD_NAME.includes("Edge");
  const PANEL_POSITION_KEY = "video-batch-assistant-panel-position";
  const EXTRA_WAIT_MS = IS_EDGE_BUILD ? 10000 : 0;
  const TIMEOUTS = {
    normal: 20000 + EXTRA_WAIT_MS,
    upload: 60000 + EXTRA_WAIT_MS,
    returnToList: 60000 + EXTRA_WAIT_MS
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
    while (Date.now() - started < timeout) {
      if (isCancelled()) throw new Error("已取消");
      if (normalize(element.textContent) === expected) {
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
      .filter((text) => text && text !== "选择需要添加的短剧" && text !== "选择链接");
    return candidates[0] || "";
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

  async function runCreateFrameJob(
    payload,
    report,
    isCancelled,
    requestManualDramaSelection = null,
    requestManualCoverEdit = null
  ) {
    const doc = document;
    report(`正在定位网站上传控件：${payload.file.name}`);
    await waitFor(() => doc.readyState === "complete" && doc.body, "发布表单页面加载", TIMEOUTS.normal, isCancelled);
    await submitVideoToUploader(doc, payload.file, report, isCancelled);

    report("正在填写描述和短标题…");
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
    const shortTitle = await waitFor(
      () => findShortTitle(doc),
      `短标题；${fieldDiagnostics(doc)}`,
      TIMEOUTS.normal,
      isCancelled
    );
    setInputValue(shortTitle, payload.shortTitle);
    await waitFor(() => shortTitle.value === payload.shortTitle, "确认短标题写入", TIMEOUTS.normal, isCancelled);

    report("正在选择小程序短剧…");
    const linkDisplay = await waitFor(() => findExactClickTarget(doc, "选择链接", [
      "div.link-display-wrap",
      "div.post-link-wrap div.link-display-wrap",
      "div.select-display"
    ]), `链接下拉框；候选=${exactTextDiagnostics(doc, ["选择链接"])}`, TIMEOUTS.normal, isCancelled);
    linkDisplay.click();
    const miniDrama = await waitFor(() => findExactClickTarget(doc, "小程序短剧", [
      "div.link-option-item", "div.link-list-options > div"
    ]), `小程序短剧选项；候选=${exactTextDiagnostics(doc, ["小程序短剧"])}`, TIMEOUTS.normal, isCancelled);
    miniDrama.click();
    const trigger = await waitFor(() => findExactClickTarget(doc, "选择需要添加的短剧", [
      "div.post-component-choose-wrap", "div.link-input-wrap div.content-wrap"
    ]), `短剧选择入口；候选=${exactTextDiagnostics(doc, ["选择需要添加的短剧"])}`, TIMEOUTS.normal, isCancelled);
    trigger.click();
    const search = await waitFor(() => findVisibleInput(doc, [
      'input[placeholder="请输入短剧名称"]',
      'input[placeholder*="短剧名称"]',
      '.weui-desktop-dialog input.weui-desktop-form__input'
    ]), "短剧搜索框", TIMEOUTS.normal, isCancelled);
    setInputValue(search, payload.folderName);

    const escapedName = payload.folderName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const titlePattern = new RegExp(`^${escapedName}(?:\\d+集)?$`);
    const row = await waitFor(() => {
      const rows = queryAllDeep(doc, "tr.drama-row, tr.ant-table-row").filter((element) =>
        isVisible(element) && titlePattern.test(normalize(element.querySelector(".drama-info-cell")?.textContent))
      );
      return rows.length === 1 ? rows[0] : null;
    }, "唯一短剧搜索结果", TIMEOUTS.normal, isCancelled).catch(async (error) => {
      if (isCancelled() || !requestManualDramaSelection) throw error;
      await requestManualDramaSelection(doc, payload.folderName);
      return null;
    });
    if (row) {
      row.click();
      await waitFor(() => {
        const selected = queryAllDeep(doc, ".choose-content, .link-input-wrap .content-wrap")
          .filter(isVisible)
          .some((element) => normalize(element.textContent) === payload.folderName);
        return selected;
      }, `确认短剧选择；目标=${payload.folderName}; 候选=${exactTextDiagnostics(doc, [payload.folderName])}`, TIMEOUTS.normal, isCancelled);
    }

    report("正在设置 AI 内容标注…");
    const markSelect = await waitFor(() => {
      const direct = queryAllDeep(doc, "div.mark-tag-select").filter(isVisible);
      if (direct.length === 1) return direct[0];
      return findExactClickTarget(doc, "选择视频标注", [
        "div.form-item.post-with-mark-tag div.select-display",
        "div.post-with-mark-tag div.select-display"
      ]);
    }, `视频标注下拉框；候选=${exactTextDiagnostics(doc, ["选择视频标注"])}`, TIMEOUTS.normal, isCancelled);
    markSelect.click();
    const aiOption = await waitFor(() => findExactClickTarget(doc, "含AI生成内容", [
      "div.mark-tag-option", "div.mark-tag-options > div"
    ]), `AI 生成内容选项；候选=${exactTextDiagnostics(doc, ["含AI生成内容"])}`, TIMEOUTS.normal, isCancelled);
    aiOption.click();
    await waitFor(() => queryAllDeep(doc, "div.mark-tag-select, div.post-with-mark-tag")
      .filter(isVisible)
      .some((element) => normalize(element.textContent).includes("含AI生成内容")),
    `确认 AI 内容标注；候选=${exactTextDiagnostics(doc, ["含AI生成内容"])}`, TIMEOUTS.normal, isCancelled);

    report("视频正在上传和处理，请等待…");
    let publish = await waitFor(() => {
      const blocking = visibleWebsiteStatusTexts(doc, /(正在上传|上传中|等待上传|正在处理|处理中|正在转码|转码中)/);
      const errors = visibleWebsiteStatusTexts(doc, /(上传失败|处理失败|转码失败)/);
      if (errors.length) throw new Error(`网站报告视频处理失败：${errors.join(" | ")}`);
      const button = findPublishButton(doc);
      return button && blocking.length === 0 ? button : null;
    }, `视频上传和处理完成；就绪诊断=${publishReadinessDiagnostics(doc)}`, TIMEOUTS.upload, isCancelled);
    if (requestManualCoverEdit) {
      await requestManualCoverEdit(doc);
      report("封面编辑已确认，正在重新检查发表状态…");
      publish = await waitFor(() => {
        const blocking = visibleWebsiteStatusTexts(doc, /(正在上传|上传中|等待上传|正在处理|处理中|正在转码|转码中)/);
        return blocking.length === 0 ? findPublishButton(doc) : null;
      }, `封面编辑后的发表按钮；就绪诊断=${publishReadinessDiagnostics(doc)}`, TIMEOUTS.normal, isCancelled);
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
  const state = {
    files: [], sourceFolderName: "", folderName: "", running: false, cancelled: false,
    currentIndex: -1, completedCount: 0, manualSelection: null, manualCoverEnabled: false
  };
  let panel;
  let removePanelDragHandlers = null;
  let status = "请选择一个剧集文件夹";

  function updatePanel(message) {
    if (message) status = message;
    if (!panel) return;
    panel.querySelector("[data-status]").textContent = status;
    panel.querySelector("[data-count]").textContent = `${state.files.length} 个视频`;
    panel.querySelector("[data-folder-name]").textContent = state.folderName || "尚未选择文件夹";
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
    panel.querySelector("[data-manual-cover]").disabled = state.running;
    panel.querySelector("[data-manual-cover]").checked = state.manualCoverEnabled;
  }

  function requestManualDramaSelection(doc, folderName) {
    return new Promise((resolve) => {
      state.manualSelection = { type: "drama", doc, folderName, resolve };
      status = `未自动找到“${folderName}”。请在网站弹窗中人工搜索并选择短剧，然后点击“继续”。`;
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

  function continueAfterManualSelection() {
    const pending = state.manualSelection;
    if (!pending) return;
    if (pending.type === "cover") {
      state.manualSelection = null;
      status = "已确认封面编辑完成，正在准备发表…";
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
      file, folderName: state.folderName,
      description: "👆点上方链接，免费看全集", shortTitle: "免费短剧看全集"
    };
    await runCreateFrameJob(payload, (nextStatus) => {
      status = `${nextStatus}；document=${createDocument.url}`;
      updatePanel();
    },
    () => state.cancelled,
    requestManualDramaSelection,
    state.manualCoverEnabled ? requestManualCoverEdit : null);
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
      state.currentIndex = -1;
      updatePanel();
    }
  }

  function stopQueue() {
    state.cancelled = true;
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
      <label class="vba-option"><input data-manual-cover type="checkbox">发布前人工编辑封面（可选）</label>
      <div class="vba-status" data-status-card data-kind="idle"><span data-status>请选择一个剧集文件夹</span></div>
      <div class="vba-actions">
        <button data-start disabled>开始发布</button>
        <button data-continue disabled>继续</button>
        <button data-cancel disabled>停止</button>
      </div>
      <div class="vba-note">默认自动发表；勾选封面选项后才会暂停等待</div>
    `;
    Object.assign(panel.style, {
      position: "fixed", right: "24px", bottom: "24px", zIndex: "2147483647", width: "360px", maxWidth: "calc(100vw - 16px)",
      padding: "18px", background: "rgba(255,255,255,.98)", color: "#222", border: "1px solid #e5e7eb", borderRadius: "14px",
      boxShadow: "0 12px 36px rgba(16,24,40,.18)", font: "14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif",
      backdropFilter: "blur(8px)"
    });
    panel.querySelector("[data-start]").addEventListener("click", runQueue);
    panel.querySelector("[data-continue]").addEventListener("click", continueAfterManualSelection);
    panel.querySelector("[data-cancel]").addEventListener("click", stopQueue);
    panel.querySelector("[data-manual-cover]").addEventListener("change", (event) => {
      state.manualCoverEnabled = event.target.checked;
      status = state.manualCoverEnabled
        ? "已开启：每个视频发表前等待人工编辑封面"
        : "已关闭封面人工确认：视频就绪后自动发表";
      updatePanel();
    });
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
        status = "请选择只包含一个剧集名称的文件夹";
      } else {
        state.files = files;
        state.sourceFolderName = [...roots][0];
        state.folderName = dramaNameFromFolder(state.sourceFolderName);
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
