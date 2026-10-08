//! Native geometry smoke test; creates only disposable, blank test windows.
//! Run: cargo run --example window_placement_check
//! Does not change the desktop layout or load/save application preferences.

#[path = "../src/window_placement.rs"]
mod window_placement;

use tauri::{Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow};

fn fits(window: &WebviewWindow, monitor: &Monitor) -> tauri::Result<bool> {
    let pos = window.outer_position()?;
    let size = window.outer_size()?;
    let area = monitor.work_area();
    // Windows rounds some frame dimensions when crossing DPI boundaries.
    Ok(pos.x >= area.position.x - 2
        && pos.y >= area.position.y - 2
        && i64::from(pos.x) + i64::from(size.width)
            <= i64::from(area.position.x) + i64::from(area.size.width) + 2
        && i64::from(pos.y) + i64::from(size.height)
            <= i64::from(area.position.y) + i64::from(area.size.height) + 2)
}

fn verify(condition: bool, name: &str) -> Result<(), Box<dyn std::error::Error>> {
    if !condition {
        return Err(format!("FAIL: {name}").into());
    }
    println!("PASS: {name}");
    Ok(())
}

async fn check(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let monitors = app.available_monitors()?;
    let primary = app.primary_monitor()?.ok_or("no primary monitor")?;
    println!("Checking {} connected monitors", monitors.len());
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::External("about:blank".parse()?),
    )
    .title("MarkCaptain window recovery test")
    .inner_size(900.0, 700.0)
    .min_inner_size(760.0, 560.0)
    .visible(false)
    .build()?;

    let detached_x = monitors
        .iter()
        .map(|m| i64::from(m.position().x) + i64::from(m.size().width))
        .max()
        .ok_or("no monitors")?
        + 2000;
    let detached = PhysicalPosition::new(
        i32::try_from(detached_x)?,
        primary.work_area().position.y + 100,
    );
    window.set_position(detached)?;
    verify(
        window.outer_position()?.x == detached.x,
        "fixture really is outside all connected screens",
    )?;
    window_placement::show(&window, Some(&primary))?;
    verify(
        fits(&window, &primary)? && window.is_visible()?,
        "explicit open recovers offscreen Preferences",
    )?;

    for monitor in &monitors {
        window.set_position(detached)?;
        window_placement::show(&window, Some(monitor))?;
        verify(
            fits(&window, monitor)?,
            "Preferences follows the requesting editor's monitor",
        )?;
        let original = window.outer_position()?;
        window_placement::ensure_reachable(&window, None)?;
        verify(
            window.outer_position()? == original,
            "healthy secondary-screen position is preserved",
        )?;
    }

    window.set_position(PhysicalPosition::new(
        primary.position().x + 100,
        primary.position().y - 600,
    ))?;
    window_placement::ensure_reachable(&window, None)?;
    verify(
        monitors.iter().any(|m| fits(&window, m).unwrap_or(false)),
        "saved geometry with inaccessible title bar is repaired",
    )?;

    window.maximize()?;
    verify(window.is_maximized()?, "maximized fixture")?;
    window_placement::ensure_reachable(&window, None)?;
    verify(
        window.is_maximized()?,
        "recovery preserves an accessible maximized window",
    )?;
    window.minimize()?;
    verify(window.is_minimized()?, "minimized fixture")?;
    window_placement::ensure_reachable(&window, None)?;
    verify(
        window.is_minimized()?,
        "background recovery leaves minimized windows alone",
    )?;
    window_placement::show(&window, Some(&primary))?;
    verify(
        !window.is_minimized()?,
        "explicit open restores a minimized window",
    )?;

    window.unmaximize()?;
    window.set_min_size(Some(PhysicalSize::new(5000, 4000)))?;
    window.set_size(PhysicalSize::new(5000, 4000))?;
    window.set_position(detached)?;
    window_placement::ensure_reachable(&window, Some(&primary))?;
    verify(
        fits(&window, &primary)?,
        "oversized window and minimum are clamped to the destination work area",
    )?;

    window.hide()?;
    window.set_position(detached)?;
    window_placement::ensure_reachable(&window, None)?;
    verify(
        !window.is_visible()?,
        "geometry repair does not reveal hidden windows",
    )?;
    verify(
        monitors.iter().any(|m| fits(&window, m).unwrap_or(false)),
        "background recovery finds a remaining screen",
    )?;

    let editor =
        tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External("about:blank".parse()?))
            .title("MarkCaptain window recovery focus test")
            .inner_size(800.0, 600.0)
            .visible(false)
            .build()?;
    window_placement::show(&window, Some(&primary))?;
    window_placement::show(&editor, Some(&primary))?;
    verify(
        editor.is_focused()?,
        "editor holds focus before background recovery",
    )?;
    window.set_position(detached)?;
    window_placement::watch_displays(app.clone());
    // The first monitor snapshot exercises the same pass as a changed layout.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    verify(
        monitors.iter().any(|m| fits(&window, m).unwrap_or(false)),
        "monitor watcher automatically recovers a detached window",
    )?;
    verify(
        editor.is_focused()?,
        "automatic recovery does not steal editor focus",
    )?;
    window.destroy()?;
    editor.destroy()?;
    Ok(())
}

fn main() {
    let exit_status = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(1));
    let result_status = exit_status.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().identifier =
        "io.github.yulianjie.markcaptain.window-placement-check".into();
    tauri::Builder::default()
        .setup(move |app| {
            // Geometry operations run away from the event loop, just like
            // asynchronous IPC commands.
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let status = match check(&app).await {
                    Ok(()) => 0,
                    Err(error) => {
                        eprintln!("{error}");
                        1
                    }
                };
                result_status.store(status, std::sync::atomic::Ordering::SeqCst);
                app.exit(status);
            });
            Ok(())
        })
        .build(context)
        .expect("build native window recovery test")
        .run(|_, event| {
            // Explicit exit above owns the exit code, even after the last
            // disposable window is destroyed.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
    // Some native event loops do not forward AppHandle::exit's code to main.
    std::process::exit(exit_status.load(std::sync::atomic::Ordering::SeqCst));
}
