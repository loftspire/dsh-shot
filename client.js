/**
 * dsh-shot — browser half.
 *
 * Click the button next to the composer: the host screenshots the desktop, the
 * page freezes that frame and lets you drag a region out of it. Afterwards the
 * frame drops into the composer as a normal image attachment, by synthesising
 * the paste the composer's own file intake already listens for.
 *
 * The overlay follows Doubao's screenshot picker: mode pill on top, dashed
 * selection with eight handles, a size badge, and a 复制 / 取消 / 确认 bar. On
 * top of that it adds the annotation tools Doubao leaves out.
 */

window.__ModuleLoader__.load({
  id: 'dsh-shot',
  factory(require) {
    const React = require('react')

    const CAPTURE_ROUTE = '/dsh-screenshot/capture'
    const WINDOW_ROUTE = '/dsh-screenshot/window'
    const LOG_ROUTE = '/dsh-screenshot/log'
    const AUTOTEST_ROUTE = '/dsh-screenshot/autotest'
    const HIDE_PREF_KEY = 'dsh-screenshot:hide-window'
    const OVERLAY_Z = 2147483000
    const MIN_SELECTION = 8
    const MARK = '#f43f5e'
    const MARK_WIDTH = 3
    const INK = '#0f172a'
    const ATTACH_TIMEOUT_MS = 300000
    const ATTACH_RETRY_MS = 700

    const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif'

    /* ---------------------------------------------------------------- dom */

    function h(tag, css, props) {
      const node = document.createElement(tag)
      if (css !== undefined) Object.assign(node.style, css)
      if (props !== undefined) Object.assign(node, props)
      return node
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function nextFrame() {
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }

    function svg(markup, size) {
      const node = h('span', {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${size ?? 16}px`,
        height: `${size ?? 16}px`,
      })
      node.innerHTML = markup
      return node
    }

    // The overlay is plain DOM, but the slot occupant is a React component: a
    // DOM node in its children tree throws "Objects are not valid as a React
    // child" and the button silently disappears. Icons in React land need this
    // markup form instead of svg().
    function reactSvg(markup, size) {
      return React.createElement('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: `${size ?? 16}px`,
          height: `${size ?? 16}px`,
        },
        dangerouslySetInnerHTML: { __html: markup },
      })
    }

    const ICONS = {
      scissors:
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>',
      copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>',
      close:
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
      check:
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.2 5.2L20 6.5"/></svg>',
      rect: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/></svg>',
      ellipse:
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><ellipse cx="12" cy="12" rx="8.5" ry="6.5"/></svg>',
      arrow:
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 20 4M20 4h-6.5M20 4v6.5"/></svg>',
      pen: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4.5-1.2L20 7.3a2 2 0 0 0-2.8-2.8L5.7 16 4 20z"/></svg>',
      text: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/></svg>',
      mosaic:
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9.5h17M3.5 15h17M9.5 3.5v17M15 3.5v17"/></svg>',
      undo: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8H4v-4"/><path d="M4.5 8.5A8 8 0 1 1 4 14"/></svg>',
      camera:
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2a2 2 0 0 0 1.7-.95l.5-.8A1.5 1.5 0 0 1 10.2 3h3.6a1.5 1.5 0 0 1 1.3.75l.5.8A2 2 0 0 0 17.3 6h1.2A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="12" cy="12.2" r="3.4"/></svg>',
    }

    const BUTTON_CSS = `
[data-dsh-screenshot-button] { color: inherit; }
[data-dsh-screenshot-button]:hover:not(:disabled) { background: rgba(127, 127, 127, 0.14); }
[data-dsh-screenshot-button]:disabled { opacity: 0.55; }
[data-dsh-screenshot-button][data-busy="1"] svg { animation: dshss-spin 1.1s linear infinite; }
@keyframes dshss-spin { to { transform: rotate(360deg); } }
[data-dsh-screenshot-tool]:hover { background: rgba(15, 23, 42, 0.07); }
[data-dsh-screenshot-tool][data-active="1"] { background: rgba(37, 99, 235, 0.12); color: #2563eb; }
[data-dsh-screenshot-action]:hover { background: rgba(15, 23, 42, 0.06); }
`

    function installStyles() {
      if (document.querySelector('style[data-dsh-screenshot-style]') !== null) return
      const sheet = document.createElement('style')
      sheet.dataset.dshScreenshotStyle = ''
      sheet.textContent = BUTTON_CSS
      document.head.append(sheet)
    }

    /* -------------------------------------------------------------- toast */

    let toastNode = null

    function toast(message) {
      if (typeof message !== 'string' || message.length === 0) return
      if (toastNode !== null) toastNode.remove()
      const node = h(
        'div',
        {
          position: 'fixed',
          left: '50%',
          bottom: '96px',
          transform: 'translateX(-50%)',
          zIndex: String(OVERLAY_Z),
          maxWidth: '70vw',
          padding: '9px 14px',
          borderRadius: '10px',
          background: 'rgba(15, 23, 42, 0.9)',
          color: '#f8fafc',
          fontFamily: FONT,
          fontSize: '12.5px',
          lineHeight: '1.5',
          boxShadow: '0 10px 30px rgba(0, 0, 0, 0.28)',
          pointerEvents: 'none',
        },
        { textContent: message },
      )
      document.body.append(node)
      toastNode = node
      setTimeout(() => {
        node.remove()
        if (toastNode === node) toastNode = null
      }, 3200)
    }

    /* --------------------------------------------------------- diagnostics */

    // Best-effort breadcrumb to the host log: the page cannot write files, and
    // the composer's intake is silent when it refuses, so this is how a refusal
    // becomes something readable instead of a guess. A plain GET with query
    // parameters mirrors the shape of the capture request, which the page is
    // already known to deliver.
    function report(label, detail) {
      try {
        const query = new URLSearchParams({
          label,
          detail: detail === undefined || detail === null ? '' : JSON.stringify(detail).slice(0, 3500),
        })
        void fetch(`${LOG_ROUTE}?${query.toString()}`, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        }).catch(() => {})
      } catch {
        /* diagnostics never break the feature */
      }
    }

    /* ------------------------------------------------------------ capture */

    async function captureDesktop(hideWindow) {
      const response = await fetch(`${CAPTURE_ROUTE}?hideWindow=${hideWindow ? '1' : '0'}`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'image/png' },
      })

      if (!response.ok) {
        let detail = `截屏失败（HTTP ${response.status}）`
        try {
          const body = await response.json()
          if (typeof body?.message === 'string') detail = body.message
        } catch {
          /* keep the status line */
        }
        throw new Error(detail)
      }

      const blob = await response.blob()
      const bitmap = await createImageBitmap(blob)
      return {
        bitmap,
        screenWidth: Number(response.headers.get('x-dsh-screen-width') ?? bitmap.width),
        screenHeight: Number(response.headers.get('x-dsh-screen-height') ?? bitmap.height),
        elapsedMs: Number(response.headers.get('x-dsh-capture-ms') ?? 0),
      }
    }

    async function releaseWindow() {
      try {
        await fetch(`${WINDOW_ROUTE}?action=restore`, { credentials: 'include', cache: 'no-store' })
      } catch {
        /* the window stays where it is; not worth bothering the user */
      }
    }

    /* ------------------------------------------------------------- editor */

    function openEditor(shot) {
      return new Promise((resolve) => {
        const bitmap = shot.bitmap
        const dpr = Math.max(1, window.devicePixelRatio || 1)
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight

        // Fit the frozen desktop inside the window without ever magnifying it
        // past one device pixel per image pixel: that is what keeps the
        // preview sharp at 150% scaling, where a 1 CSS px maps to 1.5 device px.
        const fit = Math.min(viewportWidth / bitmap.width, viewportHeight / bitmap.height, 1 / dpr)
        const shown = {
          width: Math.round(bitmap.width * fit),
          height: Math.round(bitmap.height * fit),
          left: Math.round((viewportWidth - bitmap.width * fit) / 2),
          top: Math.round((viewportHeight - bitmap.height * fit) / 2),
        }
        const ratio = 1 / fit

        const state = {
          rect: { x: 0, y: 0, width: 0, height: 0 },
          ready: false,
          tool: null,
          annotations: [],
          undone: [],
          draft: null,
        }

        const root = h('div', {
          position: 'fixed',
          inset: '0',
          zIndex: String(OVERLAY_Z),
          fontFamily: FONT,
          cursor: 'crosshair',
          userSelect: 'none',
          overflow: 'hidden',
        })
        root.dataset.dshScreenshot = 'overlay'

        const frame = h('canvas', {
          position: 'absolute',
          left: `${shown.left}px`,
          top: `${shown.top}px`,
          width: `${shown.width}px`,
          height: `${shown.height}px`,
          display: 'block',
        })
        frame.width = Math.round(shown.width * dpr)
        frame.height = Math.round(shown.height * dpr)
        const frameContext = frame.getContext('2d')
        frameContext.imageSmoothingEnabled = true
        frameContext.imageSmoothingQuality = 'high'
        frameContext.drawImage(bitmap, 0, 0, frame.width, frame.height)
        root.append(frame)

        // Base dimmer, only while nothing is selected yet: once a selection
        // exists the selection box's own shadow does the dimming, and stacking
        // both would double-darken the surround.
        const shade = h('div', {
          position: 'absolute',
          inset: '0',
          background: 'rgba(6, 10, 18, 0.5)',
          display: 'block',
        })
        root.append(shade)

        const selection = h('div', {
          position: 'absolute',
          left: '0px',
          top: '0px',
          width: '0px',
          height: '0px',
          border: '1px dashed rgba(255, 255, 255, 0.92)',
          boxShadow: '0 0 0 100vmax rgba(6, 10, 18, 0.5)',
          boxSizing: 'border-box',
          display: 'none',
        })
        root.append(selection)

        const annot = h('canvas', {
          position: 'absolute',
          left: '0px',
          top: '0px',
          width: '0px',
          height: '0px',
          pointerEvents: 'none',
          display: 'none',
        })
        root.append(annot)

        const badge = h(
          'div',
          {
            position: 'absolute',
            padding: '4px 9px',
            borderRadius: '8px',
            background: 'rgba(255, 255, 255, 0.96)',
            color: INK,
            fontFamily: FONT,
            fontSize: '12px',
            fontWeight: '600',
            fontVariantNumeric: 'tabular-nums',
            boxShadow: '0 6px 18px rgba(0, 0, 0, 0.22)',
            whiteSpace: 'nowrap',
            display: 'none',
          },
          { textContent: '' },
        )
        root.append(badge)

        const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
        const handleNodes = new Map()
        const CURSORS = {
          nw: 'nwse-resize',
          n: 'ns-resize',
          ne: 'nesw-resize',
          e: 'ew-resize',
          se: 'nwse-resize',
          s: 'ns-resize',
          sw: 'nesw-resize',
          w: 'ew-resize',
        }
        for (const name of HANDLES) {
          const dot = h('div', {
            position: 'absolute',
            width: '9px',
            height: '9px',
            marginLeft: '-5px',
            marginTop: '-5px',
            borderRadius: '50%',
            background: '#ffffff',
            boxShadow: '0 0 0 1px rgba(15, 23, 42, 0.35), 0 1px 4px rgba(0, 0, 0, 0.3)',
            cursor: CURSORS[name],
            display: 'none',
          })
          dot.dataset.handle = name
          selection.append(dot)
          handleNodes.set(name, dot)
        }

        // --- top pill (Doubao's "截图提问" mode strip) ---
        const topPill = h('div', {
          position: 'absolute',
          left: '50%',
          top: '18px',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '6px 14px',
          borderRadius: '999px',
          background: 'rgba(255, 255, 255, 0.97)',
          color: INK,
          fontSize: '13px',
          fontWeight: '600',
          boxShadow: '0 8px 26px rgba(0, 0, 0, 0.24)',
          whiteSpace: 'nowrap',
        })
        const pillTab = h(
          'div',
          {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            borderRadius: '999px',
            background: 'rgba(15, 23, 42, 0.06)',
          },
          {},
        )
        pillTab.append(svg(ICONS.scissors, 15))
        pillTab.append(h('span', {}, { textContent: '截图提问' }))
        topPill.append(pillTab)
        topPill.append(
          h(
            'span',
            { color: 'rgba(15, 23, 42, 0.45)', fontSize: '12px', fontWeight: '400' },
            { textContent: '拖拽框选 · Esc 取消' },
          ),
        )
        root.append(topPill)

        // --- top-right escape hint ---
        const cancelCluster = h('div', {
          position: 'absolute',
          right: '18px',
          top: '18px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        })
        const escKey = h(
          'div',
          {
            padding: '5px 9px',
            borderRadius: '7px',
            background: 'rgba(15, 23, 42, 0.72)',
            color: '#f8fafc',
            fontSize: '11.5px',
            fontWeight: '600',
            letterSpacing: '0.06em',
            boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.28)',
          },
          { textContent: 'ESC' },
        )
        const cancelTop = h(
          'button',
          {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 14px',
            border: 'none',
            borderRadius: '8px',
            background: '#2563eb',
            color: '#ffffff',
            fontFamily: FONT,
            fontSize: '12.5px',
            fontWeight: '600',
            cursor: 'pointer',
            boxShadow: '0 6px 16px rgba(37, 99, 235, 0.36)',
          },
          { textContent: '取消' },
        )
        cancelTop.type = 'button'
        cancelTop.addEventListener('click', (event) => {
          event.stopPropagation()
          finish('cancel')
        })
        cancelCluster.append(escKey, cancelTop)
        root.append(cancelCluster)

        // --- tool strip (our extra, Doubao has none) ---
        const TOOLS = [
          { id: 'rect', label: '矩形', key: 'R', icon: ICONS.rect },
          { id: 'ellipse', label: '椭圆', key: 'O', icon: ICONS.ellipse },
          { id: 'arrow', label: '箭头', key: 'A', icon: ICONS.arrow },
          { id: 'pen', label: '画笔', key: 'P', icon: ICONS.pen },
          { id: 'text', label: '文字', key: 'T', icon: ICONS.text },
          { id: 'mosaic', label: '马赛克', key: 'M', icon: ICONS.mosaic },
        ]

        const toolBar = h('div', {
          position: 'absolute',
          display: 'none',
          alignItems: 'center',
          gap: '2px',
          padding: '4px',
          borderRadius: '10px',
          background: 'rgba(255, 255, 255, 0.97)',
          boxShadow: '0 10px 26px rgba(0, 0, 0, 0.24)',
        })
        const toolNodes = new Map()
        for (const tool of TOOLS) {
          const button = h(
            'button',
            {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '30px',
              height: '28px',
              border: 'none',
              borderRadius: '7px',
              background: 'transparent',
              color: 'rgba(15, 23, 42, 0.82)',
              cursor: 'pointer',
              padding: '0',
            },
            { title: `${tool.label}（${tool.key}）` },
          )
          button.type = 'button'
          button.dataset.dshScreenshotTool = tool.id
          button.append(svg(tool.icon, 15))
          button.addEventListener('click', (event) => {
            event.stopPropagation()
            setTool(state.tool === tool.id ? null : tool.id)
          })
          toolBar.append(button)
          toolNodes.set(tool.id, button)
        }
        const toolDivider = h('div', { width: '1px', height: '18px', background: 'rgba(15, 23, 42, 0.12)', margin: '0 4px' })
        toolBar.append(toolDivider)
        const undoButton = h(
          'button',
          {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '30px',
            height: '28px',
            border: 'none',
            borderRadius: '7px',
            background: 'transparent',
            color: 'rgba(15, 23, 42, 0.82)',
            cursor: 'pointer',
            padding: '0',
          },
          { title: '撤销（Ctrl+Z）' },
        )
        undoButton.type = 'button'
        undoButton.append(svg(ICONS.undo, 15))
        undoButton.addEventListener('click', (event) => {
          event.stopPropagation()
          undo()
        })
        toolBar.append(undoButton)
        root.append(toolBar)

        // --- action bar ---
        const actionBar = h('div', {
          position: 'absolute',
          display: 'none',
          alignItems: 'center',
          gap: '2px',
          padding: '4px',
          borderRadius: '10px',
          background: 'rgba(255, 255, 255, 0.98)',
          boxShadow: '0 12px 30px rgba(0, 0, 0, 0.26)',
        })

        function actionButton(icon, label, primary, onClick) {
          const button = h(
            'button',
            {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '7px 12px',
              border: 'none',
              borderRadius: '7px',
              background: 'transparent',
              color: primary ? '#2563eb' : 'rgba(15, 23, 42, 0.86)',
              fontFamily: FONT,
              fontSize: '12.5px',
              fontWeight: primary ? '600' : '500',
              cursor: 'pointer',
            },
            { textContent: '' },
          )
          button.type = 'button'
          button.dataset.dshScreenshotAction = label
          button.append(svg(icon, 15))
          button.append(h('span', {}, { textContent: label }))
          button.addEventListener('click', (event) => {
            event.stopPropagation()
            onClick()
          })
          return button
        }

        actionBar.append(actionButton(ICONS.copy, '复制', false, () => finish('copy')))
        actionBar.append(actionButton(ICONS.close, '取消', false, () => finish('cancel')))
        actionBar.append(actionButton(ICONS.check, '确认', true, () => finish('confirm')))
        root.append(actionBar)

        const textInput = h('input', {
          position: 'absolute',
          display: 'none',
          padding: '3px 6px',
          border: `1px solid ${MARK}`,
          borderRadius: '4px',
          background: 'rgba(255, 255, 255, 0.96)',
          color: MARK,
          fontFamily: FONT,
          fontSize: '14px',
          fontWeight: '600',
          outline: 'none',
          zIndex: '1',
        })
        textInput.type = 'text'
        textInput.placeholder = '回车确认'
        root.append(textInput)

        /* ---------------------------------------------------------- render */

        function clampRect(rect) {
          const minX = shown.left
          const minY = shown.top
          const maxX = shown.left + shown.width
          const maxY = shown.top + shown.height
          const x = Math.min(Math.max(rect.x, minX), maxX - MIN_SELECTION)
          const y = Math.min(Math.max(rect.y, minY), maxY - MIN_SELECTION)
          return {
            x,
            y,
            width: Math.min(Math.max(rect.width, MIN_SELECTION), maxX - x),
            height: Math.min(Math.max(rect.height, MIN_SELECTION), maxY - y),
          }
        }

        function render() {
          const { rect, ready } = state

          if (rect.width < MIN_SELECTION || rect.height < MIN_SELECTION) {
            shade.style.display = 'block'
            selection.style.display = 'none'
            annot.style.display = 'none'
            badge.style.display = 'none'
            actionBar.style.display = 'none'
            toolBar.style.display = 'none'
            return
          }

          shade.style.display = 'none'
          selection.style.display = 'block'
          selection.style.left = `${rect.x}px`
          selection.style.top = `${rect.y}px`
          selection.style.width = `${rect.width}px`
          selection.style.height = `${rect.height}px`

          for (const [name, dot] of handleNodes) {
            dot.style.display = ready ? 'block' : 'none'
            const vertical = name.includes('n') ? 0 : name.includes('s') ? rect.height : rect.height / 2
            const horizontal = name.includes('w') ? 0 : name.includes('e') ? rect.width : rect.width / 2
            dot.style.left = `${horizontal}px`
            dot.style.top = `${vertical}px`
          }

          badge.style.display = 'block'
          badge.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
          const badgeWidth = 78
          badge.style.left = `${Math.min(Math.max(rect.x, shown.left), shown.left + shown.width - badgeWidth)}px`
          badge.style.top = `${Math.max(rect.y - 30, 4)}px`

          if (!ready) {
            actionBar.style.display = 'none'
            toolBar.style.display = 'none'
            annot.style.display = 'none'
            return
          }

          annot.style.display = 'block'
          annot.style.left = `${rect.x}px`
          annot.style.top = `${rect.y}px`
          annot.style.width = `${rect.width}px`
          annot.style.height = `${rect.height}px`
          const backingWidth = Math.max(1, Math.round(rect.width * dpr))
          const backingHeight = Math.max(1, Math.round(rect.height * dpr))
          if (annot.width !== backingWidth || annot.height !== backingHeight) {
            annot.width = backingWidth
            annot.height = backingHeight
          }
          paintAnnotations()

          // Bars sit under the selection, or above it when the screen bottom
          // would swallow them.
          const barGap = 10
          const below = rect.y + rect.height + barGap
          const barEstimate = 46
          const placeAbove = below + barEstimate > viewportHeight
          const actionTop = placeAbove ? Math.max(rect.y - barEstimate - barGap, 4) : below
          actionBar.style.display = 'flex'
          actionBar.style.top = `${actionTop}px`
          actionBar.style.left = `${Math.min(Math.max(rect.x + rect.width / 2, 150), viewportWidth - 150)}px`
          actionBar.style.transform = 'translateX(-50%)'

          const toolTop = placeAbove
            ? actionTop - barEstimate - 4
            : Math.min(actionTop + barEstimate, viewportHeight - 46)
          toolBar.style.display = 'flex'
          toolBar.style.top = `${Math.max(toolTop, 4)}px`
          toolBar.style.left = `${Math.min(Math.max(rect.x + rect.width / 2, 160), viewportWidth - 160)}px`
          toolBar.style.transform = 'translateX(-50%)'
        }

        /* ------------------------------------------------------ annotation */

        function paintAnnotations() {
          const context = annot.getContext('2d')
          context.setTransform(1, 0, 0, 1, 0, 0)
          context.clearRect(0, 0, annot.width, annot.height)
          context.scale(dpr, dpr)
          context.lineCap = 'round'
          context.lineJoin = 'round'
          context.strokeStyle = MARK
          context.fillStyle = MARK

          const all = state.draft === null ? state.annotations : [...state.annotations, state.draft]
          for (const item of all) {
            drawAnnotation(context, item, false)
          }
        }

        function drawAnnotation(context, item, opaque) {
          context.save()
          context.strokeStyle = MARK
          context.fillStyle = MARK
          context.lineWidth = MARK_WIDTH

          if (item.tool === 'rect') {
            context.strokeRect(item.x, item.y, item.width, item.height)
          } else if (item.tool === 'ellipse') {
            context.beginPath()
            context.ellipse(
              item.x + item.width / 2,
              item.y + item.height / 2,
              Math.abs(item.width / 2),
              Math.abs(item.height / 2),
              0,
              0,
              Math.PI * 2,
            )
            context.stroke()
          } else if (item.tool === 'arrow') {
            drawArrow(context, item.x, item.y, item.x + item.width, item.y + item.height)
          } else if (item.tool === 'pen') {
            const points = item.points
            if (points.length > 1) {
              context.beginPath()
              context.moveTo(points[0].x, points[0].y)
              for (let index = 1; index < points.length; index += 1) {
                context.lineTo(points[index].x, points[index].y)
              }
              context.stroke()
            }
          } else if (item.tool === 'text') {
            context.font = `600 ${15}px ${FONT}`
            context.textBaseline = 'top'
            context.fillText(item.text, item.x, item.y)
          } else if (item.tool === 'mosaic') {
            paintMosaic(context, item)
          }

          context.restore()
        }

        function drawArrow(context, fromX, fromY, toX, toY) {
          const angle = Math.atan2(toY - fromY, toX - fromX)
          const head = 12
          context.beginPath()
          context.moveTo(fromX, fromY)
          context.lineTo(toX, toY)
          context.stroke()

          context.beginPath()
          context.moveTo(toX, toY)
          context.lineTo(toX - head * Math.cos(angle - Math.PI / 7), toY - head * Math.sin(angle - Math.PI / 7))
          context.lineTo(toX - head * Math.cos(angle + Math.PI / 7), toY - head * Math.sin(angle + Math.PI / 7))
          context.closePath()
          context.fill()
        }

        // Live mosaic preview: shrink the region on screen down to a few dozen
        // pixels and scale it back up without smoothing. The exported composite
        // does the same thing against the output canvas in compose().
        function paintMosaic(context, item) {
          const x = Math.min(item.x, item.x + item.width)
          const y = Math.min(item.y, item.y + item.height)
          const width = Math.abs(item.width)
          const height = Math.abs(item.height)
          if (width < 2 || height < 2) return

          const block = 9
          const columns = Math.max(1, Math.round(width / block))
          const rows = Math.max(1, Math.round(height / block))

          // Selection-local CSS pixels -> device pixels of the frozen frame.
          const sourceX = (state.rect.x + x - shown.left) * dpr
          const sourceY = (state.rect.y + y - shown.top) * dpr
          const sourceWidth = width * dpr
          const sourceHeight = height * dpr
          if (sourceX < 0 || sourceY < 0) return
          if (sourceX + sourceWidth > frame.width || sourceY + sourceHeight > frame.height) return

          const scratch = document.createElement('canvas')
          scratch.width = columns
          scratch.height = rows
          const scratchContext = scratch.getContext('2d')
          if (scratchContext === null) return
          scratchContext.imageSmoothingEnabled = true
          scratchContext.drawImage(frame, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, columns, rows)

          context.save()
          context.imageSmoothingEnabled = false
          context.drawImage(scratch, 0, 0, columns, rows, x, y, width, height)
          context.restore()
        }

        function setTool(tool) {
          state.tool = tool
          for (const [id, node] of toolNodes) {
            node.dataset.active = id === tool ? '1' : '0'
          }
          root.style.cursor = tool === null ? 'crosshair' : 'crosshair'
        }

        function undo() {
          if (state.annotations.length === 0) return
          state.undone.push(state.annotations.pop())
          paintAnnotations()
        }

        function redo() {
          if (state.undone.length === 0) return
          state.annotations.push(state.undone.pop())
          paintAnnotations()
        }

        /* ------------------------------------------------------- interaction */

        let drag = null

        function pointOf(event) {
          return { x: event.clientX, y: event.clientY }
        }

        function insideRect(point) {
          const { rect } = state
          return (
            point.x >= rect.x &&
            point.x <= rect.x + rect.width &&
            point.y >= rect.y &&
            point.y <= rect.y + rect.height
          )
        }

        function localPoint(point) {
          return { x: point.x - state.rect.x, y: point.y - state.rect.y }
        }

        function onPointerDown(event) {
          if (event.button !== 0) return
          if (textInput.style.display !== 'none') return commitText()

          // Clicks that land on the overlay chrome (复制 / 取消 / 确认, the tool
          // bar, the top pill, the text input) must reach their own listeners.
          // Capturing the pointer here would retarget the pointerup to this root,
          // the click would never fire on the button, and the press would instead
          // be read as "start a brand new selection" — which is exactly how the
          // 确认 button used to swallow itself and leave the overlay open.
          const chrome = typeof event.target?.closest === 'function' ? event.target.closest('button, input') : null
          if (chrome !== null) return

          // Keep receiving moves even when the pointer slips outside the
          // window while dragging a selection or a shape.
          try {
            root.setPointerCapture(event.pointerId)
          } catch {
            // The pointer may already be gone; dragging still works inside.
          }

          const point = pointOf(event)
          const handle = event.target instanceof HTMLElement ? event.target.dataset.handle : undefined

          if (state.ready && handle !== undefined && handleNode(handle)) {
            drag = { mode: 'resize', handle, start: point, startRect: { ...state.rect } }
            return
          }

          if (state.ready && insideRect(point)) {
            if (state.tool === 'text') {
              beginText(point)
              return
            }
            if (state.tool !== null) {
              drag = {
                mode: 'draw',
                tool: state.tool,
                start: localPoint(point),
                item: { tool: state.tool, x: point.x - state.rect.x, y: point.y - state.rect.y, width: 0, height: 0, points: [] },
              }
              if (state.tool === 'pen') drag.item.points = [localPoint(point)]
              state.draft = drag.item
              return
            }
            drag = { mode: 'move', start: point, startRect: { ...state.rect } }
            return
          }

          // Outside the selection: start a new one.
          state.ready = false
          state.annotations = []
          state.undone = []
          state.draft = null
          state.rect = { x: point.x, y: point.y, width: 0, height: 0 }
          drag = { mode: 'create', start: point }
          render()
        }

        function handleNode(name) {
          return HANDLES.includes(name)
        }

        function onPointerMove(event) {
          if (drag === null) return
          const point = pointOf(event)

          if (drag.mode === 'create') {
            state.rect = clampRect({
              x: Math.min(drag.start.x, point.x),
              y: Math.min(drag.start.y, point.y),
              width: Math.abs(point.x - drag.start.x),
              height: Math.abs(point.y - drag.start.y),
            })
            render()
            return
          }

          if (drag.mode === 'move') {
            const dx = point.x - drag.start.x
            const dy = point.y - drag.start.y
            state.rect = clampRect({ ...drag.startRect, x: drag.startRect.x + dx, y: drag.startRect.y + dy })
            render()
            return
          }

          if (drag.mode === 'resize') {
            const base = drag.startRect
            let left = base.x
            let top = base.y
            let right = base.x + base.width
            let bottom = base.y + base.height
            if (drag.handle.includes('w')) left = point.x
            if (drag.handle.includes('e')) right = point.x
            if (drag.handle.includes('n')) top = point.y
            if (drag.handle.includes('s')) bottom = point.y
            state.rect = clampRect({
              x: Math.min(left, right),
              y: Math.min(top, bottom),
              width: Math.abs(right - left),
              height: Math.abs(bottom - top),
            })
            render()
            return
          }

          if (drag.mode === 'draw') {
            const item = drag.item
            const local = localPoint(point)
            if (item.tool === 'pen') {
              item.points.push(local)
            } else {
              item.width = local.x - item.x
              item.height = local.y - item.y
            }
            paintAnnotations()
          }
        }

        function onPointerUp() {
          if (drag === null) return
          const mode = drag.mode
          const item = drag.item
          drag = null

          if (mode === 'create') {
            if (state.rect.width >= MIN_SELECTION && state.rect.height >= MIN_SELECTION) {
              state.ready = true
            }
            render()
            return
          }

          if (mode === 'draw' && item !== undefined) {
            state.draft = null
            const tiny =
              item.tool === 'pen'
                ? item.points.length < 2
                : Math.abs(item.width) < 4 && Math.abs(item.height) < 4
            if (!tiny) {
              state.annotations.push(item)
              state.undone = []
            }
            paintAnnotations()
          }
        }

        function beginText(point) {
          const local = localPoint(point)
          textInput.style.display = 'block'
          textInput.style.left = `${point.x}px`
          textInput.style.top = `${point.y}px`
          textInput.value = ''
          textInput.dataset.x = String(local.x)
          textInput.dataset.y = String(local.y)
          setTimeout(() => textInput.focus(), 0)
        }

        function commitText() {
          const text = textInput.value.trim()
          if (text.length > 0) {
            state.annotations.push({
              tool: 'text',
              x: Number(textInput.dataset.x ?? 0),
              y: Number(textInput.dataset.y ?? 0),
              width: 0,
              height: 0,
              text,
            })
            state.undone = []
          }
          textInput.style.display = 'none'
          textInput.value = ''
          paintAnnotations()
        }

        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (textInput.style.display !== 'none') {
              textInput.style.display = 'none'
              textInput.value = ''
              return
            }
            finish('cancel')
            return
          }
          if (textInput.style.display !== 'none') {
            if (event.key === 'Enter') {
              event.preventDefault()
              commitText()
            }
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            if (state.ready) finish('confirm')
            return
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault()
            if (event.shiftKey) redo()
            else undo()
            return
          }
          const shortcut = { r: 'rect', o: 'ellipse', a: 'arrow', p: 'pen', t: 'text', m: 'mosaic' }[event.key.toLowerCase()]
          if (shortcut !== undefined && state.ready) {
            event.preventDefault()
            setTool(state.tool === shortcut ? null : shortcut)
          }
        }

        root.addEventListener('pointerdown', onPointerDown)
        root.addEventListener('pointermove', onPointerMove)
        root.addEventListener('pointerup', onPointerUp)
        root.addEventListener('dblclick', (event) => {
          if (state.ready && insideRect(pointOf(event))) finish('confirm')
        })
        root.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          finish('cancel')
        })
        window.addEventListener('keydown', onKeyDown, true)

        /* ---------------------------------------------------------- compose */

        function compose() {
          return new Promise((resolve, reject) => {
            try {
            const { rect } = state
            const sourceX = (rect.x - shown.left) * ratio
            const sourceY = (rect.y - shown.top) * ratio
            const sourceWidth = Math.max(1, rect.width * ratio)
            const sourceHeight = Math.max(1, rect.height * ratio)

            const output = document.createElement('canvas')
            output.width = Math.round(sourceWidth)
            output.height = Math.round(sourceHeight)
            const context = output.getContext('2d')
            context.imageSmoothingEnabled = false
            context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, output.width, output.height)

            const scale = output.width / rect.width
            context.scale(scale, scale)
            context.lineCap = 'round'
            context.lineJoin = 'round'
            context.strokeStyle = MARK
            context.fillStyle = MARK
            context.lineWidth = MARK_WIDTH
            for (const item of state.annotations) {
              if (item.tool === 'mosaic') {
                const x = Math.min(item.x, item.x + item.width)
                const y = Math.min(item.y, item.y + item.height)
                const width = Math.abs(item.width)
                const height = Math.abs(item.height)
                if (width >= 2 && height >= 2) {
                  const block = 9
                  const columns = Math.max(1, Math.round(width / block))
                  const rows = Math.max(1, Math.round(height / block))
                  const scratch = document.createElement('canvas')
                  scratch.width = columns
                  scratch.height = rows
                  const scratchContext = scratch.getContext('2d')
                  scratchContext.drawImage(output, x * scale, y * scale, width * scale, height * scale, 0, 0, columns, rows)
                  context.save()
                  context.imageSmoothingEnabled = false
                  context.drawImage(scratch, 0, 0, columns, rows, x, y, width, height)
                  context.restore()
                }
                continue
              }
              // One malformed annotation must not lose the whole screenshot.
              try {
                drawAnnotation(context, item, true)
              } catch (error) {
                report('annotation-skipped', {
                  tool: item.tool,
                  message: error instanceof Error ? error.message : String(error),
                })
              }
            }

            output.toBlob((blob) => resolve(blob), 'image/png')
            } catch (error) {
              reject(error)
            }
          })
        }

        /* ------------------------------------------------------------ close */

        let settled = false

        function teardown() {
          window.removeEventListener('keydown', onKeyDown, true)
          root.remove()
        }

        async function finish(action) {
          if (settled) return
          if (action !== 'cancel' && (!state.ready || state.rect.width < MIN_SELECTION)) {
            toast('先拖拽选出一块区域')
            return
          }
          settled = true

          if (action === 'cancel') {
            teardown()
            resolve({ action: 'cancel' })
            return
          }

          // The overlay must leave the screen no matter what compose() does:
          // a throw used to skip teardown and leave the user stuck in the
          // dimmed frame with no way out.
          try {
            const blob = await compose()
            if (blob === null || blob === undefined) {
              toast('这块区域没能导出成图片，请重新框选')
              report('compose-empty', { rect: state.rect })
              teardown()
              resolve({ action: 'cancel' })
              return
            }
            teardown()
            resolve({ action, blob })
          } catch (error) {
            report('compose-threw', {
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? String(error.stack).slice(0, 600) : null,
              annotations: state.annotations.length,
              rect: state.rect,
            })
            toast('这块区域没能导出成图片，请重新框选')
            teardown()
            resolve({ action: 'cancel' })
          }
        }

        document.body.append(root)
        render()
      })
    }

    /* ------------------------------------------------------------ attach */

    function screenshotName() {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return [
        'screenshot-',
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        '-',
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
        '.png',
      ].join('')
    }

    function draftImageCount() {
      // Count only what the attachment rail really put there. The composer card
      // also renders static glyphs (model badge, permission shield), and counting
      // those made the draft look non-empty — which both skipped the self-check
      // and made a refused paste look delivered.
      const nodes = document.querySelectorAll(
        '[data-composer-card] img[src^="blob:"], [data-composer-card] [data-attachment], [data-draft-attachment]',
      )
      return nodes.length
    }

    function pasteFile(file) {
      const transfer = new DataTransfer()
      transfer.items.add(file)
      const event = new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      })
      document.dispatchEvent(event)
      return event.defaultPrevented
    }

    function dropFile(file) {
      const transfer = new DataTransfer()
      transfer.items.add(file)
      const target = document.querySelector('[data-composer-card]') ?? document.body
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }))
      }
    }

    async function attachImage(blob) {
      const file = new File([blob], screenshotName(), { type: 'image/png' })
      const before = draftImageCount()
      const deadline = Date.now() + ATTACH_TIMEOUT_MS
      let warned = false
      let attempts = 0
      let accepted = false

      report('attach-start', {
        bytes: blob.size,
        imagesBefore: before,
        composerCards: document.querySelectorAll('[data-composer-card]').length,
        draftImages: document.querySelectorAll('[data-composer-card] img').length,
        activeElement: document.activeElement === null ? null : document.activeElement.tagName,
      })

      while (Date.now() < deadline) {
        attempts += 1
        if (pasteFile(file)) {
          accepted = true
          break
        }
        if (!warned) {
          warned = true
          console.debug('[dsh-shot] composer intake refused the paste; retrying until it frees up')
          toast('输入框正忙，等这条回复结束后会自动把截图贴进去（最多等 5 分钟）')
        }
        await delay(ATTACH_RETRY_MS)
      }

      report('attach-paste', { accepted, attempts, imagesNow: draftImageCount() })

      if (await waitForDraftImage(before, 1500)) {
        report('attach-ok', { via: 'paste', images: draftImageCount() })
        return true
      }

      dropFile(file)
      if (await waitForDraftImage(before, 900)) {
        report('attach-ok', { via: 'drop', images: draftImageCount() })
        return true
      }

      report('attach-failed', {
        accepted,
        attempts,
        imagesAfter: draftImageCount(),
        cards: document.querySelectorAll('[data-composer-card]').length,
      })
      // Two different refusals, two different messages: the composer gate
      // (busy / locked / no upload permission) never lets the paste through,
      // while the image limits reject the attachment after taking it.
      toast(
        accepted
          ? '截图没进草稿：可能触发了这个会话的图片数量或体积上限'
          : '输入框一直没空出来（等了 5 分钟），这张截图没能贴进去',
      )
      return false
    }

    async function waitForDraftImage(previous, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (draftImageCount() > previous) return true
        await delay(80)
      }
      return draftImageCount() > previous
    }

    async function copyToClipboard(blob) {
      try {
        if (typeof ClipboardItem === 'undefined' || navigator.clipboard?.write === undefined) throw new Error('no clipboard')
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        toast('已复制到剪贴板')
        return true
      } catch {
        try {
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = screenshotName()
          document.body.append(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
          toast('剪贴板不可用，已另存为图片文件')
          return true
        } catch {
          toast('复制失败')
          return false
        }
      }
    }

    /* ---------------------------------------------------------- autotest */

    // Runs only when the host reports the marker file. It pushes one throwaway
    // image through the same intake path a real screenshot uses and then tries
    // to remove it again, so the attachment wiring can be verified without a
    // person clicking through the overlay.
    async function probeIntake() {
      let enabled = false
      try {
        const response = await fetch(AUTOTEST_ROUTE, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        })
        enabled = response.ok && (await response.json())?.run === true
      } catch {
        return
      }
      if (!enabled) return

      // A self-check that only writes to a log is invisible to whoever is
      // watching the screen, so keep the verdict pinned on screen as well.
      const banner = h(
        'div',
        {
          position: 'fixed',
          top: '14px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: String(OVERLAY_Z + 10),
          padding: '10px 16px',
          borderRadius: '10px',
          background: 'rgba(12,16,26,.92)',
          border: '1px solid rgba(255,255,255,.14)',
          color: '#eaf2ff',
          font: `500 13px/1.5 ${FONT}`,
          whiteSpace: 'pre-wrap',
          pointerEvents: 'none',
          maxWidth: '70vw',
        },
      )
      banner.dataset.dshScreenshotAutotest = '1'
      // The verdict is informational only, so it must never become furniture on
      // top of the app: every update restarts a timer that takes it away.
      let dismissTimer = 0
      const say = (text) => {
        banner.textContent = text
        if (banner.isConnected === false) document.body.append(banner)
        window.clearTimeout(dismissTimer)
        dismissTimer = window.setTimeout(() => banner.remove(), 7000)
      }
      // Never touch a draft that already holds something: removing "the last
      // image" afterwards could delete the person's own attachment.
      if (draftImageCount() > 0) {
        report('autotest-skipped', { reason: 'draft already has images', images: draftImageCount() })
        banner.remove()
        return
      }

      say('截图自检：正在验证能否把图片放进输入框…')

      report('autotest-start', { cards: document.querySelectorAll('[data-composer-card]').length })

      for (let waited = 0; waited < 15000; waited += 250) {
        if (document.querySelector('[data-composer-card]') !== null) break
        await delay(250)
      }

      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 200
      const context = canvas.getContext('2d')
      context.fillStyle = '#2f6df6'
      context.fillRect(0, 0, 320, 200)
      context.fillStyle = '#ffffff'
      context.font = '600 28px sans-serif'
      context.fillText('intake probe', 24, 112)

      const blob = await new Promise((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'))
      if (blob === null) {
        say('截图自检：导出测试图失败')
        report('autotest-noblob')
        return
      }

      const ok = await attachImage(blob)
      const afterPaste = draftImageCount()
      say(ok ? '截图自检：附件通道正常 ✓' : `截图自检：附件通道被拒绝 ✗（缩略图=${afterPaste}，输入框=${document.querySelectorAll('[data-composer-card]').length}）`)
      report('autotest-result', { ok, images: afterPaste })

      // Remove the probe from the draft so the person never sees it.
      await delay(400)
      const images = [...document.querySelectorAll('[data-composer-card] img[src^="blob:"]')]
      const last = images.at(-1)
      if (last === undefined) {
        say('截图自检：附件通道打开了，但草稿栏没有出现缩略图 ✗')
        report('autotest-cleanup', { removed: false, reason: 'no image in rail' })
        return
      }
      let node = last
      let removed = false
      for (let depth = 0; depth < 5 && node !== null && !removed; depth += 1) {
        const target = [...node.querySelectorAll('button')].find((button) =>
          /移除|删除|remove|delete/i.test(
            `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`,
          ),
        )
        if (target !== undefined) {
          target.click()
          removed = true
          break
        }
        node = node.parentElement
      }
      await delay(300)
      say(`${ok ? '截图自检：附件通道正常 ✓' : '截图自检：附件通道被拒绝 ✗'}
清理=${removed ? '已移除测试图' : '测试图仍在草稿里，请手动删掉'}  剩余=${draftImageCount()}`)
      report('autotest-cleanup', { removed, images: draftImageCount() })
    }

    /* ------------------------------------------------------------ build stamp */

    // While the plugin is being developed the renderer may still be running an
    // older bundle, and there is no way to open devtools from here. The build
    // number therefore lives in the button tooltip and in every log line, so
    // "did the page pick up my change" stops being a guess. The floating corner
    // badge this used to draw sat under the app's own status strip, where nobody
    // could see it.
    const BUILD = '2080'

    /* ------------------------------------------------------------- button */

    function readHidePreference() {
      try {
        const stored = window.localStorage.getItem(HIDE_PREF_KEY)
        return stored === null ? true : stored === '1'
      } catch {
        return true
      }
    }

    function writeHidePreference(value) {
      try {
        window.localStorage.setItem(HIDE_PREF_KEY, value ? '1' : '0')
      } catch {
        /* private mode; the toggle simply does not persist */
      }
    }

    let running = false

    async function runScreenshot() {
      if (running) return
      running = true

      const hideWindow = readHidePreference()

      try {
        const shot = await captureDesktop(hideWindow)
        report('capture', { width: shot.width, height: shot.height, hideWindow })
        if (hideWindow) await nextFrame()

        const result = await openEditor(shot)
        report('editor', { action: result.action, blobSize: result.blob?.size ?? null })

        if (hideWindow) {
          // Give the window back its old geometry before touching the
          // composer, so the attachment lands in the layout the user sees.
          await releaseWindow()
          await delay(120)
        }

        if (result.action === 'cancel') return
        if (result.action === 'copy') {
          await copyToClipboard(result.blob)
          return
        }
        toast('正在把截图放进输入框…')
        await attachImage(result.blob)
      } catch (error) {
        report('run-threw', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? String(error.stack).slice(0, 600) : null,
        })
        if (hideWindow) await releaseWindow()
        toast(error instanceof Error ? error.message : '截屏失败')
      } finally {
        running = false
      }
    }

    function ScreenshotButton() {
      const [busy, setBusy] = React.useState(false)
      const [hide, setHide] = React.useState(readHidePreference)

      async function onClick() {
        if (busy) return
        setBusy(true)
        try {
          await runScreenshot()
        } finally {
          setBusy(false)
        }
      }

      function onContextMenu(event) {
        event.preventDefault()
        const next = !readHidePreference()
        writeHidePreference(next)
        setHide(next)
        toast(next ? '截屏时隐藏本窗口：开' : '截屏时隐藏本窗口：关')
      }

      return React.createElement(
        'button',
        {
          type: 'button',
          'data-dsh-screenshot-button': '',
          'data-busy': busy ? '1' : '0',
          title: `截图（框选屏幕区域）\n右键切换：截屏时隐藏本窗口（当前${hide ? '开' : '关'}）\n版本 shot ${BUILD}`,
          disabled: busy,
          onClick,
          onContextMenu,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '28px',
            height: '28px',
            padding: '0',
            border: 'none',
            borderRadius: '8px',
            background: 'transparent',
            color: 'inherit',
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.7 : 1,
          },
        },
        reactSvg(ICONS.camera, 16),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Anything thrown here leaves the slot empty and the button invisible
        // with no trace anywhere, so report the failure by name before rethrowing.
        try {
          installStyles()
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'dsh-shot',
                order: 20,
              },
              ScreenshotButton,
            ),
          )
          void probeIntake()
        } catch (error) {
          report('apply-threw', {
            message: error?.message ?? String(error),
            stack: error?.stack,
            build: BUILD,
          })
          throw error
        }
      },
    }
  },
})