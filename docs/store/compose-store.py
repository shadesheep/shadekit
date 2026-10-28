"""Generate browser-extension store listing assets from real ShadeKit captures.

Only crops, scales, frames and captions real screenshots; the extension UI is
never redrawn. Raw captures come from docs/readme-demo/capture.mjs (default
output: docs/images/raw, override with SHADEKIT_STORE_RAW).
"""
from pathlib import Path
import argparse
import os
import shutil

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RAW = Path(os.environ.get('SHADEKIT_STORE_RAW', ROOT / 'docs/images/raw'))
OUT = Path(__file__).resolve().parent
SHOTS = OUT / 'screenshots'
PROMO = OUT / 'promo'
ICONS = OUT / 'icons'
LOGO = OUT / 'source/logo-300-master.png'

CANVAS = '#f5f6f8'
INK = '#18213a'
MUTED = '#657087'
LINE = '#dfe4ec'
INDIGO = '#5968e8'
SHOT_SIZE = (1280, 800)
HEAD_TOP = 44
CONTENT_TOP = 150
CONTENT_H = 590
MARGIN = 64


def cn_font(size):
    paths = list(Path('/System/Library/AssetsV2').rglob('PingFang.ttc'))
    paths += [Path('/System/Library/Fonts/PingFang.ttc'), Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')]
    path = next((p for p in paths if p.is_file()), None)
    if not path:
        raise FileNotFoundError('需要支持中文的 PingFang 或 Arial Unicode 字体')
    return ImageFont.truetype(str(path), size, index=2)


def latin_font(size, bold=True):
    path = Path('/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Arial.ttf')
    if not path.is_file():
        path = Path('/System/Library/Fonts/Helvetica.ttc')
    return ImageFont.truetype(str(path), size)


def screenshot(name):
    path = RAW / f'{name}.png'
    if not path.is_file():
        raise FileNotFoundError(f'缺少真实截图：{path}；先运行 docs/readme-demo/capture.mjs')
    return Image.open(path).convert('RGB')


def fit(image, max_width, max_height):
    ratio = min(max_width / image.width, max_height / image.height)
    return image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS)


def paste_rounded(canvas, image, box, radius=12, shadow=True):
    x, y = box
    if shadow:
        shadow_image = Image.new('RGBA', canvas.size)
        sd = ImageDraw.Draw(shadow_image)
        sd.rounded_rectangle((x + 2, y + 5, x + image.width + 2, y + image.height + 5), radius, fill='#15234424')
        canvas.alpha_composite(shadow_image.filter(ImageFilter.GaussianBlur(7)))
    mask = Image.new('L', image.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width, image.height), radius, fill=255)
    canvas.paste(image.convert('RGBA'), box, mask)
    ImageDraw.Draw(canvas).rounded_rectangle((x, y, x + image.width - 1, y + image.height - 1), radius, outline=LINE)


def tracked(draw, xy, text, font, fill, spacing):
    x, y = xy
    for char in text:
        draw.text((x, y), char, font=font, fill=fill)
        x += draw.textlength(char, font=font) + spacing


def heading(draw, eyebrow, title, subtitle):
    tracked(draw, (MARGIN, HEAD_TOP), eyebrow, latin_font(12), INDIGO, 2)
    draw.text((MARGIN, HEAD_TOP + 20), title, font=cn_font(31), fill=INK)
    draw.text((MARGIN + 1, HEAD_TOP + 68), subtitle, font=cn_font(15), fill=MUTED)


def shot_canvas(eyebrow, title, subtitle, footer_right='演示数据均为虚构'):
    canvas = Image.new('RGBA', SHOT_SIZE, CANVAS)
    draw = ImageDraw.Draw(canvas)
    heading(draw, eyebrow, title, subtitle)
    draw.text((MARGIN, 764), 'ShadeKit · 浏览器开发者工具箱', font=cn_font(12), fill=MUTED)
    width = draw.textlength(footer_right, font=cn_font(12))
    draw.text((SHOT_SIZE[0] - MARGIN - width, 764), footer_right, font=cn_font(12), fill=MUTED)
    return canvas


