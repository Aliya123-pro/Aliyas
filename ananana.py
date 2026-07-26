# ananana.py – résolution silencieuse du Turnstile
import time, random

def move_mouse_to(page, x: float, y: float):
    start = page.evaluate("() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 })")
    steps = random.randint(10, 20)
    for i in range(1, steps + 1):
        t = i / steps
        cp = {
            "x": start["x"] + random.uniform(-100, 100),
            "y": start["y"] + random.uniform(-100, 100),
        }
        nx = (1 - t) ** 2 * start["x"] + 2 * (1 - t) * t * cp["x"] + t**2 * x
        ny = (1 - t) ** 2 * start["y"] + 2 * (1 - t) * t * cp["y"] + t**2 * y
        page.mouse.move(nx, ny)
        time.sleep(0.015)

def check_turnstile_token(page) -> bool:
    try:
        val = page.evaluate("""() => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            if (input && input.value.length > 0) return true;
            if (typeof window.__cf_turnstile_callback === 'function') return true;
            return false;
        }""")
        return bool(val)
    except:
        return False

def solve_turnstile(page, timeout=30):
    """Tente de résoudre le Turnstile (invisible ou par clic)."""
    start = time.time()
    while time.time() - start < 3:
        if check_turnstile_token(page):
            print("✅ Turnstile résolu automatiquement (invisible)")
            return True
        time.sleep(0.5)

    try:
        verify_btn = page.wait_for_selector('text="Verify you are human"', timeout=5000)
        if verify_btn:
            box = verify_btn.bounding_box()
            if box:
                x = box['x'] + box['width'] / 2
                y = box['y'] + box['height'] / 2
                print(f"🖱️ Clic sur 'Verify you are human' à ({x:.0f}, {y:.0f})")
                move_mouse_to(page, x, y)
                page.mouse.click(x, y)
    except:
        pass

    while time.time() - start < timeout:
        if check_turnstile_token(page):
            print("✅ Turnstile résolu après clic")
            return True
        time.sleep(1)
    return False
