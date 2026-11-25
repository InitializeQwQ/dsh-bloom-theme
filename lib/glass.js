/** 玻璃材质偏好、旧值迁移与无障碍降级。 */
import { STORAGE_KEY } from './meta.js';
const KEY = `${STORAGE_KEY}-glass-mode`;
const COMPOSER_TRANSPARENCY_KEY = `${STORAGE_KEY}-composer-transparent`;
const COMPOSER_TINT_KEY = `${STORAGE_KEY}-composer-tint`;
export const COMPOSER_TINTS = [20, 40, 60, 80, 100];
/** 面板选项：毛玻璃、磨砂玻璃、液态玻璃。 */
export const GLASS_MODES = ['frosted', 'matte', 'liquid'];
let cached;
let needsMigration = false;
let composerTransparent;
let composerTint;
/** Existing profiles keep the glass input surface until the user switches it off. */
export function readComposerTransparency() {
    if (composerTransparent === undefined) {
        try {
            composerTransparent = localStorage.getItem(COMPOSER_TRANSPARENCY_KEY) !== 'false';
        }
        catch {
            composerTransparent = true;
        }
    }
    return composerTransparent;
}
export function readComposerTint() {
    if (composerTint === undefined) {
        composerTint = 60;
        try {
            const saved = Number(localStorage.getItem(COMPOSER_TINT_KEY));
            const value = saved === 30 ? 20 : saved === 50 ? 60 : saved === 70 ? 100 : saved;
            composerTint = COMPOSER_TINTS.find(level => level === value) ?? 60;
        }
        catch { }
    }
    return composerTint;
}
export function applyComposerTransparency() {
    document.body.toggleAttribute('data-bloom-composer-opaque', !readComposerTransparency());
    document.body.dataset.bloomComposerTint = String(readComposerTint());
}
export function writeComposerTint(value) {
    composerTint = value;
    try {
        localStorage.setItem(COMPOSER_TINT_KEY, String(value));
    }
    catch { }
    applyComposerTransparency();
}
export function writeComposerTransparency(transparent) {
    composerTransparent = transparent;
    try {
        localStorage.setItem(COMPOSER_TRANSPARENCY_KEY, String(transparent));
    }
    catch { }
    applyComposerTransparency();
}
function normalizeGlassMode(value) {
    switch (value) {
        case 'frosted':
        case 'matte':
        case 'liquid': return value;
        case 'glass': return 'liquid';
        case 'soft': return 'matte';
        case 'solid': return 'frosted';
        default: return 'auto';
    }
}
/** 读取并解析旧值；不在读取时写入存储。 */
export function readGlassMode() {
    if (cached !== undefined)
        return cached;
    let value = null;
    try {
        value = localStorage.getItem(KEY);
    }
    catch { }
    cached = normalizeGlassMode(value);
    needsMigration = value === 'glass' || value === 'soft' || value === 'solid';
    return cached;
}
/** 保存标准材质 ID；存储不可用时仍保留本次会话选择。 */
export function writeGlassMode(mode) {
    cached = normalizeGlassMode(mode);
    needsMigration = false;
    try {
        localStorage.setItem(KEY, cached);
    }
    catch { }
    applyGlassMode();
}
/** 显式材质写入 body；auto 留给 CSS 按媒体查询解析。 */
export function applyGlassMode() {
    const mode = readGlassMode();
    if (mode === 'auto') {
        document.body.removeAttribute('data-bloom-glass');
    }
    else {
        document.body.setAttribute('data-bloom-glass', mode);
    }
}
function matchesMedia(query) {
    try {
        return window.matchMedia(query).matches;
    }
    catch {
        return false;
    }
}
/**
 * 返回与 CSS 一致的生效材质；高对比和强制颜色优先。
 *
 * ## auto 不随深浅变（2026-11-07 修正）
 *
 * 材质是**一个与配色方案无关的用户偏好**：用户挑的是「液态玻璃」这件事，
 * 不是「浅色时液态、深色时毛玻璃」这件事。之前 auto 按 `currentIsDark()`
 * 在深色下发 frosted，等于同一个偏好跨深浅给出两种材质 —— 切一次外观
 * 手感就变了，而且深浅两套的「自动」本来也不是用户表达过的选择。
 *
 * 现在 auto 在深浅都解析成 liquid；只有系统无障碍降级（强制颜色、
 * 高对比、降低透明度）才强制 solid —— 那是系统要求，不是用户偏好。
 */
export function effectiveGlassMode() {
    if (matchesMedia('(forced-colors: active)') || matchesMedia('(prefers-contrast: more)'))
        return 'solid';
    const mode = readGlassMode();
    if (mode !== 'auto')
        return mode;
    if (systemPrefersReducedTransparency())
        return 'solid';
    return 'liquid';
}
/** 系统是否要求降低透明度。 */
export function systemPrefersReducedTransparency() {
    return matchesMedia('(prefers-reduced-transparency: reduce)');
}
/** 初始化时归一旧存档、应用材质并注册可解绑的系统偏好监听。 */
export function initGlassMode() {
    const mode = readGlassMode();
    if (needsMigration) {
        try {
            localStorage.setItem(KEY, mode);
            needsMigration = false;
        }
        catch { }
    }
    applyGlassMode();
    let mq = null;
    try {
        mq = window.matchMedia('(prefers-reduced-transparency: reduce)');
    }
    catch { }
    if (!mq)
        return () => { };
    const onChange = () => {
        if (readGlassMode() === 'auto')
            applyGlassMode();
    };
    mq.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
}
