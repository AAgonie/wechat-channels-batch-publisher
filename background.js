const IS_EDGE_BUILD = chrome.runtime.getManifest().name.includes("Edge");
const LIST_FRAME_WAIT_MS = IS_EDGE_BUILD ? 20000 : 10000;

async function injectAllFrames(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"]
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || tab.url.startsWith("chrome://")) return;
  await injectAllFrames(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" }).catch(() => {});
});

async function listFrameAction(action, maxWaitMs) {
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const findMatches = () => [...document.querySelectorAll("button")]
    .filter((button) => normalize(button.textContent) === "发表视频");

  let matches = findMatches();
  const started = Date.now();
  while (matches.length === 0 && Date.now() - started < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    matches = findMatches();
  }
  if (action === "click-list-publish" && matches.length === 1) matches[0].click();

  return {
    ok: matches.length === 1,
    count: matches.length,
    url: location.href,
    diagnostic: {
      buttonTexts: [...document.querySelectorAll("button")]
        .map((button) => normalize(button.textContent)).filter(Boolean).slice(0, 20),
      bodyHasPublishText: normalize(document.body?.innerText).includes("发表视频")
    }
  };
}

function fillDescriptionInMainWorld(value) {
  const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const expected = normalize(value);
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const queryAllDeep = (root, selector) => {
    const matches = [...root.querySelectorAll(selector)];
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) matches.push(...queryAllDeep(element.shadowRoot, selector));
    }
    return matches;
  };
  const selectors = [
    'div.input-editor[contenteditable][data-placeholder="添加描述"]',
    '[contenteditable][data-placeholder*="描述"]',
    '.post-desc-box [contenteditable]'
  ];
  let editor = null;
  for (const selector of selectors) {
    const candidates = queryAllDeep(document, selector).filter((element) =>
      isVisible(element.closest?.(".post-desc-box") || element)
    );
    if (candidates.length === 1) {
      editor = candidates[0];
      break;
    }
  }
  if (!editor) return { ok: false, url: location.href, error: "可见描述编辑器数量不为 1" };

  editor.focus();
  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, value);
    if (!inserted) inserted = document.execCommand("insertHTML", false, value);
  } catch (error) {
    return { ok: false, url: location.href, error: error.message };
  }
  if (!inserted || normalize(editor.textContent) !== expected) {
    return {
      ok: false,
      url: location.href,
      error: `富文本命令未生效；inserted=${inserted}; current=${JSON.stringify(normalize(editor.textContent))}`
    };
  }
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
  editor.blur();
  return { ok: true, url: location.href, value: normalize(editor.textContent) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender.tab?.id) return;

  if (message.type === "inject-content-all-frames") {
    injectAllFrames(sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "fill-description-main") {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, allFrames: true },
      world: "MAIN",
      func: fillDescriptionInMainWorld,
      args: [message.value]
    }).then((results) => {
      const frameResults = results.map((item) => item.result).filter(Boolean);
      const hit = frameResults.find((item) => item.ok);
      sendResponse(hit || {
        ok: false,
        error: frameResults.map((item) => `${item.url || "unknown"}: ${item.error || "未找到编辑器"}`).join(" | ")
      });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (!["click-list-publish", "check-list"].includes(message.type)) return;

  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, allFrames: true },
    world: "MAIN",
    func: listFrameAction,
    args: [message.type, LIST_FRAME_WAIT_MS]
  }).then((results) => {
    const frameResults = results.map((item) => item.result).filter(Boolean);
    const hit = frameResults.find((item) => item.ok);
    sendResponse(hit || {
      ok: false,
      count: 0,
      detail: frameResults.map((item) =>
        `${item.url || "unknown"}: ${item.count}; buttons=${(item.diagnostic?.buttonTexts || []).join(",") || "none"}; bodyHas=${item.diagnostic?.bodyHasPublishText}`
      ).join(" | ")
    });
  }).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
