# Renders loader/icons/icon.svg into the PNG home-screen icons (needs the test venv's Playwright).
#   .venv/bin/python tools/make-icons.py
# Loader files are pinned and signed: run tools/pin-runtime.mjs and tools/make-release.mjs afterwards.
import pathlib
from playwright.sync_api import sync_playwright

ICONS = pathlib.Path(__file__).resolve().parent.parent / "loader" / "icons"
svg = (ICONS / "icon.svg").read_text()
# Maskable icons are cropped to a circle or squircle by the phone, so the background fills the square.
maskable = svg.replace('rx="112" fill="#1E1A2E"', 'fill="#1E1A2E"')
# iOS rounds the corners itself and shows transparency as black.
apple = maskable

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, src, size in [("icon-192.png", svg, 192), ("icon-512.png", svg, 512),
                            ("maskable-512.png", maskable, 512), ("apple-touch-icon.png", apple, 180)]:
        page = b.new_page(viewport={"width": size, "height": size})
        page.set_content(f"<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{size}px;height:{size}px}}</style>{src}")
        page.screenshot(path=str(ICONS / name), omit_background=True)
        page.close()
        print("wrote", name)
    b.close()
