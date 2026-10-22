# Hungry whale

The black Harness whale opens its mouth around the ChatGPT knot. The original
whale contour and knot path are retained, with a new mouth cutout and eye.
The mark is monochrome; in the UI it follows the host's foreground color.
This is this community plugin's identity, not an official joint product mark.

`logo.svg` is the standalone vector; `../icon.svg` is the packaged Harness icon.
The React version preserves `currentColor` and uses a unique mask ID per instance.

Source SVGs downloaded on 2026-10-23:

- `reference/chatgpt.svg`: [OpenAI knot, Simple Icons v14](https://github.com/simple-icons/simple-icons/blob/14.0.0/icons/openai.svg), CC0. OpenAI retains its trademark rights.
- `reference/deepseek-harness.svg`: [Harness favicon](https://github.com/deepseek-ai/deepseek-harness/blob/master/website/public/favicon.svg), from the Harness source repository. DeepSeek retains its trademark rights.

The source SVGs remain in `reference/`; the derived whale contour, mouth cutout,
and knot are in `src/client/logo.ts`. No raster assets are used.
