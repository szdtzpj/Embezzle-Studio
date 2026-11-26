import path from 'node:path';

import {
  buildOpenAiChatSseChunks,
  buildOpenAiResponsesSseChunks,
  generateHighFrequencyTextDeltas,
  TINY_PNG_BASE64,
} from '../helpers/sseFixtures.ts';
import { createStaticDistServer } from '../helpers/staticDistServer.ts';
import {
  buildInjectedWebProbesScript,
  CORE_WEB_INTERACTIVE_TARGETS,
} from '../helpers/webGeometryProbes.ts';

/**
 * 断言辅助函数，校验失败时抛出带清晰上下文的 Error。
 * @param {unknown} condition 断言条件
 * @param {string} message 失败说明
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`[Web E2E Assertion Failed] ${message}`);
  }
}

/**
 * 判断请求 URL 是否属于本地回环地址（避免统计为外网泄露）。
 * @param {string} rawUrl 请求地址
 * @returns {boolean} 是否为本地回环或非网络协议
 */
function isLocalOrInlineUrl(rawUrl) {
  if (
    rawUrl.startsWith('data:') ||
    rawUrl.startsWith('blob:') ||
    rawUrl.startsWith('about:') ||
    rawUrl.startsWith('chrome-extension:')
  ) {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

const ALLOWED_CONSOLE_WARN_PATTERNS = [
  /\[expo-notifications\]\s*Listening to push token changes is not yet fully supported on web/i,
  // React Native Web 0.21 在 dev 模式下对既有 RN style/prop 兼容层的已知全局提示（生产 dist/ 无此输出）
  /^"shadow\*" style props are deprecated\. Use "boxShadow"\.$/,
  /^props\.pointerEvents is deprecated\. Use style\.pointerEvents$/,
  // 既有 AppDialogHost <-> ConfirmDialog/NoticeDialog 纯类型/Content 互引产生的 Metro dev 提示（精确限定文件对，新增环路仍 fail）
  /^Require cycle: src\/ui\/components\/AppDialogHost\.tsx -> src\/ui\/components\/(?:Confirm|Notice)Dialog\.tsx -> src\/ui\/components\/AppDialogHost\.tsx\b/,
];

/**
 * 挂载页面级 Console Error、非白名单 Console Warn、Page Error 与外发网络请求监听器。
 * @param {import('playwright').Page} page Playwright 页面对象
 * @returns {{ consoleErrors: string[]; consoleWarnings: string[]; pageErrors: string[]; externalUrls: string[] }} 采集结果引用
 */
function attachPageDiagnostics(page) {
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  const externalUrls = [];

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error') {
      consoleErrors.push(msg.text());
    } else if (type === 'warning') {
      const text = msg.text();
      const allowed = ALLOWED_CONSOLE_WARN_PATTERNS.some((pattern) => pattern.test(text));
      if (!allowed) {
        consoleWarnings.push(text);
      }
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err instanceof Error ? err.message : String(err));
  });
  page.on('request', (req) => {
    const url = req.url();
    if (!isLocalOrInlineUrl(url)) {
      externalUrls.push(`${req.method()} ${url}`);
    }
  });

  return { consoleErrors, consoleWarnings, pageErrors, externalUrls };
}

/**
 * 等待首次配置向导或主聊天页面就绪；若出现首次配置向导则点击关闭。
 * @param {import('playwright').Page} page Playwright 页面对象
 */
async function dismissOnboardingIfVisible(page) {
  const dismissBtn = page.locator('[role="button"][aria-label="暂时关闭配置向导"]');
  const composerInput = page.locator('[aria-label="消息输入框"]');

  await Promise.race([
    dismissBtn.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined),
    composerInput.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined),
  ]);

  if (await dismissBtn.isVisible().catch(() => false)) {
    await dismissBtn.click();
    await dismissBtn.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }

  await composerInput.waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * 在当前页面执行几何边界、elementFromPoint 可点击性与残余遮罩检查。
 * @param {import('playwright').Page} page Playwright 页面对象
 * @param {string} stageLabel 阶段名称
 */
async function assertWorkspaceGeometryClear(page, stageLabel) {
  const report = await page.evaluate((targets) => {
    const probes = window.__embezzleE2EProbes;
    if (!probes) {
      throw new Error('window.__embezzleE2EProbes 未注入');
    }
    return {
      geometry: probes.probeElementGeometryAndOcclusion(targets),
      overlay: probes.probeOverlayResidual(),
    };
  }, CORE_WEB_INTERACTIVE_TARGETS);

  assert(
    report.geometry.failures.length === 0,
    `${stageLabel} 几何/遮挡失败: ${JSON.stringify(report.geometry.failures)}`
  );
  assert(
    report.geometry.overlaps.length === 0,
    `${stageLabel} 核心元素重叠: ${JSON.stringify(report.geometry.overlaps)}`
  );
  assert(
    !report.overlay.hasBlockingOverlay,
    `${stageLabel} 检测到残余遮罩层: ${JSON.stringify(report.overlay.residuals)}`
  );
  const exportTarget = report.geometry.items.find((item) => item.key === 'chatExportButton');
  assert(
    exportTarget && exportTarget.found && exportTarget.visible && exportTarget.clickable,
    `${stageLabel} chat-export-button 必须可见且可点击: ${JSON.stringify(exportTarget)}`
  );
}

/**
 * 校验 Composer 搜索菜单在当前视口边界内无越界并可干净关闭。
 * @param {import('playwright').Page} page Playwright 页面对象
 * @param {{ width: number; height: number }} viewport 视口尺寸
 * @param {string} stageLabel 阶段名称
 */
