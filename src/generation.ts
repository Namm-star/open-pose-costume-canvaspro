import { editCanvasProImage, ImageGenerationError, readCanvasProTask } from './canvaspro-client';
import type { ImageGenerationProgress } from './canvaspro-client';
import {
  DEFAULT_IMAGE_MODEL,
  imageProtocol,
  imageQualitiesForModel,
  imageSizesForModel,
  isImageModel,
  portraitSizeForModel,
} from './canvaspro-models';
import type { ImageQuality } from './canvaspro-models';
import type { Kind, Lang, Reference, Variant } from './types';
import { isDepthVariant, poseDepthOrigin } from './pose-depth';
import { isCustomAsset } from './custom-assets';
import { prepareCanvasProReference } from './canvaspro-reference';

export { ImageGenerationError };
export { imageResult, isCanvasProTaskId } from './canvaspro-client';

export interface ImageConfig {
  apiKey: string;
  model: string;
  size: string;
  quality: ImageQuality;
  rememberKey: boolean;
}

interface ReferenceDetails {
  title: Reference['title'];
  keywords: Reference['keywords'];
  variant: Variant;
}
export interface GalleryImageReference extends ReferenceDetails {
  kind: Kind;
}
export interface UploadedImageReference extends ReferenceDetails {
  kind: 'character' | 'costume';
  file: File;
}
export type ImageReference = GalleryImageReference | UploadedImageReference;
export interface GenerationJob {
  model: string;
  references: ImageReference[];
  prompt: string;
  status: 'loading' | 'error' | 'success' | 'cancelled';
  progress?: ImageGenerationProgress;
  result?: string;
  error?: string;
  platformMessage?: string;
  diagnostic?: string;
  size?: string;
  quality?: ImageConfig['quality'];
  restored?: boolean;
}

const SETTINGS_KEY = 'opc-image-settings';
const SESSION_KEY = 'opc-image-session-key-canvaspro';

export const defaultImageConfig: ImageConfig = {
  model: DEFAULT_IMAGE_MODEL,
  size: portraitSizeForModel(DEFAULT_IMAGE_MODEL),
  quality: 'auto',
  apiKey: '',
  rememberKey: false,
};

export function normalizeImageConfig(config: ImageConfig): ImageConfig {
  const apiKey = config.apiKey.trim();
  if (!apiKey || !/^[\x21-\x7e]+$/.test(apiKey)) throw Error('missingConfig');
  const qualities = imageQualitiesForModel(config.model);
  if (
    !isImageModel(config.model) ||
    !imageSizesForModel(config.model).includes(config.size) ||
    !(qualities.length ? qualities.includes(config.quality) : config.quality === 'auto')
  )
    throw Error('invalidConfig');
  return { ...config, apiKey };
}

export function imageConfigReady(config: ImageConfig): boolean {
  try {
    normalizeImageConfig(config);
    return true;
  } catch {
    return false;
  }
}

export function loadImageConfig(): ImageConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved?.version !== 3 || !isImageModel(saved.model)) return { ...defaultImageConfig };
    const rememberKey = saved.rememberKey === true;
    const key = rememberKey ? saved.apiKey : sessionStorage.getItem(SESSION_KEY);
    const qualities = imageQualitiesForModel(saved.model);
    return {
      model: saved.model,
      size: imageSizesForModel(saved.model).includes(saved.size)
        ? saved.size
        : portraitSizeForModel(saved.model),
      quality: qualities.includes(saved.quality) ? saved.quality : 'auto',
      apiKey: typeof key === 'string' ? key : '',
      rememberKey,
    };
  } catch {
    return { ...defaultImageConfig };
  }
}

export function saveImageConfig(config: ImageConfig): ImageConfig {
  const valid = normalizeImageConfig(config);
  const { apiKey, ...settings } = valid;
  if (valid.rememberKey) sessionStorage.removeItem(SESSION_KEY);
  else sessionStorage.setItem(SESSION_KEY, apiKey);
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      version: 3,
      ...settings,
      ...(valid.rememberKey ? { apiKey } : {}),
    }),
  );
  return valid;
}

