# Open Pose & Costume · Local AI CanvasPro Edition

[简体中文](README.md)

A local reference-image studio based on Hongye's [Open Pose & Costume](https://github.com/hongye007/open-pose-costume). It brings pose, outfit, and character references into one bilingual workspace for drawing, character design, and AI image generation.

## Upstream project and credits

- Open Pose & Costume provides the reference gallery, multi-angle poses with depth maps for some entries, favorites, the pairing board, prompt composition, and image comparison. [Upstream repository](https://github.com/hongye007/open-pose-costume) · [Hongye](https://x.com/HongyeMain) · [Original website](https://omilic.com/) · [Upstream companion Skill](https://github.com/hongye007/open-pose-costume-skill)
- This edition is based on upstream commit `16e378aaf0dd021b8e06001b4e1ed781580287ba`. Hongye and the upstream contributors maintain the original project. Namm-star maintains this repository. [Upstream source at that commit](https://github.com/hongye007/open-pose-costume/tree/16e378aaf0dd021b8e06001b4e1ed781580287ba)
- Reference sources include ギア's pose, costume, and depth-map galleries, あぎ's portrait gallery, and Chinese pose titles contributed by Anhao. The upstream source and licensing records provide the complete attribution. [Asset sources](SOURCES.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## Changes in this edition

- Image Settings integrates the AI CanvasPro image models used for synchronous and asynchronous reference-image generation and outfit extraction. Configure your API key, model, size, and quality in the app. [AI CanvasPro API documentation](https://api.canvasproai.com/docs)
- A local Vite relay forwards reference images and model requests. The UI shows preparation, submission, waiting, and download stages, along with errors from the provider.
- Async results can be retrieved by task ID. A transient result-download error triggers one automatic retry, and the UI also supports manual retrieval. Side-by-side and overlay comparison work for recovered tasks with saved references.
- The API key is blank by default. A configured key stays in the current browser session unless you choose to remember it in that browser. Generating an image or extracting an outfit sends the selected references and prompt to AI CanvasPro.

## Run locally

Use Node.js 22.12 or later. Run these commands from the repository:

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:5199](http://127.0.0.1:5199), then enter your AI CanvasPro API key in the generation studio's **Image Settings**. Select a model and save the settings. Local setup requires no `.env` file. Vite provides the relay for local requests. A static deployment needs a corresponding relay to generate images.

### Set up the local gallery

This repository contains the code and licensing notices. The full gallery needs local copies of the assets you are authorized to use. A fresh checkout will show a gallery loading error until its catalog is available. Copy the following paths from an authorized local copy of the upstream project into the same paths here:

| Upstream path | Purpose |
| --- | --- |
| `public/data/catalog.json` | Gallery index, including image URLs loaded on demand from their original sites |
| `public/custom/` | Custom references listed in the catalog, subject to their own usage terms |
| `public/brand/`, `public/images/`, `public/guide/`, and icons in `public/` | Optional home page, guide, and icon media |
| Gallery manifests and source data under `data/` | Required by the upstream catalog build scripts and full test suite. Add them alongside the tracked vocabulary and notices |

An existing local gallery can be used in place. Git ignore rules cover the external gallery files.

## Build and test

```sh
npm run test:code
npm run build
```

The code tests use simulated endpoints and local test images to check reference transport, async result recovery, and image settings. They require no provider key. Once local catalog and gallery files are in place, `npm test` also checks data, catalog entries, and filters.

## License

The application code, scripts, tests, and project documentation use the upstream MIT license. The upstream copyright and license notice are retained. Images, third-party catalog data, and translations have separate terms. Redistribution and commercial use of the custom reference assets require separate permission. [Code license](LICENSE) · [Custom asset terms](public/custom/LICENSE.txt) · [Asset sources and permissions](SOURCES.md)