async function assertComposerSearchMenuInViewport(page, viewport, stageLabel) {
  const searchGlobe = page.locator('[data-testid="composer-search-globe"]');
  await searchGlobe.waitFor({ state: 'visible', timeout: 5_000 });
  await searchGlobe.click({ timeout: 5_000 });
  const searchMenu = page.locator('[data-testid="composer-search-menu"]');
  await searchMenu.waitFor({ state: 'visible', timeout: 5_000 });
  const menuBox = await searchMenu.boundingBox();
  assert(
    menuBox &&
      menuBox.width > 0 &&
      menuBox.height > 0 &&
      menuBox.x >= 0 &&
      menuBox.y >= 0 &&
      menuBox.x + menuBox.width <= viewport.width + 1 &&
      menuBox.y + menuBox.height <= viewport.height + 1,
    `${stageLabel} Composer 搜索菜单越出视口 (${viewport.width}x${viewport.height}): ${JSON.stringify(menuBox)}`
  );
  await searchGlobe.click({ timeout: 5_000 });
  await searchMenu.waitFor({ state: 'hidden', timeout: 5_000 });
  await page.waitForTimeout(200);
  await assertWorkspaceGeometryClear(page, `${stageLabel} 关闭搜索菜单后`);
}

/**
 * 校验 `/` 快捷指令菜单（弹出、视口边界、Escape 关闭）以及导出弹层开合零残影。
 * @param {import('playwright').Page} page Playwright 页面对象
 * @param {{ width: number; height: number }} viewport 视口尺寸
 * @param {string} stageLabel 阶段名称
 * @param {{ testSlashClear?: boolean }} [options] 可选动作开关
 */
async function assertSlashMenuAndExportDialog(page, viewport, stageLabel, options = {}) {
  const exportBtn = page.locator('[data-testid="chat-export-button"]');
  await exportBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await exportBtn.click({ timeout: 5_000 });
  const exportMarkdownOption = page.locator('[data-testid="export-markdown-option"]');
  await exportMarkdownOption.waitFor({ state: 'visible', timeout: 5_000 });
  await page.keyboard.press('Escape');
  await exportMarkdownOption.waitFor({ state: 'hidden', timeout: 5_000 });
  await page.waitForTimeout(200);
  await assertWorkspaceGeometryClear(page, `${stageLabel} 关闭导出弹窗后`);

  const composerInput = page.locator('[aria-label="消息输入框"]');
  await composerInput.click();
  await composerInput.fill('/');
  const slashMenu = page.locator('[data-testid="slash-command-menu"]');
  await slashMenu.waitFor({ state: 'visible', timeout: 5_000 });
  const slashBox = await slashMenu.boundingBox();
  assert(
    slashBox &&
      slashBox.width > 0 &&
      slashBox.height > 0 &&
      slashBox.x >= 0 &&
      slashBox.y >= 0 &&
      slashBox.x + slashBox.width <= viewport.width + 1 &&
      slashBox.y + slashBox.height <= viewport.height + 1,
    `${stageLabel} slash-command-menu 越出视口 (${viewport.width}x${viewport.height}): ${JSON.stringify(slashBox)}`
  );
  await page.keyboard.press('Escape');
  await slashMenu.waitFor({ state: 'hidden', timeout: 5_000 });

  if (options.testSlashClear) {
    await composerInput.fill('/cle');
    await slashMenu.waitFor({ state: 'visible', timeout: 5_000 });
    await page.keyboard.press('Enter');
    await slashMenu.waitFor({ state: 'hidden', timeout: 5_000 });
    const clearedVal = await composerInput.inputValue();
    assert(clearedVal === '', `${stageLabel} /clear + Enter 应清空输入框，实际: ${JSON.stringify(clearedVal)}`);
  } else {
    await composerInput.fill('');
  }
}

/**
 * 读取主消息区最长可滚动容器的几何与当前滚动位置。
 * @param {import('playwright').Page} page Playwright 页面对象
 * @returns {Promise<{ cx: number; cy: number; scrollTop: number; scrollHeight: number; clientHeight: number; maxTop: number } | null>} 容器指标
 */
async function readMainScrollerMetrics(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('div')).filter((el) => {
      const style = window.getComputedStyle(el);
      return (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 200
      );
    });
    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    const scroller = candidates[0];
    if (!scroller) return null;
    const rect = scroller.getBoundingClientRect();
    return {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      maxTop: scroller.scrollHeight - scroller.clientHeight,
    };
  });
}

/**
 * 从当前已打开的 Settings 页面配置指定或首个服务商的测试 API Key 并返回主聊天页面。
 * @param {import('playwright').Page} page Playwright 页面对象
 * @param {string} apiKey 测试 API Key
 * @param {string | null} providerLabelPrefix 可选服务商名称前缀（如 `'打开 OpenAI'`）
 */
