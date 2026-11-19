const maxReferenceBytes = 128 * 1024;

// Keep image-only requests small enough for the API connection, preserving the
// original aspect ratio and leaving the selected and downloadable files intact.
export async function prepareCanvasProReference(original: File): Promise<File> {
  if (original.size <= maxReferenceBytes || typeof createImageBitmap === 'undefined')
    return original;
  const image = await createImageBitmap(original);
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw Error('Image canvas is unavailable');
    const longest = Math.max(image.width, image.height);
    for (const dimension of [1536, 1280, 1024, 768, 512, 384]) {
      const scale = Math.min(1, dimension / longest);
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.76, 0.64]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/webp', quality),
        );
        if (blob?.type === 'image/webp' && blob.size <= maxReferenceBytes) {
          return new File([blob], original.name.replace(/\.[^.]+$/, '') + '.webp', {
            type: blob.type,
          });
        }
      }
    }
  } finally {
    image.close();
  }
  throw Error('Could not prepare a compact reference image');
}