def place_fit(canvas, image, max_width, max_height, top=CONTENT_TOP, align='center', vertical='center'):
    resized = fit(image, max_width, max_height)
    y = top + (max_height - resized.height) // 2 if vertical == 'center' else top
    x = MARGIN + (max_width - resized.width) // 2 if align == 'center' else MARGIN
    paste_rounded(canvas, resized, (x, y))
    return resized


def save_png(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.convert('RGB').save(path, 'PNG', optimize=True)


def compose_account_switch():
    canvas = shot_canvas(
        'ACCOUNT SWITCHING',
        '网页内切换环境与账号',
        '悬浮面板统一选择环境与账号，页面角落常驻环境指示器',
    )
    place_fit(canvas, screenshot('hero-source'), 1152, CONTENT_H)
    save_png(canvas, SHOTS / '01-account-switch.png')


def compose_account_manager():
    canvas = shot_canvas(
        'ACCOUNT MANAGER',
        '环境与账号集中管理',
        '多环境、多账号、角色标签与密码状态，一处维护',
    )
    place_fit(canvas, screenshot('account-config').crop((170, 16, 1270, 522)), 1152, CONTENT_H)
    save_png(canvas, SHOTS / '02-account-manager.png')


def compose_generic_login():
    canvas = shot_canvas(
        'GENERIC LOGIN',
        '通用登录，目标系统无需改造',
        '填写登录页地址、识别登录表单、确认认证信息清理，全程在配置抽屉内完成',
    )
    place_fit(canvas, screenshot('store-login-config').crop((150, 0, 1440, 900)), 1152, CONTENT_H)
    save_png(canvas, SHOTS / '03-generic-login.png')


def compose_json_tools():
    canvas = shot_canvas(
        'JSON TOOLS',
        'JSON 格式化与对比',
        '格式化、压缩、JSONPath 查询，RFC 6902 差异高亮对比',
    )
    draw = ImageDraw.Draw(canvas)
    panels = (
        ('tool-json-format', 522),
        ('tool-json-diff', 300),
    )
    width, gap = 1000, 20
    x = (SHOT_SIZE[0] - width) // 2
    y = CONTENT_TOP
    bottom = y
    for name, crop_height in panels:
        height = round(width * crop_height / 1440)
        panel = screenshot(name).crop((0, 0, 1440, crop_height)).resize((width, height), Image.Resampling.LANCZOS)
        paste_rounded(canvas, panel, (x, y), radius=10)
        bottom = y + height
        y = bottom + gap
    if bottom > 742:
        raise ValueError(f'04-json-tools 内容溢出：{bottom}')
    save_png(canvas, SHOTS / '04-json-tools.png')


def compose_mock_data():
    canvas = shot_canvas(
        'MOCK DATA',
        '中文模拟数据批量生成',
        '人员、企业、招投标字段，JSON / CSV / SQL 导出，本地生成',
    )
    place_fit(canvas, screenshot('tool-mock-data').crop((0, 0, 1440, 660)), 1152, CONTENT_H)
    save_png(canvas, SHOTS / '05-mock-data.png')


def compose_element_picker():
    canvas = shot_canvas(
        'ELEMENT PICKER',
        '页面元素可视化拾取',
        '鼠标悬停匹配元素，点击即回填 CSS 选择器',
    )
    place_fit(canvas, screenshot('recipe-02-picker'), 1152, CONTENT_H)
    save_png(canvas, SHOTS / '06-element-picker.png')


def gradient(size, start, end):
    strip = Image.new('RGB', (1, size[1]))
    for y in range(size[1]):
        ratio = y / max(1, size[1] - 1)
        strip.putpixel((0, y), tuple(round(a + (b - a) * ratio) for a, b in zip(start, end)))
    return strip.resize(size, Image.Resampling.BILINEAR)


def mascot(height):
    source = Image.open(LOGO).convert('RGBA')
    ratio = height / source.height
    return source.resize((round(source.width * ratio), height), Image.Resampling.LANCZOS)


def promo_base(size):
    canvas = gradient(size, (79, 70, 229), (29, 78, 216)).convert('RGBA')
    glow = Image.new('RGBA', size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((size[0] * 0.55, -size[1] * 0.5, size[0] * 1.25, size[1] * 0.75), fill=(255, 255, 255, 38))
    gd.ellipse((-size[0] * 0.15, size[1] * 0.55, size[0] * 0.45, size[1] * 1.4), fill=(15, 23, 42, 60))
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(size[1] * 0.12)))
    return canvas