export function clearImageConfig() {
  localStorage.removeItem(SETTINGS_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem('opc-image-session-key');
  sessionStorage.removeItem('opc-image-session-key-openwego');
  sessionStorage.removeItem('opc-image-session-key-atomflow');
}

export function referencePrompt(references: ImageReference[], lang: Lang): string {
  const hasCharacter = references.some((ref) => ref.kind === 'character');
  const roles = {
    pose: {
      zh: '仅采用此图当前展示的动作与单一观察角度。保持头部朝向、肩胯方向、肘腕位置、手势、腿部弯曲及遮挡关系，不擅自把双手移到身后。取景范围跟随此图。',
      en: "Use only the pose and single viewpoint shown in this image. Preserve head direction, shoulder and hip orientation, elbows, wrists, hand gestures, bent legs and occlusion. Do not move the hands behind the back unless shown. Match this image's framing.",
    },
    costume: {
      zh: '仅提取可见服饰、鞋履及配饰的款式、颜色、材质与穿戴方式，穿到同一个人物身上；不复制陈列布局、空白间距或隐形人台外观。',
      en: 'Transfer only the visible garments, footwear and accessories, including design, colors, materials and placement, onto the same person. Do not copy the product arrangement, empty spacing or ghost-mannequin appearance.',
    },
    character: {
      zh: '仅保留此人物的身份、五官、脸型、发型发色、肤色与画风；不复制人物参考的动作、服饰或头像裁切，不额外生成头像或其他视角。',
      en: "Preserve only this person's identity, facial features, face shape, hairstyle, hair color, skin tone and visual style. Do not copy this reference's pose, clothing or portrait crop, or add separate portraits or other views.",
    },
  };
  const details = references
    .map((ref, index) => {
      // Catalog keywords describe discovery and batches, not generation instructions.
      const detail =
        lang === 'zh'
          ? `参考图 ${index + 1}（${ref.kind === 'pose' ? '姿势' : ref.kind === 'costume' ? '服装' : '人物'}）：${roles[ref.kind].zh}`
          : `Reference ${index + 1} (${ref.kind}): ${roles[ref.kind].en}`;
      if (ref.kind !== 'pose' || !isDepthVariant(ref.variant)) return detail;
      return `${detail} ${
        lang === 'zh'
          ? '此图为深度图，越亮越靠近镜头。仅参考动作、透视与遮挡关系，不复制灰度、深色背景或人偶外观。'
          : 'This is a depth map: brighter areas are closer to the camera. Use only its pose, perspective and occlusion; do not copy the grayscale, dark background or mannequin appearance.'
      }`;
    })
    .join('\n');
  const output =
    lang === 'zh'
      ? '最终输出只有一张连续画面、一个人物、一个选定视角。禁止多面板、分栏、分镜、角色设定页、局部特写插图、其他角度附图或重复人物。所有参考信息融合到这一个人物中。'
      : 'Final output: one continuous scene, one person and one selected viewpoint only. No panels, columns, storyboards, character sheets, inset close-ups, additional-angle images or repeated people. Combine all references into that one person.';
  if (hasCharacter)
    return lang === 'zh'
      ? `结合所附参考图创作一幅完整的人物图。人物参考决定身份与画风：保留其五官、脸型、发型发色、肤色与体型比例；姿势参考只决定动作、重心与观察角度，不迁移人偶线条和关节；服装参考只决定穿搭、颜色、版型与材质，不迁移服装模特的脸和站姿。让服装随动作自然形变，人物完整着装，背景简洁，不添加文字或水印，不制作拼贴或对照图。\n${details}\n${output}`
      : `Create one complete character image from the attached references. Use the character reference for identity and visual style, preserving the face, hairstyle, hair color, skin tone and body proportions. Use the pose reference only for gesture, balance and viewpoint, without mannequin lines or joints. Use the costume reference only for outfit, colors, garment shape and materials, without copying the outfit model's face or stance. Make clothing drape naturally with the pose. Keep the character fully clothed, with a simple background and no text, watermark, collage or comparison layout.\n${details}\n${output}`;
  return lang === 'zh'
    ? `结合所附参考图创作一幅完整的角色插画。遵循姿势参考的动作与重心，保留服装参考的穿搭与材质细节；角色完整着装，背景简洁，不添加文字或水印。\n${details}\n${output}`
    : `Create a finished character illustration from the attached references. Follow the pose and balance of the pose reference and the garment and material details of the costume reference. Keep the character fully clothed, with a simple background and no text or watermark.\n${details}\n${output}`;
}

export async function validateReferenceFile(
  file: File,
  kind: 'character' | 'costume',
): Promise<void> {
  if (file.size > 10 * 1024 * 1024) throw new ImageGenerationError(`${kind}TooLarge`);
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const signature = String.fromCharCode(...bytes);
  const mime = signature.startsWith('\x89PNG\r\n\x1a\n')
    ? 'image/png'
    : signature.startsWith('\xff\xd8\xff')
      ? 'image/jpeg'
      : signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP'
        ? 'image/webp'
        : '';
  if (!mime || mime !== file.type) throw new ImageGenerationError(`${kind}Invalid`);
}

export async function generateReferenceImage(
  config: ImageConfig,
  references: ImageReference[],
  prompt: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<string> {
  const valid = normalizeImageConfig(config);
  if (!references.length || !prompt.trim()) throw new ImageGenerationError('missingReference');
  const protocol = imageProtocol(valid.model);
  const maxReferences = { sync: 16, kr: 16, 'kr-gpt': 16, gemini: 14, hc: 15, jimeng: 6 }[protocol];
  if (references.length > maxReferences) throw new ImageGenerationError('referenceFailed');
  const maxImageMiB = valid.model.endsWith('-W')
    ? 48
    : protocol === 'gemini'
      ? 12
      : protocol === 'jimeng'
        ? 24
        : 10;
  const timeout = AbortSignal.timeout(protocol === 'sync' ? 600_000 : 1_800_000);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    onProgress?.({ stage: 'readingReferences' });
    const galleryUrls = references.map((reference) => {
      if ('file' in reference) return '';
      const url = new URL(reference.variant.original);
      const allowedOrigins = [
        'https://ai-' +
          (reference.kind === 'character' ? 'portrait' : reference.kind) +
          '-gallery.pages.dev',
        ...(reference.kind === 'costume' ? ['https://ai-costume-anime-gallery.pages.dev'] : []),
        ...(reference.kind === 'pose' ? [poseDepthOrigin] : []),
      ];
      if (
        url.username ||
        url.password ||
        (!allowedOrigins.includes(url.origin) && !isCustomAsset(url.href, reference.kind))
      )
        throw new ImageGenerationError('referenceFailed');
      return url.href;
    });
    for (const reference of references) {
      if ('file' in reference) await validateReferenceFile(reference.file, reference.kind);
    }
    const images = await Promise.all(
      references.map(async (reference, index) => {
        combined.throwIfAborted();
        if ('file' in reference) {
          const extension =
            reference.file.type === 'image/jpeg'
              ? 'jpg'
              : reference.file.type.slice('image/'.length);
          return new File([reference.file], reference.kind + '-upload.' + extension, {
            type: reference.file.type,
          });
        }
        const response = await fetcher(galleryUrls[index], {
          signal: combined,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        }).catch((error) => {
          if (combined.aborted) throw error;
          throw new ImageGenerationError('referenceFailed');
        });
        if (!response.ok)
          throw new ImageGenerationError('referenceFailed', 'HTTP ' + response.status);
        const blob = await response.blob();
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[
          blob.type
        ];
        if (!extension || !blob.size || blob.size > maxImageMiB * 1024 * 1024)
          throw new ImageGenerationError('referenceFailed');
        return new File([blob], reference.variant.id + '.' + extension, { type: blob.type });
      }),
    );
    combined.throwIfAborted();
    const prepared = await Promise.all(images.map(prepareCanvasProReference)).catch(() => {
      throw new ImageGenerationError('referencePreparationFailed');
    });
    combined.throwIfAborted();
    return await editCanvasProImage(valid, prepared, prompt.trim(), combined, fetcher, onProgress);
  } catch (error) {
    if (signal.aborted) throw new ImageGenerationError('cancelled');
    if (error instanceof ImageGenerationError) throw error;
    if (timeout.aborted) throw new ImageGenerationError('timedOut');
    throw new ImageGenerationError('networkFailed');
  }
}

export function resumeReferenceImage(
  config: ImageConfig,
  taskId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onProgress?: (progress: ImageGenerationProgress) => void,
): Promise<string> {
  const valid = normalizeImageConfig(config);
  return readCanvasProTask(
    valid.model,
    valid.apiKey,
    taskId,
    AbortSignal.any([signal, AbortSignal.timeout(1_800_000)]),
    fetcher,
    onProgress,
    true,
  );
}
