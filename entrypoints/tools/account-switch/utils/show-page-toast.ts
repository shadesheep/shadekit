/**
 * 在指定页面内注入浮动 Toast 提示（供 background service worker 调用）
 * 通过 chrome.scripting.executeScript 向页面注入 DOM 元素实现通知效果。
 * 类名、配色、动画与 ToastContainer.vue 保持一致。
 *
 * copyText 存在时渲染「复制详情」按钮：点击复制错误码 + 上下文，
 * 注入脚本内的剪贴板写入由用户点击触发，满足浏览器的手势要求。
 */

type ToastType = 'success' | 'error' | 'info';

const TOAST_ICONS: Record<ToastType, string> = {
  success: 'i-lucide-check-circle',
  error: 'i-lucide-x-circle',
  info: 'i-lucide-info',
};

const TOAST_COLORS: Record<ToastType, { bg: string; text: string; border: string; icon: string }> = {
  success: { bg: '#f0fdf4', text: '#166534', border: '#bbf7d0', icon: '#16a34a' },
  error: { bg: '#fef2f2', text: '#991b1b', border: '#fecaca', icon: '#dc2626' },
  info: { bg: '#eff6ff', text: '#1e40af', border: '#bfdbfe', icon: '#3b82f6' },
};

const TOAST_DARK_COLORS: Record<ToastType, { bg: string; text: string; border: string; icon: string }> = {
  success: { bg: '#052e16', text: '#6ee7b7', border: '#064e3b', icon: '#4ade80' },
  error: { bg: '#450a0a', text: '#fca5a5', border: '#7f1d1d', icon: '#f87171' },
  info: { bg: '#1e3a5f', text: '#93c5fd', border: '#1e40af', icon: '#60a5fa' },
};

export async function showPageToast(
  tabId: number,
  message: string,
  type: ToastType,
  duration = 2000,
  copyText?: string,
): Promise<void> {
  const toastClass = `toast-item toast-${type}`;
  const c = TOAST_COLORS[type];
  const darkC = TOAST_DARK_COLORS[type];
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: ((
        msg: string,
        cls: string,
        bg: string, text: string, border: string, iconColor: string,
        darkBg: string, darkText: string, darkBorder: string, darkIcon: string,
        iconCls: string,
        dur: number,
        copy: string | null,
      ) => {
        // 避免重复注入
        const existing = document.getElementById('devtools-quick-login-toast');
        if (existing) existing.remove();

        // 是否处于暗色模式
        const isDark = document.documentElement.hasAttribute('data-dt-dark');
        const colors = isDark
          ? { bg: darkBg, text: darkText, border: darkBorder, icon: darkIcon }
          : { bg, text, border, icon: iconColor };

        // 注入 keyframe（若不存在）
        if (!document.getElementById('devtools-toast-keyframes')) {
          const style = document.createElement('style');
          style.id = 'devtools-toast-keyframes';
          style.textContent = `
            @keyframes toast-slide-in {
              from { opacity: 0; transform: translateX(100%); }
              to { opacity: 1; transform: translateX(0); }
            }
            @keyframes toast-slide-out {
              from { opacity: 1; transform: translateX(0); }
              to { opacity: 0; transform: translateX(100%); }
            }
          `;
          document.head.appendChild(style);
        }

        const container = document.createElement('div');
        container.id = 'devtools-quick-login-toast';
        container.className = cls;
        Object.assign(container.style, {
          position: 'fixed', top: '16px', right: '16px', zIndex: '9999',
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '10px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: '500',
          lineHeight: '1.4', background: colors.bg, color: colors.text,
          border: `1px solid ${colors.border}`,
          boxShadow: '0 4px 12px rgba(0,0,0,0.12)', fontFamily: 'system-ui, -apple-system, sans-serif',
          maxWidth: '360px', wordBreak: 'break-word',
          animation: 'toast-slide-in 0.25s ease-out',
          pointerEvents: 'auto',
        });

        // 图标（Lucide CSS class）
        const iconEl = document.createElement('div');
        iconEl.className = `toast-icon ${iconCls}`;
        iconEl.style.cssText = `width:16px;height:16px;flex-shrink:0;color:${colors.icon};font-size:16px;display:flex;align-items:center;justify-content:center;`;

        const msgEl = document.createElement('span');
        msgEl.className = 'toast-message';
        msgEl.textContent = msg;

        // 关闭按钮
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        Object.assign(closeBtn.style, {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', background: 'transparent', cursor: 'pointer',
          padding: '2px', borderRadius: '4px', color: 'inherit',
          opacity: '0.5', transition: 'opacity 0.15s ease-out',
        });
        const closeIcon = document.createElement('div');
        closeIcon.className = 'i-lucide-x w-3 h-3';
        closeBtn.appendChild(closeIcon);
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.5'; });
        closeBtn.addEventListener('click', () => {
          container.style.animation = 'toast-slide-out 0.2s ease-in forwards';
          setTimeout(() => container.remove(), 200);
        });

        container.appendChild(iconEl);
        container.appendChild(msgEl);

        // 「复制详情」按钮：仅在提供复制内容时渲染
        if (copy) {
          const copyBtn = document.createElement('button');
          copyBtn.className = 'toast-action';
          copyBtn.textContent = '复制详情';
          Object.assign(copyBtn.style, {
            flexShrink: '0', border: '1px solid currentColor', background: 'transparent',
            color: 'inherit', fontSize: '12px', fontWeight: '600',
            padding: '2px 8px', borderRadius: '9999px', cursor: 'pointer',
            opacity: '0.75', transition: 'all 0.15s ease-out',
          });
          copyBtn.addEventListener('mouseenter', () => { copyBtn.style.opacity = '1'; });
          copyBtn.addEventListener('mouseleave', () => { copyBtn.style.opacity = '0.75'; });
          copyBtn.addEventListener('click', () => {
            const done = (ok: boolean) => {
              copyBtn.textContent = ok ? '已复制' : '复制失败';
            };
            navigator.clipboard.writeText(copy).then(() => done(true)).catch(() => {
              // 回退：textarea + execCommand
              try {
                const ta = document.createElement('textarea');
                ta.value = copy;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                done(document.execCommand('copy'));
                ta.remove();
              } catch {
                done(false);
              }
            });
          });
          container.appendChild(copyBtn);
        }

        container.appendChild(closeBtn);
        document.body.appendChild(container);

        // 自动消失
        if (dur > 0) {
          setTimeout(() => {
            container.style.animation = 'toast-slide-out 0.2s ease-in forwards';
            setTimeout(() => container.remove(), 200);
          }, dur);
        }
      }) as unknown as (
        msg: string, cls: string,
        bg: string, text: string, border: string, iconColor: string,
        darkBg: string, darkText: string, darkBorder: string, darkIcon: string,
        iconCls: string, dur: number, copy: string | null,
      ) => void,
      args: [
        message, toastClass,
        c.bg, c.text, c.border, c.icon,
        darkC.bg, darkC.text, darkC.border, darkC.icon,
        TOAST_ICONS[type], duration, copyText ?? null,
      ],
    });
  } catch (e) {
    console.error('[ShadeKit] showPageToast failed:', e);
  }
}
