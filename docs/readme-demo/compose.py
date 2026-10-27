"""Create publishable ShadeKit README images from real captured UI.

Requires Pillow. No extension interface is drawn here; screenshots are only
cropped, resized, framed, and captioned. Raw sources stay git-ignored.
"""
from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RAW = Path(os.environ.get('SHADEKIT_DEMO_RAW', ROOT / 'docs/images/raw'))
OUTPUT = ROOT / 'docs/images'
RECIPE_NAMES = ('recipe-01-environment', 'recipe-02-picker', 'recipe-03-save')
MEDIA = ('hero.webp', 'login-recipe.webp', 'dev-tools.webp', 'account-switch.gif')
CANVAS = '#0d1117'
INK = '#f1f5f9'
MUTED = '#9aa7b8'
LINE = '#30363d'
INDIGO = '#a5b4fc'


def font(size):
    paths = list(Path('/System/Library/AssetsV2').rglob('PingFang.ttc'))
    paths += [Path('/System/Library/Fonts/PingFang.ttc'), Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')]
    path = next((p for p in paths if p.is_file()), None)
    if not path:
        raise FileNotFoundError('需要支持中文的 PingFang 或 Arial Unicode 字体')
    return ImageFont.truetype(str(path), size, index=2)


def save_webp(image, name):
    image.save(OUTPUT / name, 'WEBP', quality=90, method=6)


def heading(draw, eyebrow, title, subtitle):
    draw.text((44, 26), eyebrow, font=font(12), fill=INDIGO)
    draw.text((44, 53), title, font=font(31), fill=INK)
    draw.text((45, 99), subtitle, font=font(16), fill=MUTED)


def cover(image, size, align='center'):
    ratio = max(size[0] / image.width, size[1] / image.height)
    resized = image.resize((round(image.width * ratio), round(image.height * ratio)), Image.Resampling.LANCZOS)
    x = (resized.width - size[0]) // 2
    y = {'top': 0, 'center': (resized.height - size[1]) // 2, 'bottom': resized.height - size[1]}[align]
    return resized.crop((x, y, x + size[0], y + size[1]))


def paste_rounded(canvas, image, box, radius=10, shadow=True):
    x, y = box
    if shadow:
        shadow_image = Image.new('RGBA', canvas.size)
        sd = ImageDraw.Draw(shadow_image)
        sd.rounded_rectangle((x + 2, y + 5, x + image.width + 2, y + image.height + 5), radius, fill='#00000066')
        canvas.alpha_composite(shadow_image.filter(ImageFilter.GaussianBlur(7)))
    mask = Image.new('L', image.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width, image.height), radius, fill=255)
    canvas.paste(image.convert('RGBA'), box, mask)
    ImageDraw.Draw(canvas).rounded_rectangle((x, y, x + image.width - 1, y + image.height - 1), radius, outline=LINE)


def screenshot(name):
    path = RAW / f'{name}.png'
    if not path.is_file():
        raise FileNotFoundError(f'缺少真实截图：{path}；先运行 capture.mjs')
    return Image.open(path).convert('RGB')


def ensure_login_recipe_layout(sources):
    """Return three independent crop sizes; never pad with fabricated UI."""
    missing = [name for name in RECIPE_NAMES if name not in sources]
    if missing:
        raise ValueError(f'缺少配方真实截图：{", ".join(missing)}')
    for name in RECIPE_NAMES:
        image = sources[name]
        if name == 'recipe-02-picker' and image.size != (1440, 900):
            raise ValueError('元素拾取图必须来自 1440×900 登录页')
        if name != 'recipe-02-picker' and image.width != 560:
            raise ValueError(f'{name} 应为真实 560px 宽抽屉截图')
    return [(432, 608), (432, 608), (432, 608)]


def crop_recipe_source(name, image):
    """Keep the real form/picker and omit the demo page's password hint."""
    if name == 'recipe-02-picker':
        return image.crop((876, 164, 1356, 565))
    bottom = {'recipe-01-environment': 608, 'recipe-03-save': 608}[name]
    return image.crop((0, 0, 560, bottom))


def compose_hero():
    canvas = Image.new('RGBA', (1440, 1120), CANVAS)
    draw = ImageDraw.Draw(canvas)
    heading(draw, 'SHADEKIT  /  BROWSER TOOLBOX', '账号切换，少一步打断。', '网页内切换角色 · 自动完成登录 · 环境始终可见')
    source = screenshot('hero-source')
    paste_rounded(canvas, source.resize((1368, 855), Image.Resampling.LANCZOS), (36, 156))
    draw.text((37, 1080), '真实 ShadeKit 界面  /  本地虚构演示系统  /  不含真实账号或业务数据', font=font(13), fill=MUTED)
    save_webp(canvas, 'hero.webp')


def compose_recipe():
    sources = {name: screenshot(name) for name in RECIPE_NAMES}
    sizes = ensure_login_recipe_layout(sources)
    canvas = Image.new('RGBA', (1440, 972), CANVAS)
    draw = ImageDraw.Draw(canvas)
    heading(draw, 'GENERIC LOGIN RECIPE', '通用登录配方，三步接入。', '识别登录表单，拾取页面元素，再保存配置；目标系统无需改代码')
    labels = [('01', '添加环境', '通用登录 · 配置登录页'), ('02', '识别并拾取', '自动识别 · 页面可视化选择'), ('03', '保存配置', '声明式配方 · 本地保存')]
    for index, (number, title, caption) in enumerate(labels):
        x = 36 + index * 468
        y = 166
        name = RECIPE_NAMES[index]
        if name == 'recipe-02-picker':
            source = Image.new('RGB', sizes[index], CANVAS)
            scan = screenshot('recipe-02-scan').crop((12, 602, 548, 840)).resize((418, 177), Image.Resampling.LANCZOS)
            picker = crop_recipe_source(name, sources[name]).resize((418, 350), Image.Resampling.LANCZOS)
            paste_rounded(source, scan, (7, 7), radius=7, shadow=False)
            paste_rounded(source, picker, (7, 244), radius=7, shadow=False)
            draw.text((x + 10, y + 197), '识别结果', font=font(11), fill=MUTED)
            draw.text((x + 10, y + 220), '页面拾取', font=font(11), fill=MUTED)
        else:
            source = crop_recipe_source(name, sources[name]).resize(sizes[index], Image.Resampling.LANCZOS)
        paste_rounded(canvas, source, (x, y))
        draw.text((x + 3, y + 628), number, font=font(14), fill=INDIGO)
        draw.text((x + 39, y + 620), title, font=font(23), fill=INK)
        draw.text((x + 39, y + 658), caption, font=font(13), fill=MUTED)
    draw.text((37, 940), '配置页与元素拾取均为真实界面  /  演示身份与站点均为虚构', font=font(13), fill=MUTED)
    save_webp(canvas, 'login-recipe.webp')


def tool_crop(name, image):
    """Retain the actual toolbar and result region; omit unused page height."""
    if image.size != (1440, 900):
        raise ValueError(f'{name} 必须来自 1440×900 真实工具页')
    bottom = {'tool-json-format': 522, 'tool-json-diff': 300, 'tool-mock-data': 460}[name]
    return image.crop((0, 0, 1440, bottom))


def tool_panel(image):
    return image.resize((1368, round(image.height * 0.95)), Image.Resampling.LANCZOS)


def compose_tools():
    canvas = Image.new('RGBA', (1440, 1645), CANVAS)
    draw = ImageDraw.Draw(canvas)
    heading(draw, 'LOCAL DEVELOPER TOOLS', '常用开发工具，就在浏览器里。', '格式化、对比与测试数据生成，本地运行，无需上传')
    panels = (
        ('01', 'tool-json-format', 'JSON 格式化 · 语法高亮与结构校验'),
        ('02', 'tool-json-diff', 'JSON 对比 · 五处差异高亮'),
        ('03', 'tool-mock-data', '模拟数据 · 用户信息表格'),
    )
    y = 150
    for number, name, title in panels:
        image = tool_panel(tool_crop(name, screenshot(name)))
        draw.text((37, y), number, font=font(18), fill=INDIGO)
        draw.text((76, y - 3), title, font=font(22), fill=INK)
        paste_rounded(canvas, image, (36, y + 40))
        y += image.height + 82
    draw.text((37, 1607), '三个真实独立工具页  /  裁掉未使用页面区域，保留完整工具栏与主要结果', font=font(13), fill=MUTED)
    save_webp(canvas, 'dev-tools.webp')


def gif_duration(gif):
    return sum((gif.seek(i), gif.info.get('duration', 0))[1] for i in range(gif.n_frames)) / 1000


def resolve_switch_video(raw, explicit):
    manifest_path = Path(raw) / 'verified-switch-video.json'
    if explicit:
        if not manifest_path.is_file():
            raise ValueError('显式录像也必须对应 verified-switch-video.json 角色验证清单')
    elif not manifest_path.is_file():
        raise ValueError('缺少 verified-switch-video.json；请先通过真实角色切换录制')
    manifest = json.loads(manifest_path.read_text())
    if manifest.get('roleSwitchVerified') is not True:
        raise ValueError('roleSwitchVerified 必须为 true，不能用失败录像生成 GIF')
    if manifest.get('startRole') != 'tester' or manifest.get('finalRole') != 'admin':
        raise ValueError('录像必须验证 tester → admin 的真实角色变化')
    if manifest.get('visibleAccountSwitchVerified') is not True:
        raise ValueError('visibleAccountSwitchVerified 必须为 true，不能用账号变化不可见的录像生成 GIF')
    if manifest.get('startAccount') != 'tester@shadesheep.test' or manifest.get('finalAccount') != 'admin@shadesheep.test':
        raise ValueError('录像必须验证可见账号 tester@shadesheep.test → admin@shadesheep.test')
    if explicit:
        if str(Path(explicit).resolve()) != str(Path(manifest.get('videoPath', '')).resolve()):
            raise ValueError('显式录像与已验证角色切换的 videoPath 不一致')
        source = explicit
    else:
        source = manifest.get('videoPath')
    if not source or not Path(source).is_file() or Path(source).stat().st_size == 0:
        raise ValueError('已验证的 WebM 不存在或为空；请重新录制')
    return str(source)


def encode_gif():
    ffmpeg = os.environ.get('FFMPEG_PATH') or shutil.which('ffmpeg')
    if not ffmpeg:
        raise FileNotFoundError('请设置 FFMPEG_PATH 指向 FFmpeg 可执行文件')
    source = resolve_switch_video(RAW, os.environ.get('SHADEKIT_DEMO_SWITCH_VIDEO'))
    destination = OUTPUT / 'account-switch.gif'
    filters = 'crop=1200:750:240:0,fps=10,scale=1152:720:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle'
    subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'warning', '-y', '-i', source, '-filter_complex', filters, '-loop', '0', str(destination)], check=True)
    with Image.open(destination) as gif:
        duration = gif_duration(gif)
        if gif.size != (1152, 720) or not 8 <= duration <= 15:
            raise ValueError(f'GIF 尺寸/时长不合格：{gif.size}，{duration:.2f}s')
        print(f'account-switch.gif: {gif.n_frames} frames, {duration:.2f}s, {destination.stat().st_size / 1048576:.2f} MiB')


