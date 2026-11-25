import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const { outputFiles } = await build({
  stdin: {
    contents: `import './test/slot-fixture.mjs'; import './src/client.ts';
      const services = { slots: window.fixtureSlots };
      const pending = [];
      window.__events = window.__events ?? {};
      const strictCtx = (declared = []) => new Proxy({}, {
        get(_, key) {
          if (key === 'effect') return (fn) => {
            const dispose = fn();
            if (typeof dispose === 'function') window.__disposers.push(dispose);
            return dispose;
          };
          // cordis 核心事件 API（on/off/emit）**不是** inject 出来的服务：
          // 宿主自己的 dsh-client-ui-theme 就是 ctx.on('theme/change', sync)
          // 而它的 exports.inject 里没有 'theme'。替身不给这三个 = 比宿主还严，
          // 测的是一个真实宿主里不存在的问题（2026-11-21 踩过）。
          if (key === 'on') return (event, listener) => {
            const bucket = window.__events?.[event] ?? (window.__events[event] = new Set());
            bucket.add(listener);
            return () => bucket.delete(listener);
          };
          if (key === 'off') return (event, listener) => { window.__events?.[event]?.delete(listener); return () => {} };
          if (key === 'emit') return (event, payload) => {
            for (const listener of window.__events?.[event] ?? []) listener(payload);
          };
          if (key === 'inject') return (names, cb) => {
            const run = () => cb(strictCtx([...declared, ...names]));
            if (names.every(n => services[n] !== undefined)) run();
            else pending.push({ names, run });
          };
          if (typeof key === 'symbol' || key === 'then') return undefined;
          if (!declared.includes(key)) throw new Error('cannot get property "' + String(key) + '" without inject');
          return services[key];
        }
      });
      window.applyModule = (localeService, themeService) => {
        window.__disposers = [];
        if (localeService) services.locale = localeService;
        if (themeService) {
          services.theme = themeService;
          services['theme'] = themeService;
        }
        for (let i = pending.length - 1; i >= 0; i--) {
          if (pending[i].names.every(n => services[n] !== undefined)) {
            pending.splice(i, 1)[0].run();
          }
        }
        const mod = window.__ModuleLoader__._module;
        mod.apply(strictCtx(mod.inject ?? []));
      };
      window.disposeAll = () => {
        window.disposeFixtureSlots();
        while (window.__disposers.length) {
          const d = window.__disposers.pop();
          try { d(); } catch (e) { console.error('disposer err', e); }
        }
      };
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
})

const browser = await chromium.launch({
  executablePath: process.env.BLOOM_CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
})
test.after(() => browser.close())

async function setupPage(t) {
  const context = await browser.newContext({ locale: 'zh-CN' })
  t.after(() => context.close())
  const page = await context.newPage()
  await page.route('**/*', (route) => {
    const url = route.request().url()
    if (url === 'https://bloom.test/') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<html><body style="margin:0">
<div id="scroller" style="height:100vh;overflow:auto">
<header style="position:relative;z-index:1;height:44px;overflow:hidden;contain:paint;display:flex;justify-content:center;align-items:center;margin-top:120px">
<div class="_headerUtilities"><button onclick="this.dataset.clicked='yes'">Session log</button></div></header>
<main id="transcript" style="position:relative;z-index:5;height:2000px;background:rgb(250,250,250)">
<div data-turn-process><span class="_label">深度求索中，用时 1分30秒</span></div></main>
</div><section data-fixture-settings aria-label="Settings" style="position:fixed;z-index:10;top:20px;right:12px;width:min(420px,calc(100vw - 24px));max-height:calc(100vh - 40px);overflow:auto;background:white"></section></body></html>`,
      })
    }
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto('https://bloom.test/')
  await page.evaluate(() => {
    const dicts = {}
    const listeners = new Set()
    window.mockLocale = {
      active: 'zh',
      getSnapshot() { return { active: this.active } },
      register(ns, dict) { dicts[ns] = dict; return () => delete dicts[ns] },
      bind(ns) { return (key) => dicts[ns]?.[this.active]?.[key] ?? key },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    }
    window.mockTheme = {
      preference: 'dark',
      getTheme: () => ({ preference: 'dark', active: { colorScheme: 'dark' } }),
      setTheme: (val) => {},
    }
  })
  await page.addScriptTag({ content: outputFiles[0].text })
  return page
}

