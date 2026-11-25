/** 「Bloom 外观」设置页的 settings.section 和 settings.section.icon 槽位。 */
import { buildDetailRowsHTML, bindDetailEvents } from './detail.js'
import { mountSwitcher } from './switcher.js'
import { LANG_CHANGE_EVENT, tr } from './lang.js'
import { bloomIconSVG } from './bloom-icon.js'
import type { HostReact } from './ui.js'

/** 设置节 id —— settings.section 与 settings.section.icon 共用它。 */
export const BLOOM_SECTION_ID = 'dsh-bloom-theme.appearance'

interface SlotsLike {
  inject: (name: string, fn: () => unknown) => unknown
  register: (options: unknown, component: unknown) => unknown
}

/**
 * 注册设置节 —— DSH 设置对话框左导航新增「Bloom 外观」页（order 50，排在 Agent 预设之后）。
 *
 * 契约（见 dsh-client-ui-settings/lib/types/client/contract/slots.d.ts）：
 *   settings.section: { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
 *   owner: { close: () => void } —— 关闭设置面板（shell 管理 open 状态）。
 *
 * ⚠️ label 必须是零 ctx 依赖的惰性函数。shell 渲染导航时才调用它；闭包里读
 *    ctx.locale 会因本模块 exports.inject = ['slots']（locale 是可选依赖）而
 *    直接抛 "cannot get property 'locale' without inject" —— 2026-10-30 同款
 *    陷阱，可选链和 try/catch 都救不了（抛在取值那一步），整条菜单项直接消失。
 *    用插件自己的 tr()：bindLocaleToHost 已把它接到 DSH 语言上，每次调用现取
 *    文案，换语言后 shell 重渲拿到的就是新词。
 */
export function registerBloomSettings(
  ctx: { slots: SlotsLike },
  ns: string,
  React: HostReact,
): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: BLOOM_SECTION_ID,
    order: 50,
    // 导航文字要短：owner 2026-11-21「英文字母为什么搞那么长？短一点、能看出是插件就行」。
    // 「Bloom」既是插件名，两端用户都认得，也不会在窄导航里被截成省略号。
    label: () => tr('Bloom'),
    locale: ns,
  }, createBloomSettings(React)))

  // 侧栏图标：注册 id 必须等于 section id，否则永不渲染。
  // 用 Bloom 自己的五瓣花（与 icon.svg 同形）——十二套配色都不同，图形比任何字形缩写都更像这个插件。
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: BLOOM_SECTION_ID,
    order: 50,
    label: () => tr('Bloom'),
    locale: ns,
  }, createBloomIcon(React)))
}

/** 侧栏图标：Bloom 五瓣花。React 由宿主 loader 提供，跟 createBloomSettings 同源传入。 */
export function createBloomIcon(React: HostReact) {
  return function BloomIcon({ size = 16 }: { size?: number }) {
    return React.createElement('span', {
      className: 'dsh-bloom-settings-icon',
      style: { width: `${size}px`, height: `${size}px` },
      'aria-hidden': 'true',
      dangerouslySetInnerHTML: { __html: bloomIconSVG() },
    })
  }
}

/**
 * 生成设置节组件。
 *
 * 语言是 DSH 的偏好（locale.preference）：换语言时面板要跟着重画 ——
 * 否则会出现「DSH 是中文、设置页还是英文」的割裂。监听挂在 window 上，
 * 重建后委托事件仍然挂在容器上，无需重绑。
 */
export function createBloomSettings(React: HostReact) {
  return function BloomAppearance() {
    const chooserRef = React.useRef<HTMLDivElement | null>(null)
    const detailRef = React.useRef<HTMLDivElement | null>(null)
    React.useEffect(() => {
      const chooser = chooserRef.current
      const el = detailRef.current
      if (!chooser || !el) return
      const unmountSwitcher = mountSwitcher(chooser)
      const onLanguageChange = () => { el.innerHTML = buildDetailRowsHTML() }
      onLanguageChange()
      const unbind = bindDetailEvents(el)
      window.addEventListener(LANG_CHANGE_EVENT, onLanguageChange)
      return () => {
        window.removeEventListener(LANG_CHANGE_EVENT, onLanguageChange)
        unbind()
        unmountSwitcher()
      }
    }, [])
    return React.createElement('div', {
      className: 'dsh-bloom-settings',
      children: [
        React.createElement('div', { key: 'appearance', ref: chooserRef }),
        React.createElement('div', { key: 'details', ref: detailRef, className: 'dsh-bloom-detail' }),
      ],
    })
  }
}
