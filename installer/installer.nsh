; Custom NSIS include for the Windows installer (wired up via nsis.include in
; electron-builder.yml).

; Without this the installer is not DPI aware, so Windows renders it at 96 DPI
; and bitmap-stretches the window on scaled displays, which makes text and
; controls blurry. electron-builder bundles NSIS 3.0.4, which predates
; ManifestDPIAwareness (per-monitor), so system-aware is the best available.
ManifestDPIAware true