test('loading script alone does not mount styles or switcher before apply', async (t) => {
  const page = await setupPage(t)
  const stylesCount = await page.evaluate(() => document.querySelectorAll('style[data-plugin="dsh-bloom-theme"]').length)
  const switcherCount = await page.evaluate(() => document.querySelectorAll('.dsh-bloom-switcher').length)
  assert.equal(stylesCount, 0, 'no styles injected at top level')
  assert.equal(switcherCount, 0, 'no switcher injected at top level')
})

test('apply mounts DOM elements and styles, teardown cleanly removes them all', async (t) => {
  const page = await setupPage(t)
  await page.evaluate(() => window.applyModule(window.mockLocale, window.mockTheme))

  assert.equal(await page.locator('.dsh-bloom-switcher').count(), 0)
  await mountSettings(page)
  const appliedStyles = await page.evaluate(() => document.querySelectorAll('style[data-plugin="dsh-bloom-theme"]').length)
  const appliedSwitcher = await page.evaluate(() => document.querySelectorAll('.dsh-bloom-switcher').length)
  const appliedBodyVariant = await page.evaluate(() => document.body.dataset.bloomVariant)
  assert.equal(appliedStyles, 5, 'all 5 css styles injected')
  assert.equal(appliedSwitcher, 1, 'switcher mounted')
  assert.ok(appliedBodyVariant, 'body has bloom variant')

  // Now dispose all effect disposers
  await page.evaluate(() => window.disposeAll())

  const postStyles = await page.evaluate(() => document.querySelectorAll('style[data-plugin="dsh-bloom-theme"]').length)
  const postSwitcher = await page.evaluate(() => document.querySelectorAll('.dsh-bloom-switcher').length)
  const postBodyVariant = await page.evaluate(() => document.body.dataset.bloomVariant)
  const postSparkles = await page.evaluate(() => document.getElementById('dsh-bloom-sparkles'))

  assert.equal(postStyles, 0, 'styles removed on teardown')
  assert.equal(postSwitcher, 0, 'switcher removed on teardown')
  assert.equal(postBodyVariant, undefined, 'body variant attribute removed')
  assert.equal(postSparkles, null, 'sparkles removed on teardown')
})

const mountSettings = page => page.evaluate(() => window.remountFixtureSlot('settings.section'))

test('Bloom renders its appearance controls only in the settings slot', async t => {
  const page = await setupPage(t)
  await page.evaluate(() => window.applyModule(window.mockLocale, window.mockTheme))
  assert.deepEqual(await page.evaluate(() => window.slotRegistrations.map(r => r.name).sort()),
    ['settings.section', 'settings.section.icon', 'shell.overlay'])
  assert.deepEqual(await page.evaluate(() => window.slotViolations), [])
  assert.equal(await page.locator('.dsh-bloom-switcher').count(), 0)
  const sessionLog = page.getByRole('button', { name: 'Session log' })
  await sessionLog.click()
  assert.equal(await sessionLog.getAttribute('data-clicked'), 'yes')

  await mountSettings(page)
  const settings = page.locator('[data-fixture-slot="settings.section"]')
  await settings.getByRole('listbox').waitFor()
  assert.equal(await page.locator('header .dsh-bloom-switcher, .dsh-bloom-trigger').count(), 0)
  assert.equal(await page.locator('[data-fixture-slot="shell.overlay"] .dsh-bloom-switcher').count(), 0)
  assert.equal(await page.locator('[data-fixture-slot="shell.overlay"] #dsh-bloom-sparkles').count(), 1)
  const iconWidth = await settings.locator('.dsh-bloom-row__icon').first().evaluate(icon => icon.getBoundingClientRect().width)
  assert.ok(iconWidth > 0 && iconWidth <= 24)
  await page.evaluate(() => window.unmountFixtureSlot('shell.overlay'))
  assert.equal(await settings.getByRole('listbox').isVisible(), true, 'controls can operate without the overlay')
  await page.evaluate(() => window.unmountFixtureSlot('settings.section'))
  assert.equal(await page.locator('.dsh-bloom-switcher').count(), 0)
  await mountSettings(page)
  assert.equal(await settings.getByRole('listbox').count(), 1)
  await page.evaluate(() => window.disposeAll())
  assert.equal(await page.locator('[data-fixture-slot]').count(), 0)
})

