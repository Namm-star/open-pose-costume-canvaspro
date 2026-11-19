export const CANVASPRO_ORIGIN = 'https://api.canvasproai.com';
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.6-sunburst-W';

const modelGroups = {
  'GPT Image · W': [
    'gpt-image-2.5-flare-W',
    'gpt-image-2.5-sunburst-W',
    'gpt-image-2.6-flare-W',
    'gpt-image-2.6-sunburst-W',
  ],
  'GPT Image · SR / FULL': [
    'gpt-image-2-SR',
    'gpt-image-2.5-SR',
    'gpt-image-2.6-SR',
    'gpt-image-2.5-flare-SR',
    'gpt-image-2.5-sunburst-SR',
    'gpt-image-2.6-flare-SR',
    'gpt-image-2.6-sunburst-SR',
    'gpt-image-2.5-flare-FULL',
    'gpt-image-2.5-sunburst-FULL',
  ],
  'GPT Image · KR': [
    'gpt-image-2',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.6-flare',
    'gpt-image-2.6-sunburst',
  ],
  'Gemini · KR': ['T香蕉2', 'T香蕉2.1', 'T香蕉pro'],
  'GPT Image · HC': ['s-gpt-image-2', 's-gpt-image-2.5-flare', 's-gpt-image-2.5-sunburst'],
  即梦: [
    '即梦-55-gpt-image-2',
    '即梦-55-gpt-image-2.5-flare',
    '即梦-55-gpt-image-2.5-sunburst',
    '即梦-55-gpt-image-2.6-flare-High',
    '即梦-55-gpt-image-2.6-sunburst-High',
    '即梦-66-gpt-image-2.5-flare',
    '即梦-66-gpt-image-2.5-sunburst',
    '即梦-67-gpt-image-2.5-flare',
    '即梦-67-gpt-image-2.5-sunburst',
    '即梦-52-gpt-image-2',
    '即梦-52-gpt-image-2.5-flare',
    '即梦-52-gpt-image-2.5-sunburst',
    '即梦-46-gpt-image-2',
    '即梦-46-gpt-image-2.5-flare',
    '即梦-46-gpt-image-2.5-sunburst',
    '即梦-23-gemini-nano-banana-2.1',
    '即梦-23-gemini-3-pro-image-preview',
    '即梦-23-gemini-3.1-flash-image-preview',
    '即梦-65-seedream-5-pro',
    '即梦-65-seedream-5-lite',
    '即梦-65-seedream-5.5',
  ],
};
export const imageModelGroups = Object.entries(modelGroups);

const imageModels = new Set(Object.values(modelGroups).flat());
export const isImageModel = (id: string) => imageModels.has(id);

export type ImageQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const basicQualities: ImageQuality[] = ['auto', 'low', 'medium', 'high'];
const extendedQualities: ImageQuality[] = [...basicQualities, 'xhigh', 'max'];
const pixelSizes = [
  'auto',
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '2048x2048',
  '1152x2048',
  '2048x1152',
  '2160x3840',
  '3840x2160',
];
const resolutions = ['1K', '2K', '4K'];
const geminiRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const jimengRatios = ['1:1', '3:4', '4:3', '9:16', '16:9'];

export function imageProtocol(model: string) {
  if (model.startsWith('即梦-')) return 'jimeng';
  if (model.startsWith('T香蕉')) return 'gemini';
  if (model.startsWith('s-gpt-')) return 'hc';
  if (model === 'gpt-image-2') return 'kr';
  if (model.endsWith('-W') || /-(SR|FULL)$/.test(model)) return 'sync';
  return 'kr-gpt';
}

export function imageSizesForModel(model: string): string[] {
  const protocol = imageProtocol(model);
  if (protocol === 'jimeng') {
    const supported = model.endsWith('seedream-5-pro')
      ? ['1K', '2K']
      : model.endsWith('seedream-5-lite')
        ? ['2K', '4K']
        : model.endsWith('seedream-5.5')
          ? ['2K']
          : resolutions;
    return jimengRatios.flatMap((ratio) => supported.map((size) => `${ratio} · ${size}`));
  }
  if (protocol === 'gemini') {
    const ratios =
      model === 'T香蕉pro' ? geminiRatios : [...geminiRatios, '1:4', '4:1', '1:8', '8:1'];
    return ratios.flatMap((ratio) => resolutions.map((size) => `${ratio} · ${size}`));
  }
  if (protocol === 'hc')
    return pixelSizes.filter((size) => !['2160x3840', '3840x2160'].includes(size));
  if (/-(SR|FULL)$/.test(model)) return pixelSizes.slice(0, 4);
  return pixelSizes;
}

export function portraitSizeForModel(model: string): string {
  const sizes = imageSizesForModel(model);
  return (
    ['1024x1536', '2:3 · 1K', '3:4 · 1K', '3:4 · 2K'].find((size) => sizes.includes(size)) ??
    sizes[0]
  );
}

export function imageQualitiesForModel(model: string): ImageQuality[] {
  const protocol = imageProtocol(model);
  if (protocol === 'gemini' || protocol === 'jimeng' || /-(SR|FULL)$/.test(model)) return [];
  if (protocol === 'kr' || model === 's-gpt-image-2') return basicQualities;
  return extendedQualities;
}