async function configureProviderKeyViaSettings(page, apiKey, providerLabelPrefix = null) {
  await page.locator('[role="button"][aria-label="打开设置"]').click();
  await page.getByText('供应商', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByText('供应商', { exact: true }).click();

  const providerSelector = providerLabelPrefix
    ? `[role="button"][aria-label^="${providerLabelPrefix}"]`
    : '[role="button"][aria-label^="打开 "]';
  const targetProviderRow = page.locator(providerSelector).first();
  await targetProviderRow.waitFor({ state: 'visible', timeout: 10_000 });
  await targetProviderRow.click();

  const keyInput = page.locator('input[placeholder="服务商 API Key"]');
  await keyInput.waitFor({ state: 'visible', timeout: 10_000 });
  await keyInput.fill(apiKey);
  await page.locator('[role="button"]', { hasText: '保存服务商配置' }).first().click();
  await page.locator('[role="button"]', { hasText: '检查连接并获取模型目录' }).first().click();
  await page.waitForTimeout(450);

  // 逐级点击左上角返回按钮，直到主聊天输入框重新变为可见
  const composerInput = page.locator('[aria-label="消息输入框"]');
  const subBackBtn = page.locator('[role="button"][aria-label="返回"]');
  for (let step = 0; step < 8; step += 1) {
    if (await composerInput.isVisible().catch(() => false)) {
      break;
    }
    if (await subBackBtn.first().isVisible().catch(() => false)) {
      await subBackBtn.first().click();
      await page.waitForTimeout(300);
      continue;
    }
    // SettingsMainScreen 的返回按钮位于顶部栏左上角（无 aria-label），通过几何位置定位点击
    const topLeftBack = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('[role="button"]'));
      for (const btn of buttons) {
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.left < 80 && rect.top < 80) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (!topLeftBack) {
      break;
    }
    await page.waitForTimeout(300);
  }
  await composerInput.waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Mode A（S4）：`dist/` 生产静态产物多视口几何无遮挡与生产密钥 fail-closed 安全边界验收。
 * @param {{ browser: import('playwright').Browser; distDir: string; logger?: Console }} options 执行参数
 * @returns {Promise<{ suite: string; passed: boolean; checks: string[] }>} 验收结果
 */
export async function runDistModeSuite({ browser, distDir, logger = console }) {
  const checks = [];
  const server = createStaticDistServer({ distDir: path.resolve(distDir) });
  const { appBaseUrl } = await server.start();
  const injectedProbeScript = buildInjectedWebProbesScript();

  try {
    const viewports = [
      { name: 'desktop-1280x800', width: 1280, height: 800 },
      { name: 'mobile-390x844', width: 390, height: 844 },
    ];

    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await context.addInitScript(injectedProbeScript);
      const page = await context.newPage();
      const diag = attachPageDiagnostics(page);

      try {
        await page.goto(`${appBaseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await dismissOnboardingIfVisible(page);

        // 1. 首屏主工作区几何与零遮罩验证
        await assertWorkspaceGeometryClear(page, `Mode A [${vp.name}] 首屏`);
        checks.push(`${vp.name}: 首屏几何与 elementFromPoint 校验通过`);

        // 2. 打开并关闭侧边栏 Drawer，验证无透明 scrim 残留
        await page.locator('[role="button"][aria-label="打开聊天记录"]').click();
        const closeDrawerBtn = page.locator('[role="button"][aria-label="关闭聊天记录"]').first();
        await closeDrawerBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await closeDrawerBtn.click();
        await closeDrawerBtn.waitFor({ state: 'hidden', timeout: 10_000 });
        await page.waitForTimeout(350);
        await assertWorkspaceGeometryClear(page, `Mode A [${vp.name}] 关闭 Drawer 后`);
        checks.push(`${vp.name}: Drawer 开合无遮罩残留`);

        // 2b. 验证搜索菜单在视口边界内（含 390x844 窄屏）
        await assertComposerSearchMenuInViewport(page, vp, `Mode A [${vp.name}]`);
        checks.push(`${vp.name}: composer-search-menu 视口边界校验通过`);

        // 2c. 验证导出弹窗与 / 斜杠指令菜单交互及零残影
        await assertSlashMenuAndExportDialog(page, vp, `Mode A [${vp.name}]`, {
          testSlashClear: vp.name === 'desktop-1280x800',
        });
        checks.push(`${vp.name}: chat-export-button 与 slash-command-menu 交互零残影`);

        // 3. 在桌面视口执行设置页配置、生产密钥 fail-closed 拦截验证，随后验证模型选择器开合无残影
        if (vp.name === 'desktop-1280x800') {
          await configureProviderKeyViaSettings(page, 'sk-dist-fail-closed-test');

          assert(
            diag.externalUrls.length === 0,
            `生产 Web 构建不应发起任何外网请求，实际发出: ${diag.externalUrls.join(', ')}`
          );

          await assertWorkspaceGeometryClear(page, `Mode A [${vp.name}] 退出设置后`);

          // 在聊天输入框尝试发送消息，再次确认零外发请求且界面给出明确禁止提示
          const msgInput = page.locator('[aria-label="消息输入框"]');
          await msgInput.fill('测试生产构建密钥边界');
          await page.locator('[role="button"][aria-label="发送消息"]').click();
          await page.waitForTimeout(400);
          assert(
            diag.externalUrls.length === 0,
            `生产 Web 构建发送消息不应外发请求，实际发出: ${diag.externalUrls.join(', ')}`
          );
          checks.push(`${vp.name}: 生产构建 API Key 外发 fail-closed 拦截校验通过`);
        }

        // 4. 点击顶部模型选择器（已配置 Key 时弹出 model-picker-sheet，未配置时弹出配置向导）并关闭，验证无残影阻挡
        const pickerTrigger = page.locator('[data-testid="model-picker-trigger"]');
        await pickerTrigger.click();
        const pickerSheet = page.locator('[data-testid="model-picker-sheet"]');
        const setupDismiss = page.locator('[role="button"][aria-label="暂时关闭配置向导"]');
        await Promise.race([
          pickerSheet.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined),
          setupDismiss.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined),
        ]);
        if (await pickerSheet.isVisible().catch(() => false)) {
          await page.locator('[role="button"][aria-label="关闭模型选择"]').click();
          await pickerSheet.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
        } else if (await setupDismiss.isVisible().catch(() => false)) {
          await setupDismiss.click();
          await setupDismiss.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
        } else {
          throw new Error(`Mode A [${vp.name}] 点击 model-picker-trigger 后既未打开模型选择也未打开配置向导`);
        }
        await page.waitForTimeout(250);
        await assertWorkspaceGeometryClear(page, `Mode A [${vp.name}] 关闭模型选择器后`);
        checks.push(`${vp.name}: 模型选择器开合无残影`);

        assert(
          diag.consoleErrors.length === 0,
          `Mode A [${vp.name}] 存在 console.error: ${diag.consoleErrors.join(' | ')}`
        );
        assert(
          diag.consoleWarnings.length === 0,
          `Mode A [${vp.name}] 存在非白名单 console.warn: ${diag.consoleWarnings.join(' | ')}`
        );
        assert(
          diag.pageErrors.length === 0,
          `Mode A [${vp.name}] 存在 pageerror: ${diag.pageErrors.join(' | ')}`
        );
      } finally {
        await context.close();
      }
    }

    // 5. M3 专题（mobile-390x844）：ImageGenParamsBar 渲染无遮挡 + ImageLightboxModal 懒加载/缩放/以此图继续编辑零残影
    {
      const seededImageEnvelope = JSON.stringify({
        schemaVersion: 7,
        revision: 2,
        savedAt: Date.now(),
        workspace: {
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              kind: 'openai-compatible',
              baseUrl: 'https://api.openai.com/v1',
              authHeaderMode: 'bearer',
              imageApiMode: 'auto',
              capabilities: [
                'text',
                'image-input',
                'tool-calling',
                'reasoning',
                'web-search',
                'image-generation',
                'streaming',
              ],
              models: [
                {
                  id: 'gpt-image-2.5-sunburst',
                  name: 'GPT Image 2.5 Sunburst',
                  capabilities: ['text', 'image-input', 'image-generation'],
                  task: 'image-generation',
                  source: 'manual',
                },
                {
                  id: 'gpt-4.1',
                  name: 'GPT-4.1',
                  capabilities: ['text', 'image-input', 'tool-calling', 'streaming'],
                  task: 'chat',
                  source: 'manual',
                },
              ],
            },
          ],
          activeProviderId: 'openai',
          activeModelIdByProvider: { openai: 'gpt-image-2.5-sunburst' },
          activeProjectId: 'project-default',
          activeConversationId: 'conv-m3-image-s4',
          conversations: [
            {
              id: 'conv-m3-image-s4',
              projectId: 'project-default',
              title: 'M3 生图与灯箱校验',
              createdAt: 1764000000000,
              updatedAt: 1764000100000,
              messages: [
                {
                  id: 'm3-img-user-1',
                  role: 'user',
                  content: '生成一张太空橘猫测试图',
                  createdAt: 1764000000000,
                  status: 'ready',
                },
                {
                  id: 'm3-img-asst-1',
                  role: 'assistant',
                  content: '太空橘猫已生成。',
                  modelId: 'gpt-image-2.5-sunburst',
                  attachments: [
                    {
                      id: 'e2e-img-1',
                      kind: 'image',
                      uri: `data:image/png;base64,${TINY_PNG_BASE64}`,
                      name: 'orbit-cat.png',
                      mimeType: 'image/png',
                    },
                  ],
                  createdAt: 1764000050000,
                  status: 'ready',
                },
              ],
            },
          ],
          onboarding: { status: 'completed', lastStep: 'provider' },
        },
      });

      const mobileVp = { width: 390, height: 844 };
      const context = await browser.newContext({ viewport: mobileVp });
      await context.addInitScript(`
        ${injectedProbeScript}
        try {
          window.localStorage.setItem('@embezzle-studio/workspace-v7', ${JSON.stringify(seededImageEnvelope)});
        } catch (_err) {}
      `);
      const page = await context.newPage();
      const diag = attachPageDiagnostics(page);
      const lightboxChunkResponses = [];
      const failedChunkRequests = [];
      page.on('response', (res) => {
        if (/ImageLightboxModal/i.test(res.url())) {
          lightboxChunkResponses.push({ url: res.url(), status: res.status() });
        }
      });
      page.on('requestfailed', (req) => {
        failedChunkRequests.push(`${req.url()} (${req.failure()?.errorText ?? 'unknown'})`);
      });

      try {
        await page.goto(`${appBaseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await dismissOnboardingIfVisible(page);

        const paramsBar = page.locator('[data-testid="image-gen-params-bar"]');
        await paramsBar.waitFor({ state: 'visible', timeout: 10_000 });
        const paramsBarBox = await paramsBar.boundingBox();
        assert(
          paramsBarBox &&
            paramsBarBox.height > 0 &&
            paramsBarBox.height <= 36.5 &&
            paramsBarBox.x >= 0 &&
            paramsBarBox.x + paramsBarBox.width <= mobileVp.width + 1,
          `ImageGenParamsBar 高度或视口边界异常: ${JSON.stringify(paramsBarBox)}`
        );
        await assertWorkspaceGeometryClear(page, 'Mode A [mobile-390x844] ImageGenParamsBar 挂载后');

        const imgPreview = page.locator('[data-testid="attachment-image-preview-e2e-img-1"]');
        await imgPreview.waitFor({ state: 'visible', timeout: 10_000 });
        await imgPreview.click();

        const lightboxOverlay = page.locator('[data-testid="image-lightbox-overlay"]');
        await lightboxOverlay.waitFor({ state: 'visible', timeout: 15_000 });
        assert(
          lightboxChunkResponses.some((item) => item.status >= 200 && item.status < 400),
          `点击图片应按需懒加载 ImageLightboxModal chunk，实际响应: ${JSON.stringify(lightboxChunkResponses)}`
        );
        assert(
          failedChunkRequests.length === 0,
          `灯箱懒加载存在失败请求: ${failedChunkRequests.join(', ')}`
        );

        await page.locator('[data-testid="image-lightbox-zoom-in"]').click();
        const zoomResetText = await page.locator('[data-testid="image-lightbox-zoom-reset"]').innerText();
        assert(zoomResetText.includes('1.5x'), `点击放大后缩放倍率应显示 1.5x，实际: ${zoomResetText}`);

        await page.locator('[data-testid="image-lightbox-edit"]').click();
        await lightboxOverlay.waitFor({ state: 'hidden', timeout: 10_000 });
        await page.locator('[aria-label^="移除附件 "]').first().waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(250);

        const residualAfterEdit = await page.evaluate(() => window.__embezzleE2EProbes.probeOverlayResidual());
        assert(
          !residualAfterEdit.hasBlockingOverlay,
          `“以此图继续编辑”关闭灯箱后存在残余遮罩: ${JSON.stringify(residualAfterEdit.residuals)}`
        );

        assert(diag.consoleErrors.length === 0, `Mode A [M3-Image] console.error: ${diag.consoleErrors.join(' | ')}`);
        assert(diag.consoleWarnings.length === 0, `Mode A [M3-Image] 非白名单 console.warn: ${diag.consoleWarnings.join(' | ')}`);
        assert(diag.pageErrors.length === 0, `Mode A [M3-Image] pageerror: ${diag.pageErrors.join(' | ')}`);
        assert(diag.externalUrls.length === 0, `Mode A [M3-Image] 外发请求: ${diag.externalUrls.join(', ')}`);
        checks.push('mobile-390x844: ImageGenParamsBar 无遮挡 + ImageLightboxModal 懒加载/1.5x缩放/以此图继续编辑零残影');
      } finally {
        await context.close();
      }
    }

    logger.log(`[Web E2E Mode A] 全部通过 (${checks.length} 项检查)`);
    return { suite: 'Mode A (dist/)', passed: true, checks };
  } finally {
    await server.close();
  }
}

/**
 * 构建带轻量代理重定向与可预置工作区状态钩子的浏览器初始化脚本。
 * @param {number} proxyPort 随机本地开发代理端口
 * @param {string | null} seededEnvelopeJson 可选预置工作区 JSON
 * @returns {string} initScript 字符串
 */
function buildDevModeInitScript(proxyPort, seededEnvelopeJson = null) {
  const probesScript = buildInjectedWebProbesScript();
  const proxyTarget = `http://127.0.0.1:${proxyPort}/proxy`;
  const seedScript = seededEnvelopeJson
    ? `
      try {
        window.localStorage.setItem('@embezzle-studio/workspace-v7', ${JSON.stringify(seededEnvelopeJson)});
      } catch (_err) {}
    `
    : '';

  return `
    ${probesScript}
    (function () {
      ${seedScript}
      const originalFetch = window.fetch.bind(window);
      const LEGACY_PROXY_URL = 'http://127.0.0.1:8787/proxy';
      const TARGET_PROXY_URL = ${JSON.stringify(proxyTarget)};
      window.fetch = function (input, init) {
        const rawUrl = typeof input === 'string'
          ? input
          : (input && typeof input.url === 'string' ? input.url : '');
        if (rawUrl === LEGACY_PROXY_URL || rawUrl.startsWith(LEGACY_PROXY_URL + '?')) {
          const rewritten = rawUrl.replace(LEGACY_PROXY_URL, TARGET_PROXY_URL);
          if (typeof input === 'string') {
            return originalFetch(rewritten, init);
          }
          return originalFetch(new Request(rewritten, input), init);
        }
        return originalFetch(input, init);
      };
    })();
  `;
}

/**
 * Mode B（S5）：`npm run web` + 本地 dev-proxy + MockUpstreamServer 流式压测、Long Task、长对话吸底与窄屏 Drawer 校验。
 * @param {{
 *   browser: import('playwright').Browser;
 *   expoBaseUrl: string;
 *   proxyPort: number;
 *   mockServer: import('../helpers/mockUpstreamServer.ts').MockUpstreamServer;
 *   logger?: Console;
 * }} options 执行参数
 * @returns {Promise<{ suite: string; passed: boolean; checks: string[] }>} 验收结果
 */
export async function runDevStreamingModeSuite({
  browser,
  expoBaseUrl,
  proxyPort,
  mockServer,
  logger = console,
}) {
  const checks = [];

  // =========================================================================
  // 子场景 B1：220 chunks 高频流式渲染 + Long Task 监控 + Composer 菜单几何 + 快捷键
  // =========================================================================
  mockServer.reset();
  mockServer.on(
    { method: 'GET', pathname: '/v1/models' },
    {
      kind: 'json',
      body: {
        data: [
          { id: 'gpt-4.1', object: 'model' },
          { id: 'gpt-5', object: 'model' },
        ],
      },
    }
  );
  const highFreqDeltas = generateHighFrequencyTextDeltas(220, '块');
  mockServer.on(
    { method: 'POST', pathname: '/v1/chat/completions' },
    {
      kind: 'sse',
      chunkDelayMs: 2,
      chunks: buildOpenAiChatSseChunks({
        model: 'gpt-4.1',
        reasoningDeltas: ['正在高速流式推演…'],
        textDeltas: [...highFreqDeltas, '——流式压测完成。'],
      }),
    }
  );
  mockServer.on(
    { method: 'POST', pathname: '/v1/responses' },
    {
      kind: 'sse',
      chunkDelayMs: 2,
      chunks: buildOpenAiResponsesSseChunks({
        model: 'gpt-5',
        reasoningSummaryDeltas: ['Responses 高速流式'],
        textDeltas: [...highFreqDeltas, '——流式压测完成。'],
      }),
    }
  );

  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(buildDevModeInitScript(proxyPort));
    const page = await context.newPage();
    const diag = attachPageDiagnostics(page);

    try {
      await page.goto(expoBaseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await dismissOnboardingIfVisible(page);

      // 通过设置页为 OpenAI 注入测试 API Key 并验证连接（走本地 dev-proxy -> MockUpstreamServer）
      await configureProviderKeyViaSettings(page, 'sk-web-e2e-dev-proxy', '打开 OpenAI');

      // 打开并检验 Composer 搜索菜单视口内无越界，并验证导出与斜杠指令交互
      await assertComposerSearchMenuInViewport(page, { width: 1280, height: 800 }, 'Mode B1');
      checks.push('B1: Composer 搜索菜单几何视口边界验证通过');

      await assertSlashMenuAndExportDialog(page, { width: 1280, height: 800 }, 'Mode B1', {
        testSlashClear: true,
      });
      checks.push('B1: chat-export-button 与 slash-command-menu 交互验证通过');

      // 校验 Shift+Enter 换行保留输入内容且不触发提交
      const composerInput = page.locator('[aria-label="消息输入框"]');
      const countBeforeShiftEnter = mockServer.getRequests({ method: 'POST' }).length;
      await composerInput.click();
      await composerInput.fill('第一行');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('第二行');
      const countAfterShiftEnter = mockServer.getRequests({ method: 'POST' }).length;
      assert(
        countAfterShiftEnter === countBeforeShiftEnter,
        `Shift+Enter 换行不应触发消息提交（POST 数量从 ${countBeforeShiftEnter} 变为 ${countAfterShiftEnter}）`
      );
      const inputVal = await composerInput.inputValue();
      assert(
        /第一行[\r\n]+第二行/.test(inputVal),
        `Shift+Enter 换行应插入换行符并保留两行输入内容，实际值: ${JSON.stringify(inputVal)}`
      );

      // 启动 Long Task & RAF 监测，并硬性断言桌面端 Enter 直接触发真实 POST 与 220 chunks 流式完整落盘
      await page.evaluate(() => window.__embezzleE2EProbes.installLongTaskCollector(true));
      const countBeforeSubmit = mockServer.getRequests({ method: 'POST' }).length;
      await composerInput.fill('请输出 220 个分片进行性能测试');
      const enterPostPromise = page.waitForRequest((req) => req.method() === 'POST', { timeout: 5_000 });
      await page.keyboard.press('Enter');
      const enterPostReq = await enterPostPromise;
      assert(enterPostReq !== null, '桌面端按 Enter 必须直接提交触发真实 POST 请求');
      const submittedVia = 'enter';

      // 等待流式完成标记落盘渲染，并校验全部 220 chunks 文本完整拼接落盘（不仅是末尾标语）
      await page.getByText('——流式压测完成。').waitFor({ state: 'visible', timeout: 30_000 });
      const renderedBodyText = await page.evaluate(() => document.body?.innerText ?? '');
      const compactBodyText = renderedBodyText.replace(/\s+/g, '');
      const expectedCompactPayload = [...highFreqDeltas, '——流式压测完成。'].join('').replace(/\s+/g, '');
      assert(
        compactBodyText.includes(expectedCompactPayload),
        `220 chunks 流式文本未完整落盘（末尾存在但中间存在丢失或乱序）`
      );

      const postReqCount = mockServer.getRequests({ method: 'POST' }).length;
      assert(postReqCount > countBeforeSubmit, 'Mode B 必须通过本地 dev-proxy 向 MockUpstreamServer 发起真实请求');

      const longTaskStats = await page.evaluate(() => window.__embezzleE2EProbes.readLongTaskStats(true));
      assert(longTaskStats.installed === true, 'Long Task 探针必须已安装');
      assert(
        longTaskStats.supported === true || typeof longTaskStats.maxRafGapMs === 'number',
        `Long Task 与 rAF 采样均未生效，无法保证主线程无卡顿: ${JSON.stringify(longTaskStats)}`
      );
      assert(
        longTaskStats.maxDurationMs < 100,
        `检测到 >= 100ms 的主线程长阻塞 Long Task: ${JSON.stringify(longTaskStats)}`
      );
      if (typeof longTaskStats.maxRafGapMs === 'number') {
        assert(
          longTaskStats.maxRafGapMs <= 100,
          `检测到 > 100ms 的主线程 rAF 帧间隔阻塞: ${JSON.stringify(longTaskStats)}`
        );
      }
      checks.push(
        `B1: 220 chunks 高频 SSE 流式通过 dev-proxy 完整落盘 (submitVia=${submittedVia}, longTasks=${longTaskStats.count}, maxMs=${Math.round(longTaskStats.maxDurationMs)}, maxRafGapMs=${typeof longTaskStats.maxRafGapMs === 'number' ? Math.round(longTaskStats.maxRafGapMs) : 'n/a'})`
      );

      assert(diag.consoleErrors.length === 0, `Mode B1 console.error: ${diag.consoleErrors.join(' | ')}`);
      assert(diag.consoleWarnings.length === 0, `Mode B1 非白名单 console.warn: ${diag.consoleWarnings.join(' | ')}`);
      assert(diag.pageErrors.length === 0, `Mode B1 pageerror: ${diag.pageErrors.join(' | ')}`);
      assert(diag.externalUrls.length === 0, `Mode B1 出现意外外网请求: ${diag.externalUrls.join(', ')}`);
    } finally {
      await context.close();
    }
  }

  // =========================================================================
  // 子场景 B2：210 条长对话向上滚动解除吸底 + 点击回底 + 流式持续到达期间上滑不被强行拉回
  // =========================================================================
  {
    mockServer.reset();
    mockServer.on(
      { method: 'GET', pathname: '/v1/models' },
      {
        kind: 'json',
        body: {
          data: [
            { id: 'gpt-4.1', object: 'model' },
            { id: 'gpt-5', object: 'model' },
          ],
        },
      }
    );
    const slowStreamDeltas = generateHighFrequencyTextDeltas(45, '流式段');
    mockServer.on(
      { method: 'POST', pathname: '/v1/chat/completions' },
      {
        kind: 'sse',
        chunkDelayMs: 55,
        chunks: buildOpenAiChatSseChunks({
          model: 'gpt-4.1',
          textDeltas: [...slowStreamDeltas, '——流式滚动完成。'],
        }),
      }
    );
    mockServer.on(
      { method: 'POST', pathname: '/v1/responses' },
      {
        kind: 'sse',
        chunkDelayMs: 55,
        chunks: buildOpenAiResponsesSseChunks({
          model: 'gpt-5',
          textDeltas: [...slowStreamDeltas, '——流式滚动完成。'],
        }),
      }
    );

    const longMessages = [];
    for (let idx = 0; idx < 210; idx += 1) {
      longMessages.push({
        id: `long-msg-${idx}`,
        role: idx % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${idx + 1} 条长对话历史消息：用于验证虚拟化/长列表滚动不抢手势与智能吸底解除。`,
        createdAt: 1764000000000 + idx * 1000,
        status: 'ready',
      });
    }
    const seededEnvelope = JSON.stringify({
      schemaVersion: 7,
      revision: 2,
      savedAt: Date.now(),
      workspace: {
        providers: [
          {
            id: 'openai',
            name: 'OpenAI',
            kind: 'openai-compatible',
            baseUrl: 'https://api.openai.com/v1',
            authHeaderMode: 'bearer',
            imageApiMode: 'auto',
            capabilities: [
              'text',
              'image-input',
              'tool-calling',
              'reasoning',
              'web-search',
              'streaming',
            ],
            models: [
              {
                id: 'gpt-4.1',
                name: 'GPT-4.1',
                capabilities: ['text', 'image-input', 'tool-calling', 'streaming'],
                task: 'chat',
                source: 'manual',
              },
            ],
          },
        ],
        activeProviderId: 'openai',
        activeModelIdByProvider: { openai: 'gpt-4.1' },
        activeProjectId: 'project-default',
        activeConversationId: 'conv-long-s5',
        conversations: [
          {
            id: 'conv-long-s5',
            projectId: 'project-default',
            title: '210 条长对话滚动测试',
            createdAt: 1764000000000,
            updatedAt: 1764000300000,
            messages: longMessages,
          },
        ],
        onboarding: { status: 'completed', lastStep: 'provider' },
      },
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(buildDevModeInitScript(proxyPort, seededEnvelope));
    const page = await context.newPage();
    const diag = attachPageDiagnostics(page);

    try {
      await page.goto(expoBaseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await dismissOnboardingIfVisible(page);
      await page.getByText('第 210 条长对话历史消息').waitFor({ state: 'visible', timeout: 20_000 });

      // 1) 静态长对话上滑解除自动吸底，并校验“回到底部”按钮显隐与回底功能
      await page.waitForTimeout(300);
      const scrollInfo = await readMainScrollerMetrics(page);
      assert(scrollInfo !== null, '未检测到 210 条长对话的可滚动列表容器');
      await page.mouse.move(scrollInfo.cx, scrollInfo.cy);
      await page.mouse.wheel(0, -1400);
      await page.waitForTimeout(450);

      const afterWheelMetrics = await readMainScrollerMetrics(page);
      assert(
        afterWheelMetrics !== null &&
          afterWheelMetrics.scrollTop >= 0 &&
          afterWheelMetrics.scrollTop < afterWheelMetrics.maxTop - 200,
        `上滑后列表被强行吸底拉回（afterWheelTop=${afterWheelMetrics?.scrollTop}, maxTop=${afterWheelMetrics?.maxTop}）`
      );

      const scrollToBottomBtn = page.locator('[data-testid="chat-scroll-to-bottom"]');
      await scrollToBottomBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await scrollToBottomBtn.click();
      await scrollToBottomBtn.waitFor({ state: 'hidden', timeout: 5_000 });
      await page.waitForTimeout(750);

      const afterClickBottomMetrics = await readMainScrollerMetrics(page);
      assert(
        afterClickBottomMetrics !== null &&
          afterClickBottomMetrics.maxTop - afterClickBottomMetrics.scrollTop <= 80,
        `点击 chat-scroll-to-bottom 后未回到底部: ${JSON.stringify(afterClickBottomMetrics)}`
      );

      // 2) 配置测试 Key 并发起慢速 SSE 流式，验证流式持续到达期间上滑不被强行拉回
      await configureProviderKeyViaSettings(page, 'sk-web-e2e-dev-proxy', '打开 OpenAI');
      const composerInput = page.locator('[aria-label="消息输入框"]');
      await composerInput.click();
      await composerInput.fill('流式持续到达期间测试上滑不抢手势');
      const streamReqPromise = page.waitForRequest((req) => req.method() === 'POST', { timeout: 5_000 });
      await page.keyboard.press('Enter');
      const streamReq = await streamReqPromise;
      assert(streamReq !== null, 'B2 流式测试 Enter 应触发真实 POST 请求');

      await page.getByText('流式段1', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
      const streamScroller = await readMainScrollerMetrics(page);
      assert(streamScroller !== null, '流式期间未检测到主滚动容器');
      await page.mouse.move(streamScroller.cx, streamScroller.cy);
      await page.mouse.wheel(0, -1400);
      await page.waitForTimeout(200);

      const upDuringStream = await readMainScrollerMetrics(page);
      assert(
        upDuringStream !== null && upDuringStream.scrollTop < upDuringStream.maxTop - 50,
        `流式输出期间上滑未能离开底部: ${JSON.stringify(upDuringStream)}`
      );
      await scrollToBottomBtn.waitFor({ state: 'visible', timeout: 5_000 });

      // 等待约 900ms 让后续更多 SSE chunks 持续到达并渲染，确认用户视口不被吸底拉回
      await page.waitForTimeout(900);
      const afterMoreChunks = await readMainScrollerMetrics(page);
      assert(
        afterMoreChunks !== null &&
          afterMoreChunks.scrollTop < afterMoreChunks.maxTop - 50 &&
          Math.abs(afterMoreChunks.scrollTop - upDuringStream.scrollTop) <= 150,
        `流式持续到达期间上滑位置被抢手势拉回（up=${upDuringStream.scrollTop}, after=${afterMoreChunks?.scrollTop}, max=${afterMoreChunks?.maxTop}）`
      );
      assert(
        await scrollToBottomBtn.isVisible(),
        '流式持续到达期间处于历史位置时，“回到底部”按钮应保持可见'
      );

      await page.getByText('——流式滚动完成。').waitFor({ state: 'visible', timeout: 25_000 });
      const afterStreamDone = await readMainScrollerMetrics(page);
      assert(
        afterStreamDone !== null && afterStreamDone.scrollTop < afterStreamDone.maxTop - 50,
        `流式完成刷新后不应自动抢回底部（afterStreamDone=${JSON.stringify(afterStreamDone)}）`
      );

      await scrollToBottomBtn.click();
      await scrollToBottomBtn.waitFor({ state: 'hidden', timeout: 5_000 });
      await page.waitForTimeout(750);
      const finalBottomMetrics = await readMainScrollerMetrics(page);
      assert(
        finalBottomMetrics !== null &&
          finalBottomMetrics.maxTop - finalBottomMetrics.scrollTop <= 80,
        `流式完成后点击 chat-scroll-to-bottom 未回到底部: ${JSON.stringify(finalBottomMetrics)}`
      );
      checks.push('B2: 210 条长对话上滑解除吸底 + 点击回底 + 流式持续到达期间上滑不被强行拉回');

      assert(diag.consoleErrors.length === 0, `Mode B2 console.error: ${diag.consoleErrors.join(' | ')}`);
      assert(diag.consoleWarnings.length === 0, `Mode B2 非白名单 console.warn: ${diag.consoleWarnings.join(' | ')}`);
      assert(diag.pageErrors.length === 0, `Mode B2 pageerror: ${diag.pageErrors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }

  // =========================================================================
  // 子场景 B3：窄屏 (390x844) Drawer 硬性开合（按钮/Scrim 遮罩/快速连击）与窄屏菜单零遮挡
  // =========================================================================
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(buildDevModeInitScript(proxyPort));
    const page = await context.newPage();
    const diag = attachPageDiagnostics(page);

    try {
      await page.goto(expoBaseUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await dismissOnboardingIfVisible(page);

      const openDrawerBtn = page.locator('[role="button"][aria-label="打开聊天记录"]');
      const closeDrawerBtn = page.locator('[role="button"][aria-label="关闭聊天记录"]').first();
      const drawerScrim = page.locator('[role="button"][aria-label="关闭聊天记录遮罩"]').first();

      // 第 1 轮：打开后硬性校验关闭按钮可见并点击关闭
      await openDrawerBtn.click();
      await closeDrawerBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await closeDrawerBtn.click();
      await closeDrawerBtn.waitFor({ state: 'hidden', timeout: 5_000 });
      await page.waitForTimeout(300);
      await assertWorkspaceGeometryClear(page, 'Mode B3 窄屏按钮关闭 Drawer 后');

      // 第 2 轮：打开后点击 scrim 遮罩右侧露出的区域关闭，校验无残影
      await openDrawerBtn.click();
      await closeDrawerBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await drawerScrim.waitFor({ state: 'visible', timeout: 5_000 });
      await drawerScrim.click({ position: { x: 355, y: 400 } });
      await closeDrawerBtn.waitFor({ state: 'hidden', timeout: 5_000 });
      await page.waitForTimeout(300);
      await assertWorkspaceGeometryClear(page, 'Mode B3 窄屏 Scrim 关闭 Drawer 后');

      // 第 3 轮：短间隔快速开合（硬性等待关闭按钮并关闭，不允许静默跳过）
      await openDrawerBtn.click();
      await page.waitForTimeout(80);
      await closeDrawerBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await closeDrawerBtn.click();
      await closeDrawerBtn.waitFor({ state: 'hidden', timeout: 5_000 });
      await page.waitForTimeout(350);
      await assertWorkspaceGeometryClear(page, 'Mode B3 窄屏快速开合 Drawer 后');

      // 窄屏下补充校验搜索菜单视口边界及导出/斜杠菜单
      await assertComposerSearchMenuInViewport(page, { width: 390, height: 844 }, 'Mode B3 窄屏');
      await assertSlashMenuAndExportDialog(page, { width: 390, height: 844 }, 'Mode B3 窄屏');

      checks.push('B3: 窄屏 390x844 Drawer(按钮/Scrim/快切)硬性关闭零残影 + 窄屏菜单无越界');

      assert(diag.consoleErrors.length === 0, `Mode B3 console.error: ${diag.consoleErrors.join(' | ')}`);
      assert(diag.consoleWarnings.length === 0, `Mode B3 非白名单 console.warn: ${diag.consoleWarnings.join(' | ')}`);
      assert(diag.pageErrors.length === 0, `Mode B3 pageerror: ${diag.pageErrors.join(' | ')}`);
    } finally {
      await context.close();
    }
  }

  logger.log(`[Web E2E Mode B] 全部通过 (${checks.length} 项检查)`);
  return { suite: 'Mode B (dev + proxy SSE)', passed: true, checks };
}