test('settings selector fits a narrow scrollable window, and supports keyboard selection and share', async t => {
  const page = await setupPage(t)
  await page.setViewportSize({ width: 360, height: 420 })
  await page.evaluate(() => window.applyModule(window.mockLocale))
  await mountSettings(page)
  const settings = page.locator('[data-fixture-settings]')
  const listbox = settings.getByRole('listbox')
  const menu = settings.locator('.dsh-bloom-menu')
  const boxes = await Promise.all([settings.boundingBox(), menu.boundingBox()])
  assert.ok(boxes[1].x >= boxes[0].x && boxes[1].x + boxes[1].width <= boxes[0].x + boxes[0].width)
  const active = listbox.locator('[aria-selected="true"]')
  const colorCard = listbox.getByRole('option').first()
  assert.ok(await colorCard.locator('.dsh-bloom-option__dot').isVisible())
  assert.ok(await colorCard.locator('.dsh-bloom-option__name').textContent())
  assert.ok(await colorCard.locator('.dsh-bloom-option__poem').textContent())
  const modeGroup = settings.locator('.dsh-bloom-mode').getByRole('group')
  assert.equal(await menu.locator('[data-mode]').count(), 0)
  assert.ok((await modeGroup.boundingBox()).y < (await listbox.boundingBox()).y)
  assert.deepEqual(await modeGroup.getByRole('button').locator('span').allTextContents(), ['浅色', '深色', '跟随系统'])
  const initial = await active.getAttribute('data-variant')
  await active.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.locator('.dsh-bloom-option:focus').getAttribute('tabindex'), '0')
  const next = await page.locator('.dsh-bloom-option:focus').getAttribute('data-variant')
  assert.notEqual(next, initial)
  await page.keyboard.press('Enter')
  await page.waitForFunction(v => document.body.dataset.bloomVariant === v, next)
  assert.equal(await active.getAttribute('data-variant'), next)
  assert.equal(await listbox.isVisible(), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await modeGroup.locator('[data-mode="system"]:focus').count(), 1)
  const light = modeGroup.locator('[data-mode="light"]')
  const dark = modeGroup.locator('[data-mode="dark"]')
  const system = modeGroup.locator('[data-mode="system"]')
  await light.press('Space')
  assert.equal(await light.getAttribute('aria-pressed'), 'true')
  await dark.click()
  assert.equal(await dark.getAttribute('aria-pressed'), 'true')
  await system.click()
  assert.equal(await system.getAttribute('aria-pressed'), 'true')
  assert.equal(await active.getAttribute('data-variant'), next, 'changing the display mode keeps the palette')

  await menu.locator('.dsh-bloom-share').click()
  const share = menu.locator('.dsh-bloom-share-panel')
  assert.equal(await share.isVisible(), true)
  await share.locator('.dsh-bloom-share-install').focus()
  await page.keyboard.press('Escape')
  assert.equal(await share.isHidden(), true)
  assert.equal(await menu.locator('.dsh-bloom-share:focus').count(), 1)
})

test('saved rotation starts with the theme even when settings have not opened', async t => {
  const page = await setupPage(t)
  await page.clock.install()
  await page.evaluate(() => {
    localStorage.setItem('dsh-bloom-variant-rotation-minutes', '5')
    document.startViewTransition = callback => { callback(); return { finished: Promise.resolve() } }
    window.applyModule(window.mockLocale)
  })
  assert.equal(await page.locator('.dsh-bloom-switcher').count(), 0)
  const original = await page.locator('body').getAttribute('data-bloom-variant')
  await page.clock.fastForward(5 * 60_000 + 5)
  await page.waitForFunction(v => document.body.dataset.bloomVariant !== v, original)
  await mountSettings(page)
  const selected = await page.locator('.dsh-bloom-option[aria-selected="true"]').getAttribute('data-variant')
  assert.equal(selected, await page.locator('body').getAttribute('data-bloom-variant'))
})

