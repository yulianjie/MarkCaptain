# Desktop blur

The title bar and sidebar expose a native compositor backdrop only after
`cmd_window_enable_backdrop` succeeds. The document remains opaque. Browser
previews and unsupported desktops use solid theme colors, not simulated blur.

| Platform | Backend | Support detection |
| --- | --- | --- |
| Windows | Acrylic (`window-vibrancy`) | Native application result |
| macOS | Sidebar Vibrancy | Native application result |
| Linux X11 / XWayland | `_KDE_NET_WM_BLUR_BEHIND_REGION` | Active compositor selection and blur property advertised on the root window |
| Linux Wayland | `ext_background_effect_manager_v1` | Advertised global and explicit Blur capability |
| Linux Wayland (KDE protocol) | `org_kde_kwin_blur_manager` | Advertised global |
| Other desktops / browser | Solid theme colors | No supported protocol |

The Linux backend uses the actual GTK window/display handles. It does not infer
support from desktop names, run shell commands, take screenshots, or modify
compositor settings. It borrows GTK's Wayland connection, uses a separate event
queue, and never destroys or commits GTK's surface. Protocol objects and the
monitor timer are released with the GTK window. X11 properties and Wayland
capabilities are checked every two seconds; loss of support makes chrome solid.
Enabling a previously unavailable protocol requires reopening the window.

The compositor chooses the blur algorithm and strength. A protocol request
cannot prove that a compositor/driver rendered blur; KDE's older protocol has no
per-frame success acknowledgement. GNOME, wlroots-based compositors, and other
environments only enable this feature if they advertise one of the implemented
protocols. No blanket support claim is made for all Linux desktops.

Windows and macOS/Linux main windows use platform configuration files with
transparent backgrounds. New editor windows use equivalent builder options.
Keep the duplicated main-window geometry settings in sync with tauri.conf.json.
Preferences and utility windows remain opaque. macOS uses an overlay title bar
with native traffic lights; its transparent WebView requires Tauri's
`macos-private-api` feature (not suitable for Mac App Store submission).

Reduced-transparency and forced-color CSS preferences force opaque rendering.
OS compositor accessibility and power policies can also suppress effects.

## Verification

`npm run test:e2e -- editor-glass.spec.ts` covers transparent ancestors, opaque
document content, solid fallback in light/dark themes, and forced colors. These
browser tests do not prove desktop blur.

On each supported desktop, run `npm run tauri:dev`, put a moving/high-contrast
window behind MarkCaptain, and verify that the title bar and sidebar update while
the document stays opaque. Repeat for a new editor window, window resizing,
closing/reopening, and disabling the compositor's blur effect. On an unsupported
desktop, verify solid chrome from the first frame. Verify macOS traffic lights
and the application menu, plus Linux custom window controls and menus.

Protocol references:

- https://github.com/KDE/kwindowsystem/blob/master/src/platforms/xcb/kwindoweffects.cpp
- https://github.com/KDE/plasma-wayland-protocols/blob/master/src/protocols/blur.xml
- https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/staging/ext-background-effect/ext-background-effect-v1.xml
