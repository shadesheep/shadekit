from pathlib import Path
from io import BytesIO
import tempfile
import unittest

from PIL import Image

from compose import (
    crop_recipe_source,
    ensure_login_recipe_layout,
    gif_duration,
    resolve_switch_video,
    validate_media,
    tool_crop,
    tool_panel,
)


class ComposeTests(unittest.TestCase):
    def test_recipe_crops_fit_three_432px_columns(self):
        sources = {
            'recipe-01-environment': Image.new('RGB', (560, 900), 'white'),
            'recipe-02-picker': Image.new('RGB', (1440, 900), 'white'),
            'recipe-03-trial': Image.new('RGB', (560, 900), 'white'),
        }
        self.assertEqual(ensure_login_recipe_layout(sources), [(432, 608), (432, 608), (432, 608)])

    def test_recipe_rejects_missing_real_source(self):
        with self.assertRaisesRegex(ValueError, 'recipe-02-picker'):
            ensure_login_recipe_layout({'recipe-01-environment': Image.new('RGB', (560, 900))})

    def test_recipe_excludes_the_demo_password_hint(self):
        source = Image.new('RGB', (1440, 900), 'white')
        actual = crop_recipe_source('recipe-02-picker', source)
        expected = source.crop((876, 164, 1356, 565))
        self.assertEqual(actual.size, (480, 401))
        self.assertEqual(actual.tobytes(), expected.tobytes())

    def test_recipe_crops_stop_after_complete_sections(self):
        source = Image.new('RGB', (560, 900), 'white')
        self.assertEqual(crop_recipe_source('recipe-01-environment', source).size, (560, 608))
        self.assertEqual(crop_recipe_source('recipe-03-trial', source).size, (560, 660))

    def test_gif_duration_sums_each_frame(self):
        image = Image.new('P', (40, 40), 0)
        output = BytesIO()
        image.save(output, 'GIF', save_all=True, append_images=[image] * 2, duration=[100, 250, 50])
        output.seek(0)
        with Image.open(output) as gif:
            self.assertEqual(gif_duration(gif), 0.4)

    def test_gif_requires_a_verified_recording_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, 'verified-switch-video.json'):
                resolve_switch_video(root, None)
            candidate = root / 'switch.webm'
            candidate.write_bytes(b'not empty')
            manifest = root / 'verified-switch-video.json'
            manifest.write_text('{"roleSwitchVerified": false, "startRole": "tester", "finalRole": "admin"}')
            with self.assertRaisesRegex(ValueError, 'roleSwitchVerified'):
                resolve_switch_video(root, None)
            manifest.write_text('{"roleSwitchVerified": true, "startRole": "tester", "finalRole": "admin", "videoPath": "' + str(candidate) + '"}')
            self.assertEqual(resolve_switch_video(root, None), str(candidate))
            self.assertEqual(resolve_switch_video(root, str(candidate)), str(candidate))
            with self.assertRaisesRegex(ValueError, 'videoPath'):
                resolve_switch_video(root, str(root / 'other.webm'))

    def test_stale_switch_manifest_is_invalidated_before_recording(self):
        source = Path(__file__).with_name('capture.mjs').read_text()
        block = source.split("const video = MODE === 'record' || MODE === 'all';", 1)[1].split('let switchVideoManifest', 1)[0]
        self.assertIn('if (video) await rm(MANIFEST, { force: true });', block)

    def test_recording_does_not_mask_original_errors_with_manifest_cleanup(self):
        source = Path(__file__).with_name('capture.mjs').read_text()
        finally_block = source.rsplit('} finally {', 1)[1].split('\n}', 1)[0]
        self.assertNotIn('throw new Error', finally_block)
        manifest_write = source.split('if (switchVideoManifest) {', 1)[1]
        self.assertIn('throw new Error', manifest_write)

    def test_recording_starts_from_the_tester_console_without_extra_navigation(self):
        source = Path(__file__).with_name('capture.mjs').read_text()
        block = source.split('async function recordSwitch()', 1)[1].split('async function setCodeMirror', 1)[0]
        preparation, recording = block.split('const page = await context.newPage();', 1)
        self.assertIn('const response = await context.request.post', preparation)
        self.assertIn("await context.addCookies([{ name: 'shadesheep_session'", preparation)
        self.assertNotIn("await page.fill('#username'", recording)
        self.assertNotIn("await page.goto(`${config.origin}/login`)", recording)
        self.assertIn("await page.goto(`${config.origin}/console`)", recording)
        self.assertIn("document.body.dataset.currentRole === 'tester'", recording)
        self.assertIn("document.body.dataset.currentRole === 'admin'", recording)

    def test_tool_crops_keep_controls_and_results_at_full_width(self):
        source = Image.new('RGB', (1440, 900), 'white')
        self.assertEqual(tool_crop('tool-json-format', source).size, (1440, 522))
        self.assertEqual(tool_crop('tool-json-diff', source).size, (1440, 300))
        self.assertEqual(tool_crop('tool-mock-data', source).size, (1440, 460))
        with self.assertRaisesRegex(ValueError, '1440×900'):
            tool_crop('tool-json-diff', Image.new('RGB', (375, 900)))

    def test_tool_panels_use_the_same_full_width(self):
        source = Image.new('RGB', (1440, 900), 'white')
        crops = (
            tool_crop('tool-json-format', source),
            tool_crop('tool-json-diff', source),
            tool_crop('tool-mock-data', source),
        )
        panels = [tool_panel(crop) for crop in crops]
        self.assertTrue(all(panel.width == 1368 for panel in panels))
        self.assertEqual([panel.height for panel in panels], [496, 285, 437])
        self.assertEqual(sum(panel.height for panel in panels), 1218)

    def test_delivery_validation_requires_all_four_media(self):
        with self.assertRaisesRegex(ValueError, 'hero.webp'):
            validate_media(Path('/tmp/shadekit-media-validation-does-not-exist'))


if __name__ == '__main__':
    unittest.main()