test('input transparency changes only the composer and survives reload and teardown', async t => {
  const page = await setupPage(t)
  const apply = () => page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', `<div class="fixture_root" data-phase="active">
      <div class="fixture_composerSeat" data-composer-seat style="will-change:transform">
        <div class="fixture_composer"><div class="fixture_card"><textarea></textarea></div><div data-composer-dock>Context usage</div></div>
      </div>
    </div>`)
    document.querySelector('header').classList.add('fixture_header')
    window.applyModule(window.mockLocale)
  })
  const surface = () => page.evaluate(() => {
    const composer = document.querySelector('.fixture_composer .fixture_card')
    const layer = getComputedStyle(composer, '::before')
    const header = getComputedStyle(document.querySelector('.fixture_header'), '::before')
    const seat = document.querySelector('[data-composer-seat]')
    const dock = getComputedStyle(document.querySelector('[data-composer-dock]'))
    const paint = document.createElement('span')
    paint.style.backgroundColor = 'var(--dsw-alias-bg-layer-1, #fff)'
    composer.append(paint)
    const solid = getComputedStyle(paint).backgroundColor
    paint.remove()
    return { filter: layer.backdropFilter, image: layer.backgroundImage, color: layer.backgroundColor, solid,
      dock: { background: dock.backgroundColor, seatOverlay: getComputedStyle(seat, '::before').content,
        seatBackground: getComputedStyle(seat).backgroundImage, willChange: getComputedStyle(seat).willChange },
      header: { filter: header.backdropFilter, color: header.backgroundColor } }
  })
  await apply()
  await mountSettings(page)
  const toggle = page.getByRole('switch', { name: '输入框透明' })
  assert.equal(await toggle.getAttribute('aria-checked'), 'true')
  const materialImages = new Set()
  for (const material of ['frosted', 'matte', 'liquid']) {
    await page.locator(`[data-glass="${material}"]`).click()
    const before = await surface()
    assert.notEqual(before.filter, 'none')
    assert.deepEqual(before.dock, { background: 'rgba(0, 0, 0, 0)', seatOverlay: 'none', seatBackground: 'none', willChange: 'transform' })
    await toggle.press('Space')
    const opaque = await surface()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    assert.equal(opaque.filter, 'none')
    assert.notEqual(opaque.image, 'none')
    materialImages.add(opaque.image)
    assert.deepEqual(opaque.dock, before.dock)
    assert.equal(opaque.color, opaque.solid)
    assert.deepEqual(opaque.header, before.header)
    assert.equal(await page.locator(`[data-glass="${material}"]`).getAttribute('aria-checked'), 'true')
    await toggle.click()
    assert.deepEqual(await surface(), before)
  }
  assert.equal(materialImages.size, 3, 'each material keeps a distinct opaque surface')
  await toggle.click()
  await page.reload()
  await page.addScriptTag({ content: outputFiles[0].text })
  await apply()
  assert.equal((await surface()).filter, 'none', 'stored preference is applied before settings open')
  await mountSettings(page)
  assert.equal(await page.locator('[data-composer-transparency]').getAttribute('aria-checked'), 'false')
  await page.evaluate(() => window.disposeAll())
  assert.equal(await page.locator('body').getAttribute('data-bloom-composer-opaque'), null)
})

test('re-enabling after teardown restores styles, switcher and listeners correctly', async (t) => {
  const page = await setupPage(t)
  await page.evaluate(() => window.applyModule(window.mockLocale, window.mockTheme))
  await page.evaluate(() => window.disposeAll())

  // Re-enable
  await page.evaluate(() => window.applyModule(window.mockLocale, window.mockTheme))

  await mountSettings(page)
  const reStyles = await page.evaluate(() => document.querySelectorAll('style[data-plugin="dsh-bloom-theme"]').length)
  const reSwitcher = await page.evaluate(() => document.querySelectorAll('.dsh-bloom-switcher').length)
  const reBodyVariant = await page.evaluate(() => document.body.dataset.bloomVariant)
  assert.equal(reStyles, 5, 'all 5 css styles re-injected on re-enable')
  assert.equal(reSwitcher, 1, 'switcher re-mounted on re-enable')
  assert.ok(reBodyVariant, 'body has bloom variant on re-enable')

  // Final teardown
  await page.evaluate(() => window.disposeAll())
  const finalStyles = await page.evaluate(() => document.querySelectorAll('style[data-plugin="dsh-bloom-theme"]').length)
  assert.equal(finalStyles, 0, 'clean after second teardown')
})

test('teardown cancels and prevents timers or observers from executing or leaking', async (t) => {
  const page = await setupPage(t)
  await page.evaluate(() => window.applyModule(window.mockLocale, window.mockTheme))

  // Observers should exist
  assert.equal(await page.evaluate(() => !!window.__dshBloomThinkObserver__), true, 'think observer running')

  // Now dispose
  await page.evaluate(() => window.disposeAll())

  // Observers disconnected and cleared
  assert.equal(await page.evaluate(() => window.__dshBloomThinkObserver__), undefined, 'think observer undefined')
  assert.equal(await page.evaluate(() => window.__dshBloomObserver__), undefined, 'bloom observer undefined')
  assert.equal(await page.evaluate(() => window.__dshBloomGlassOff__), undefined, 'glass off undefined')

  // Verify DOM mutations don't trigger marks after disposal
  await page.evaluate(() => {
    const div = document.createElement('div')
    div.innerHTML = '<think>some reasoning</think>'
    document.body.appendChild(div)
  })
  // Give throttled scheduler a moment
  await page.waitForTimeout(400)
  const thinkMarked = await page.evaluate(() => document.querySelectorAll('[data-bloom-think]').length)
  assert.equal(thinkMarked, 0, 'no think tags marked after disposal')
})

test('material and per-scheme backgrounds remain independent through UI changes and reload', async t => {
  const page = await setupPage(t)
  await page.evaluate(() => window.applyModule(window.mockLocale))
  await mountSettings(page)
  const modes = page.locator('.dsh-bloom-mode')
  const state = () => page.evaluate(() => ({
    dark: document.body.hasAttribute('data-ds-dark-theme'),
    material: document.body.dataset.bloomGlass,
    light: document.body.dataset.bloomAmbienceLight,
    darkBackground: document.body.dataset.bloomAmbienceDark,
  }))
  // 质感三选一：2026-11-21 设置页改版后文字进了 aria-label，按标签断言。
  assert.deepEqual(await page.locator('.dsh-bloom-detail [data-glass]').evaluateAll(
    els => els.map(el => el.getAttribute('aria-label'))), ['毛玻璃', '磨砂玻璃', '液态玻璃'])
  await modes.locator('[data-mode="light"]').click()
  await page.locator('.dsh-bloom-detail [data-glass="matte"]').click()
  await page.locator('.dsh-bloom-detail [data-scheme="light"] [data-preset="wash"]').click()
  assert.deepEqual(await state(), { dark: false, material: 'matte', light: 'wash', darkBackground: 'corner' })
  await modes.locator('[data-mode="dark"]').click()
  await page.locator('.dsh-bloom-detail [data-scheme="dark"] [data-preset="galaxy"]').click()
  assert.deepEqual(await state(), { dark: true, material: 'matte', light: 'wash', darkBackground: 'galaxy' })
  await modes.locator('[data-mode="light"]').click()
  assert.deepEqual(await state(), { dark: false, material: 'matte', light: 'wash', darkBackground: 'galaxy' })
  await page.locator('.dsh-bloom-detail [data-glass="liquid"]').click()
  await modes.locator('[data-mode="dark"]').click()
  assert.deepEqual(await state(), { dark: true, material: 'liquid', light: 'wash', darkBackground: 'galaxy' })
  await page.reload()
  await page.addScriptTag({ content: outputFiles[0].text })
  await page.evaluate(() => window.applyModule())
  assert.deepEqual(await state(), { dark: true, material: 'liquid', light: 'wash', darkBackground: 'galaxy' })
  await mountSettings(page)
  await modes.locator('[data-mode="light"]').click()
  assert.deepEqual(await state(), { dark: false, material: 'liquid', light: 'wash', darkBackground: 'galaxy' })
})