def compose_small_promo(with_text=True):
    size = (440, 280)
    canvas = promo_base(size)
    if with_text:
        draw = ImageDraw.Draw(canvas)
        draw.text((34, 98), 'ShadeKit', font=latin_font(44), fill='#ffffff')
        tracked(draw, (36, 158), 'BROWSER TOOLBOX', latin_font(11), (255, 255, 255, 225), 2.4)
        canvas.alpha_composite(mascot(196), (228, 42))
    else:
        art = mascot(224)
        canvas.alpha_composite(art, ((size[0] - art.width) // 2, (size[1] - art.height) // 2))
    name = 'small-promo-440x280.png' if with_text else 'small-promo-440x280-textless.png'
    save_png(canvas, PROMO / name)


def compose_marquee(with_text=True):
    size = (1400, 560)
    canvas = promo_base(size)
    if with_text:
        draw = ImageDraw.Draw(canvas)
        draw.text((90, 186), 'ShadeKit', font=latin_font(92), fill='#ffffff')
        tracked(draw, (94, 312), 'BROWSER DEVELOPER TOOLBOX', latin_font(17), (255, 255, 255, 225), 3.2)
        canvas.alpha_composite(mascot(360), (972, 96))
    else:
        art = mascot(400)
        canvas.alpha_composite(art, ((size[0] - art.width) // 2, (size[1] - art.height) // 2))
    name = 'marquee-1400x560.png' if with_text else 'marquee-1400x560-textless.png'
    save_png(canvas, PROMO / name)


def compose_icons():
    ICONS.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / 'public/logo_128.png', ICONS / 'icon-128.png')
    shutil.copyfile(LOGO, ICONS / 'icon-300.png')


def expected_assets():
    shots = {
        '01-account-switch': (1280, 800),
        '02-account-manager': (1280, 800),
        '03-generic-login': (1280, 800),
        '04-json-tools': (1280, 800),
        '05-mock-data': (1280, 800),
        '06-element-picker': (1280, 800),
    }
    assets = {SHOTS / f'{name}.png': size for name, size in shots.items()}
    assets[PROMO / 'small-promo-440x280.png'] = (440, 280)
    assets[PROMO / 'small-promo-440x280-textless.png'] = (440, 280)
    assets[PROMO / 'marquee-1400x560.png'] = (1400, 560)
    assets[PROMO / 'marquee-1400x560-textless.png'] = (1400, 560)
    assets[ICONS / 'icon-128.png'] = (128, 128)
    assets[ICONS / 'icon-300.png'] = (300, 300)
    return assets


def validate():
    problems = []
    for path, size in expected_assets().items():
        if not path.is_file():
            problems.append(f'缺少 {path.relative_to(OUT)}')
            continue
        with Image.open(path) as image:
            if image.size != size:
                problems.append(f'{path.relative_to(OUT)} 尺寸 {image.size}，应为 {size}')
            if image.format != 'PNG':
                problems.append(f'{path.relative_to(OUT)} 格式 {image.format}，应为 PNG')
            if path.stat().st_size > 2 * 1024 * 1024:
                problems.append(f'{path.relative_to(OUT)} 超过 2 MiB')
    if problems:
        raise ValueError('\n'.join(problems))
    print(f'{len(expected_assets())} 个商店素材尺寸与格式校验通过')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--validate', action='store_true', help='只校验商店素材尺寸与格式')
    args = parser.parse_args()
    if args.validate:
        validate()
        return
    if not RAW.is_dir():
        raise FileNotFoundError(f'缺少原始截图目录：{RAW}')
    for directory in (SHOTS, PROMO, ICONS):
        directory.mkdir(parents=True, exist_ok=True)
    compose_account_switch()
    compose_account_manager()
    compose_generic_login()
    compose_json_tools()
    compose_mock_data()
    compose_element_picker()
    compose_small_promo(with_text=True)
    compose_small_promo(with_text=False)
    compose_marquee(with_text=True)
    compose_marquee(with_text=False)
    compose_icons()
    validate()
    print(f'商店素材已输出到 {OUT}')


if __name__ == '__main__':
    main()