def validate_media(output=OUTPUT):
    missing = [name for name in MEDIA if not (Path(output) / name).is_file()]
    if missing:
        raise ValueError(f'缺少最终素材：{", ".join(missing)}')
    for name in MEDIA:
        path = Path(output) / name
        with Image.open(path) as image:
            if name.endswith('.webp') and image.width != 1440:
                raise ValueError(f'{name} 宽度不是 1440px')
            if name.endswith('.gif'):
                if image.size != (1152, 720):
                    raise ValueError('GIF 尺寸不是 1152×720')
                if not (8 <= gif_duration(image) <= 15):
                    raise ValueError('GIF 时长不在 8–15 秒')
                if path.stat().st_size > 8 * 1024 * 1024:
                    raise ValueError('GIF 超过 8 MiB')
        if path.stat().st_size == 0:
            raise ValueError(f'{name} 为空')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gif', action='store_true', help='同时编码真实账号切换录像')
    parser.add_argument('--gif-only', action='store_true', help='只从已验证录像重新编码 GIF，不重排静态图')
    parser.add_argument('--validate', action='store_true', help='仅检查四项最终素材')
    args = parser.parse_args()
    if args.validate:
        validate_media()
        print('四项配图文件完整')
        return
    OUTPUT.mkdir(parents=True, exist_ok=True)
    if args.gif_only:
        encode_gif()
        print(f'GIF 已输出到 {OUTPUT / "account-switch.gif"}')
        return
    compose_hero()
    compose_recipe()
    compose_tools()
    if args.gif:
        encode_gif()
    print(f'配图已输出到 {OUTPUT}')


if __name__ == '__main__':
    main()
